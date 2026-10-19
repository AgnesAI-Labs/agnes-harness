import { browserViews } from '@agnes/web-client'
import { Button, EmptyState, StatusMessage } from '@agnes/web-ui'
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'

export function BrowserPanel({ ctx }) {
  const sessionId = useSyncExternalStore(ctx.session.subscribe, ctx.session.getSnapshot)
  useSyncExternalStore(browserViews.subscribe, browserViews.getSnapshot)
  const source = browserViews.entries()[0]
  const [view, setView] = useState({ state: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const [actualSize, setActualSize] = useState(false)
  const canvas = useRef(null)
  const zh = ctx.locale.locale === 'zh-CN'
  // biome-ignore lint/correctness/useExhaustiveDependencies: the retry button explicitly replaces the connection lifetime.
  useEffect(() => {
    const lifetime = new AbortController()
    let stream,
      timer,
      latest,
      generation = 0,
      drawing = false,
      failures = 0
    setView({ state: 'idle', sessionId })
    const draw = async () => {
      if (drawing || lifetime.signal.aborted) return
      drawing = true
      try {
        while (latest && !lifetime.signal.aborted) {
          const data = latest
          latest = undefined
          const binary = data instanceof Uint8Array
          const image = binary
            ? await createImageBitmap(new Blob([data], { type: 'image/jpeg' }))
            : new Image()
          try {
            if (!binary) {
              image.src = `data:image/jpeg;base64,${data}`
              await image.decode()
            }
            if (lifetime.signal.aborted) break
            const target = canvas.current
            if (target) {
              const width = binary ? image.width : image.naturalWidth
              const height = binary ? image.height : image.naturalHeight
              if (target.width !== width) target.width = width
              if (target.height !== height) target.height = height
              target.getContext('2d')?.drawImage(image, 0, 0)
              setView((old) =>
                old.state === 'ready' && !old.error ? old : { ...old, state: 'ready', error: undefined },
              )
            }
          } finally {
            if (binary) image.close()
          }
        }
      } catch {
        if (!lifetime.signal.aborted)
          setView((old) => ({
            ...old,
            error: zh ? '画面解码失败，请重试。' : 'Could not decode the browser frame. Retry.',
          }))
      } finally {
        drawing = false
      }
    }
    const schedule = (ms) => {
      clearTimeout(timer)
      timer = setTimeout(connect, ms)
    }
    const reconnect = (error) => {
      if (lifetime.signal.aborted || document.hidden) return
      failures++
      setView((old) => ({
        ...old,
        state: 'error',
        error:
          failures > 4
            ? zh
              ? '自动重连已暂停，请点击重试。'
              : 'Automatic reconnect paused. Click Retry.'
            : error,
      }))
      // A broken stream must not hammer the shared admission budget (10 opens/minute).
      if (failures <= 4) schedule(Math.min(30000, 5000 * 2 ** (failures - 1)))
    }
    async function connect() {
      if (!source || !sessionId || lifetime.signal.aborted || document.hidden) return
      const current = ++generation
      try {
        const status = await source.observe(sessionId)
        if (lifetime.signal.aborted || current !== generation || document.hidden) return
        setView({ ...status, sessionId, state: status.state === 'ready' ? 'connecting' : status.state })
        if (status.state !== 'ready' || !status.ticket) {
          schedule(1200)
          return
        }
        const next = await source.watch(status.ticket, lifetime.signal)
        if (lifetime.signal.aborted || current !== generation || document.hidden) {
          next.close('viewer-closed')
          return
        }
        stream = next
        const connectedAt = Date.now()
        next.onFrame((frame) => {
          if (lifetime.signal.aborted || stream !== next || !frame || typeof frame !== 'object') return
          if (frame instanceof Uint8Array || (frame.type === 'frame' && typeof frame.data === 'string')) {
            latest = frame instanceof Uint8Array ? frame : frame.data
            void draw()
          } else if (frame.type === 'url' && typeof frame.url === 'string')
            setView((old) => ({ ...old, url: frame.url }))
        })
        next.onDisconnect(() => {
          if (lifetime.signal.aborted || stream !== next) return
          stream = undefined
          if (Date.now() - connectedAt >= 20000) {
            failures = 0
            schedule(1000)
          } else {
            reconnect(
              zh
                ? '浏览器画面连接中断，正在延迟重试；也可手动重试。'
                : 'Browser stream disconnected. Retrying with backoff; you can also retry manually.',
            )
          }
        })
      } catch (error) {
        if (!lifetime.signal.aborted && current === generation) reconnect(error.message)
      }
    }
    const visibility = () => {
      generation++
      clearTimeout(timer)
      const previous = stream
      stream = undefined
      previous?.close('viewer-hidden')
      if (!document.hidden) void connect()
    }
    document.addEventListener('visibilitychange', visibility)
    void connect()
    return () => {
      lifetime.abort()
      clearTimeout(timer)
      stream?.close('viewer-closed')
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [source, sessionId, attempt, zh])
  const state = view.sessionId === sessionId ? view : { state: 'idle' }
  if (!sessionId || !source)
    return h(EmptyState, {
      title: zh ? '独立浏览器尚未就绪' : 'Browser is not ready',
      description: zh
        ? '启用内置浏览器运行时，然后打开一个会话。'
        : 'Enable the browser runtime and open a conversation.',
    })
  return h(
    'div',
    { className: 'agh-browser-panel', 'data-testid': 'browser-panel' },
    h(
      'div',
      { className: 'agh-browser-toolbar' },
      h('span', null, zh ? 'AGH 独立浏览器 · 仅观看' : 'AGH independent browser · View only'),
      h(
        Button,
        {
          size: 'small',
          appearance: 'ghost',
          onClick: () => setActualSize(!actualSize),
          'aria-pressed': actualSize,
        },
        actualSize ? (zh ? '适应面板' : 'Fit') : zh ? '原始大小' : 'Actual size',
      ),
    ),
    state.url && h('div', { className: 'agh-browser-address', title: state.url }, state.url),
    state.error &&
      h(
        StatusMessage,
        {
          kind: 'error',
          action: { label: zh ? '重试' : 'Retry', onSelect: () => setAttempt((value) => value + 1) },
        },
        state.error,
      ),
    state.state === 'idle' &&
      h(EmptyState, {
        title: zh ? '浏览器按需启动' : 'Browser starts when needed',
        description: zh
          ? '对 AGH 说“打开浏览器，看看百度热搜”，这里就会显示它正在操作的页面。'
          : 'Ask AGH to open a website. Its live browser will appear here.',
      }),
    ['starting', 'connecting'].includes(state.state) &&
      h(StatusMessage, { kind: 'pending' }, zh ? '正在连接独立浏览器…' : 'Connecting to the browser…'),
    h(
      'div',
      { className: 'agh-browser-viewport', hidden: state.state === 'idle' },
      h('canvas', {
        key: sessionId,
        ref: canvas,
        width: 1280,
        height: 800,
        className: 'agh-browser-canvas',
        'data-actual-size': actualSize,
        role: 'img',
        'aria-label': zh
          ? 'Agent 正在操作的浏览器实时画面'
          : 'Live view of the browser operated by the agent',
      }),
    ),
  )
}

// Compatibility viewer for older browser-runtime releases. New runtimes own the panel.
export function apply(ctx) {
  return ctx.presentationRoles.register({
    role: 'browser-viewer',
    priority: 100,
    mount: (mounted) => {
      let stopPanel
      const reconcile = () => {
        if (browserViews.entries().length && !stopPanel) {
          stopPanel = mounted.workbenchPanels.register({
            id: 'browser',
            order: 56,
            edge: 'right',
            restoreOpen: false,
            titleKey: 'browser.title',
            title: () => (mounted.locale.locale === 'zh-CN' ? '浏览器' : 'Browser'),
            component: () => h(BrowserPanel, { ctx: mounted }),
          })
        } else if (!browserViews.entries().length && stopPanel) {
          stopPanel()
          stopPanel = undefined
        }
      }
      const unsubscribe = browserViews.subscribe(reconcile)
      reconcile()
      return () => {
        unsubscribe()
        stopPanel?.()
      }
    },
  })
}
