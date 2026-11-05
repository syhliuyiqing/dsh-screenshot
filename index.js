/**
 * Host half of dsh-screenshot.
 *
 * Serves one authenticated route that hides the DSH window, grabs the desktop
 * through PowerShell, optionally lets the user drag a rectangle, and answers
 * with PNG bytes. The Client half puts those bytes into the composer as a
 * draft attachment.
 *
 * The PowerShell run goes through the Host's `subprocess` service: the provider
 * owns executable resolution, stdio and teardown, so this package never holds a
 * raw process capability of its own.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Exact route the Client half posts to. */
const CAPTURE_PATH = '/dsh-screenshot/capture'

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'capture.ps1')

/** Scratch directory for temporary captures and the failure log. */
const WORK_DIR = join(tmpdir(), 'dsh-screenshot')
const LOG_PATH = join(WORK_DIR, 'last-error.log')

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
 * Shell candidates, most preferred first. The absolute Windows PowerShell path
 * comes first because a provider's scrubbed PATH need not contain it.
 * @returns candidate executables.
 */
function shellCandidates() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  return [
    process.env.DSH_POWERSHELL,
    join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'pwsh.exe',
    'powershell.exe',
  ].filter((value) => typeof value === 'string' && value.length > 0)
}

/**
 * Register the capture route.
 * @param ctx - plugin context.
 * @param config - optional overrides of DEFAULTS.
 */
export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  let tail = Promise.resolve()
  let shell

  /**
   * The managed subprocess provider, resolved lazily so a profile without one
   * fails with a readable reason instead of an empty button.
   * @returns the provider.
   */
  const provider = () => {
    const service = ctx.get('subprocess')
    if (service === undefined) {
      throw new Error('this profile mounts no subprocess provider, so PowerShell cannot be started')
    }
    return service
  }

  /**
   * Resolve one PowerShell executable in the provider's execution world.
   * @returns absolute executable path.
   */
  const resolveShell = async () => {
    if (shell !== undefined) return shell
    const attempts = []
    for (const candidate of shellCandidates()) {
      try {
        shell = await provider().resolveExecutable(candidate)
        return shell
      } catch (error) {
        attempts.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // Last resort: an absolute interpreter we can see on disk, used unverified.
    const fallback = shellCandidates().find((candidate) => candidate.includes('\\') && existsSync(candidate))
    if (fallback !== undefined) {
      shell = fallback
      return shell
    }
    throw new Error(`PowerShell was not found. Tried: ${attempts.join(' | ')}`)
  }

  /** Serialize captures so two requests never fight over the minimized window. */
  const capture = (request) => {
    const current = tail
      .then(() => captureScreen(ctx, provider, resolveShell, options, request))
      .catch(async (error) => {
        await logFailure(error)
        throw error
      })
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
 * Append one line to the scratch failure log. Never throws.
 * @param error - failure or note.
 * @param stage - where it happened.
 */
async function logFailure(error, stage = 'capture') {
  const message = error instanceof Error ? `${error.message}${error.code ? ` [${error.code}]` : ''}` : String(error)
  const line = `${new Date().toISOString()} ${stage} pid=${process.pid} platform=${process.platform}: ${message}\n`
  try {
    await mkdir(WORK_DIR, { recursive: true })
    await writeFile(LOG_PATH, line, { flag: 'a' })
  } catch {
    // diagnostics are best-effort
  }
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
 * @param ctx - plugin context.
 * @param provider - subprocess provider accessor.
 * @param resolveShell - cached PowerShell lookup.
 * @param options - resolved options.
 * @param request - capture mode and overlay hint.
 * @returns PNG bytes.
 */
async function captureScreen(ctx, provider, resolveShell, options, request) {
  if (process.platform !== 'win32') {
    throw new Error('screen capture is implemented for Windows only')
  }
  await mkdir(WORK_DIR, { recursive: true })
  const directory = await mkdtemp(join(WORK_DIR, 'run-'))
  const target = join(directory, 'capture.png')
  try {
    const shell = await resolveShell()
    await runPowerShell(provider(), shell, [
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

/**
 * Run the capture script through the managed subprocess provider.
 * @param provider - subprocess provider.
 * @param shell - absolute PowerShell path.
 * @param args - script arguments.
 * @param timeoutMs - upper bound. A timed-out run keeps going on purpose: the
 * script restores the minimized window in its own finally block, and killing it
 * would strand the window off screen.
 */
async function runPowerShell(provider, shell, args, timeoutMs) {
  const handle = provider.spawn({
    argv: [
      shell,
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH,
      ...args,
    ],
    cwd: dirname(SCRIPT_PATH),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 65536 },
      stderr: { maxBytes: 65536 },
    },
    graceMs: 3000,
  })

  // A race loser must not surface as an unhandled rejection.
  const outcome = handle.done.catch((error) => ({
    exitCode: null,
    signal: null,
    failure: error instanceof Error ? error.message : String(error),
  }))

  let timer
  const expired = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(undefined), timeoutMs)
    timer.unref?.()
  })

  let settled
  try {
    settled = await Promise.race([outcome, expired])
  } finally {
    clearTimeout(timer)
  }

  if (settled === undefined) throw new Error(`capture did not finish within ${timeoutMs}ms`)

  const stderr = readCollected(handle, 'stderr')
  if (settled.exitCode === 0) return
  if (settled.exitCode === 2) {
    const cancelled = new Error('capture cancelled')
    cancelled.code = 'cancelled'
    throw cancelled
  }
  const reason = settled.failure ?? stderr.trim().slice(0, 600)
  throw new Error(`PowerShell exited with ${String(settled.exitCode)}: ${reason}`)
}

/**
 * Read one collected stream without consuming it.
 * @param handle - subprocess handle.
 * @param channel - collected channel name.
 * @returns decoded text, or an empty string when unavailable.
 */
function readCollected(handle, channel) {
  try {
    return handle.collected?.[channel]?.readFrom(0).text ?? ''
  } catch {
    return ''
  }
}
