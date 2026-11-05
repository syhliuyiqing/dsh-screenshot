/**
 * Host half of dsh-screenshot.
 *
 * Serves one authenticated route that hides the DSH window, grabs the desktop
 * through PowerShell, optionally lets the user drag a rectangle, and answers
 * with PNG bytes. The Client half puts those bytes into the composer as a
 * draft attachment.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Exact route the Client half posts to. */
const CAPTURE_PATH = '/dsh-screenshot/capture'

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'capture.ps1')

const DEFAULTS = {
  /** Longest edge of the produced PNG; larger results are scaled down. */
  maxWidth: 1920,
  /** Time to let the window manager finish hiding the window before the grab. */
  settleMs: 650,
  /** Hide the window that owns this Host process while capturing. */
  hideWindow: true,
  /** Upper bound for one PowerShell run; the window is restored by the script itself. */
  timeoutMs: 180000,
}

export const inject = ['webServer', 'connection']

/**
 * Register the capture route.
 * @param ctx - plugin context.
 * @param config - optional overrides of DEFAULTS.
 */
export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  let tail = Promise.resolve()

  /** Serialize captures so two requests never fight over the minimized window. */
  const capture = (request) => {
    const current = tail.then(() => captureScreen(options, request))
    tail = current.catch(() => undefined)
    return current
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CAPTURE_PATH,
    handler: (req, res) => handle(ctx, capture, req, res),
  }), 'dsh-screenshot: capture route')
}

/**
 * Answer one capture request.
 * @param ctx - plugin context.
 * @param capture - serialized capture operation.
 * @param req - incoming request.
 * @param res - owned response.
 */
async function handle(ctx, capture, req, res) {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    res.writeHead(rejection, { 'cache-control': 'no-store' })
    res.end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'cache-control': 'no-store' })
    res.end()
    return
  }
  try {
    const request = await readRequest(req)
    const png = await capture(request)
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(png.length),
      'cache-control': 'no-store',
    })
    res.end(png)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const cancelled = error instanceof Error && error.code === 'cancelled'
    res.writeHead(cancelled ? 409 : 500, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify({ code: cancelled ? 'cancelled' : 'capture-failed', message }))
  }
}

/**
 * Read the optional Client preferences from the request body.
 * @param req - incoming request.
 * @returns capture mode and overlay hint text.
 */
async function readRequest(req) {
  const empty = { mode: 'region', hint: '' }
  try {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 8192) break
      chunks.push(chunk)
    }
    if (chunks.length === 0) return empty
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const mode = parsed?.mode === 'full' ? 'full' : 'region'
    const hint = typeof parsed?.hint === 'string' ? parsed.hint.trim().slice(0, 160) : ''
    return { mode, hint }
  } catch {
    return empty
  }
}

/**
 * Produce one PNG of the desktop or of a user-selected rectangle.
 * @param options - resolved options.
 * @param request - capture mode and overlay hint.
 * @returns PNG bytes.
 */
async function captureScreen(options, request) {
  if (process.platform !== 'win32') {
    throw new Error('screen capture is implemented for Windows only')
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-screenshot-'))
  const target = join(directory, 'capture.png')
  try {
    await runPowerShell(SCRIPT_PATH, [
      '-OutFile', target,
      '-WindowPid', String(process.pid),
      '-MaxWidth', String(options.maxWidth),
      '-SettleMs', String(options.settleMs),
      '-HideWindow', options.hideWindow === false ? '0' : '1',
      '-Mode', request.mode === 'full' ? '0' : '1',
      '-Hint', request.hint,
    ], options.timeoutMs)
    const bytes = await readFile(target)
    if (bytes.length === 0) throw new Error('capture produced an empty image')
    return bytes
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}

let resolvedShell

/**
 * Find a PowerShell executable once per plugin lifetime.
 * @returns executable name or path.
 */
async function resolveShell() {
  if (resolvedShell !== undefined) return resolvedShell
  const candidates = [
    process.env.DSH_POWERSHELL,
    'pwsh.exe',
    'powershell.exe',
  ].filter((value) => typeof value === 'string' && value.length > 0)
  for (const candidate of candidates) {
    if (await canSpawn(candidate)) {
      resolvedShell = candidate
      return candidate
    }
  }
  throw new Error('PowerShell was not found; set DSH_POWERSHELL to its executable')
}

/**
 * Probe one executable.
 * @param executable - candidate command.
 * @returns whether it starts and exits cleanly.
 */
function canSpawn(executable) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      child.once('error', () => finish(false))
      child.once('exit', (code) => finish(code === 0))
    } catch {
      finish(false)
    }
  })
}

/**
 * Run the capture script.
 * @param script - absolute script path.
 * @param args - script arguments.
 * @param timeoutMs - upper bound; the process is left alive so it can restore the window.
 */
function runPowerShell(script, args, timeoutMs) {
  return resolveShell().then((shell) => new Promise((resolve, reject) => {
    const child = spawn(shell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      ...args,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

    let stderr = ''
    let settled = false
    let timer

    const settle = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    }

    timer = setTimeout(() => {
      settle(new Error(`capture did not finish within ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', () => undefined)
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8000) stderr += chunk.toString()
    })
    child.once('error', (error) => settle(error))
    child.once('exit', (code) => {
      if (code === 0) {
        settle(undefined)
        return
      }
      if (code === 2) {
        const cancelled = new Error('capture cancelled')
        cancelled.code = 'cancelled'
        settle(cancelled)
        return
      }
      settle(new Error(`PowerShell exited with ${String(code)}: ${stderr.trim().slice(0, 600)}`))
    })
  }))
}
