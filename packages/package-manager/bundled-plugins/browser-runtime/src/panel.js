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
      drawing = false
    setView({ state: 'idle', sessionId })
    const draw = async () => {
      if (drawing || lifetime.signal.aborted) return
      drawing = true
      try {
        while (latest && !lifetime.signal.aborted) {
          const data = latest
          latest = undefined
          const image = new Image()
          image.src = `data:image/jpeg;base64,${data}`
          await image.decode()
          if (lifetime.signal.aborted) break
          const target = canvas.current
          if (target) {
            if (target.width !== image.naturalWidth) target.width = image.naturalWidth
            if (target.height !== image.naturalHeight) target.height = image.naturalHeight
            target.getContext('2d')?.drawImage(image, 0, 0)
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
    async function connect() {
      if (!source || !sessionId || lifetime.signal.aborted || document.hidden) return
      const current = ++generation
      try {
        const status = await source.observe(sessionId)
        if (lifetime.signal.aborted || current !== generation || document.hidden) return
        setView({ ...status, sessionId })
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
        next.onFrame((frame) => {
          if (lifetime.signal.aborted || stream !== next || !frame || typeof frame !== 'object') return
          if (frame.type === 'frame' && typeof frame.data === 'string') {
            latest = frame.data
            void draw()
          } else if (frame.type === 'url' && typeof frame.url === 'string')
            setView((old) => ({ ...old, url: frame.url }))
        })
        next.onDisconnect(({ reason }) => {
          if (lifetime.signal.aborted || stream !== next) return
          stream = undefined
          if (reason !== 'lease-expired') setView((old) => ({ ...old, state: 'connecting' }))
          schedule(reason === 'lease-expired' ? 0 : 1000)
        })
      } catch (error) {
        if (!lifetime.signal.aborted && current === generation)
          setView({ state: 'error', sessionId, error: error.message })
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
        ? '启用内置浏览器后，请新建会话。已有会话保留原来的工具版本。'
        : 'Enable the built-in browser, then start a new conversation. Existing conversations retain their tool versions.',
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
          ? '启用后请新建会话，对 AGH 说“用内置浏览器打开百度”或“启动项目并预览”。首次使用需要下载浏览器，完成后会显示实时画面。'
          : 'Start a new conversation and ask AGH to open a website or preview a local project. First use downloads the browser; its live view then appears here.',
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
