window.__ModuleLoader__.load({
  id: 'dsh-screenshot',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-screenshot'
    const CAPTURE_PATH = '/dsh-screenshot/capture'
    const SLOT = 'conversation.composer.dock'

    const MESSAGES = {
      zh: {
        label: '截图',
        busy: '截图中',
        selectHint: '拖动框选要截的区域 · 右键或 Esc 取消',
        hint: '点一下：DSH 窗口收起后拖动框选区域；按住 Alt 点：直接截整屏。图片直接进输入框',
        failed: '截图失败',
        busyInput: '输入框正忙，截图没放进去',
        unsupported: '当前会话还不支持放图片',
      },
      en: {
        label: 'Shot',
        busy: 'Capturing',
        selectHint: 'Drag to select an area · right-click or Esc to cancel',
        hint: 'Click: the DSH window hides, drag a rectangle. Alt+click: grab the whole screen. The PNG lands in the composer',
        failed: 'Capture failed',
        busyInput: 'Composer is busy, the shot was not attached',
        unsupported: 'This session cannot take images',
      },
    }

    const STYLE_ID = 'dsh-screenshot-styles'
    const CSS = `
.dshshot-root{display:inline-flex;align-items:center;gap:8px;min-width:0}
.dshshot-button{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;margin:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;font-weight:500;line-height:1;cursor:pointer;transition:color .12s ease,background-color .12s ease}
.dshshot-button:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dshshot-button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-pressed,rgba(127,127,127,.2))}
.dshshot-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshshot-button:disabled{cursor:default;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));opacity:.75}
.dshshot-spin{animation:dshshot-spin .9s linear infinite;transform-origin:center}
.dshshot-error{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:16px}
@keyframes dshshot-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
`

    /**
     * Every origin this page could reach the Host half through.
     * @returns absolute or same-origin capture URL.
     */
    function captureUrl() {
      const origin = typeof location === 'object' && location !== null ? String(location.origin ?? '') : ''
      if (origin.startsWith('http://') || origin.startsWith('https://')) return origin + CAPTURE_PATH
      // Desktop shells can serve the page off file://; the boot payload carries the Host URL.
      try {
        const text = JSON.stringify(window.__DSH_BOOT__ ?? null)
        const match = text.match(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}/u)
        if (match !== null) return match[0] + CAPTURE_PATH
      } catch {
        // ignored: fall back to a same-origin path below
      }
      return CAPTURE_PATH
    }

    /**
     * The scope-addressed conversation service, which owns browser draft
     * attachments. Cordis derives its key from the ConversationController class.
     */
    function readConversation(ctx) {
      for (const key of ['conversation', 'ConversationController']) {
        const service = ctx.get(key)
        if (service !== undefined) return service
      }
      return undefined
    }

    /** Read the translate function and re-render on locale changes. */
    function useTranslate(ctx) {
      const locale = ctx.get('locale')
      const [revision, setRevision] = React.useState(0)
      React.useEffect(() => {
        if (locale === undefined) return undefined
        return locale.subscribe(() => setRevision((value) => value + 1))
      }, [locale])
      return React.useCallback((key) => {
        const fallback = MESSAGES.en[key] ?? key
        if (locale === undefined) return fallback
        try {
          return locale.bind(NS)(key)
        } catch {
          return fallback
        }
      }, [locale, revision])
    }

    /** One camera glyph; a spinner replaces it while a capture runs. */
    function CameraIcon(props) {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.2,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        className: props.className, 'aria-hidden': true,
      },
        h('path', { d: 'M2.2 5.2h1.9l.9-1.3h3.9l.9 1.3h1.9a.9.9 0 0 1 .9.9v5.1a.9.9 0 0 1-.9.9H2.2a.9.9 0 0 1-.9-.9V6.1a.9.9 0 0 1 .9-.9Z' }),
        h('circle', { cx: 7.1, cy: 8.6, r: 1.85 }),
      )
    }

    function SpinnerIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        className: 'dshshot-spin', 'aria-hidden': true,
      }, h('path', { d: 'M8 1.8a6.2 6.2 0 1 1-4.4 1.8' }))
    }

    /**
     * Composer dock control: capture the screen and stage the image as a draft.
     * @param props - slot props plus the owning plugin context.
     */
    function ScreenshotButton(props) {
      const { ctx, sessionId, inputActions } = props
      const t = useTranslate(ctx)
      const [pending, setPending] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const mounted = React.useRef(true)

      React.useEffect(() => () => { mounted.current = false }, [])

      const available = typeof sessionId === 'string' && inputActions !== undefined
        && typeof inputActions.addAttachments === 'function'

      const run = async (event) => {
        if (pending) return
        const mode = event !== null && event !== undefined && event.altKey === true ? 'full' : 'region'
        setFailure('')
        if (!available) {
          setFailure(t('unsupported'))
          return
        }
        setPending(true)
        try {
          const response = await fetch(captureUrl(), {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode, hint: t('selectHint') }),
          })
          if (response.status === 409) return
          if (!response.ok) {
            let detail = `HTTP ${response.status}`
            try {
              const body = await response.json()
              if (body && typeof body.message === 'string') detail = body.message
            } catch {
              // response was not JSON
            }
            throw new Error(detail)
          }
          const blob = await response.blob()
          const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
          const file = new File([blob], `screen-${stamp}.png`, { type: 'image/png' })
          const conversation = readConversation(ctx)
          if (conversation === undefined || typeof conversation.createDrafts !== 'function') {
            throw new Error(t('unsupported'))
          }
          const drafts = conversation.createDrafts(sessionId, [file])
          const accepted = inputActions.addAttachments(drafts.map((draft) => draft.id))
          if (accepted !== true) {
            conversation.releaseDraftAttachments(drafts)
            throw new Error(t('busyInput'))
          }
        } catch (error) {
          if (!mounted.current) return
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          if (mounted.current) setPending(false)
        }
      }

      return h('div', { className: 'dshshot-root', 'data-dsh-screenshot': true },
        h('style', { 'data-plugin-css': STYLE_ID }, CSS),
        h('button', {
          type: 'button',
          className: 'dshshot-button',
          title: `${t('hint')}${failure === '' ? '' : `\n${failure}`}`,
          disabled: pending,
          'aria-busy': pending,
          onClick: run,
        },
          pending ? h(SpinnerIcon, null) : h(CameraIcon, null),
          h('span', null, pending ? t('busy') : t('label')),
        ),
        failure === '' ? null : h('span', { className: 'dshshot-error', title: failure }, t('failed') + ': ' + failure),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale')
        if (locale !== undefined && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, MESSAGES), 'dsh-screenshot: locale dictionaries')
        }
        ctx.effect(() => ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: 'dsh-screenshot',
          order: 20,
        }, (props) => h(ScreenshotButton, { ...props, ctx }))), 'dsh-screenshot: composer dock entry')
      },
    }
  },
})
