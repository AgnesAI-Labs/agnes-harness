import { Button, IntelligentSurface, StatusMessage } from '@agnes/web-ui'
import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'

/** Complete interaction view using the public recorded surface/action protocol. */
export function InteractionView({ ctx }) {
  const readiness = useSyncExternalStore(ctx.session.readiness.subscribe, ctx.session.readiness.getSnapshot)
  const [data, setData] = useState()
  const [error, setError] = useState('')
  const [version, refresh] = useState(0)
  useEffect(() => ctx.session.projection.subscribe(() => refresh((n) => n + 1)), [ctx])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh and session events must re-read recorded facts.
  useEffect(() => {
    let live = true
    setData(undefined)
    if (!['ready', 'history-only'].includes(readiness.status))
      return () => {
        live = false
      }
    const session = ctx.agnes.sessions.get(readiness.sessionId)
    void session.uiRead().then(
      (value) => {
        if (live && ctx.session.readiness.getSnapshot() === readiness) setData(value)
      },
      () => {
        if (live)
          setError(ctx.locale.locale === 'zh-CN' ? '交互卡片读取失败' : 'Could not read interaction cards')
      },
    )
    return () => {
      live = false
    }
  }, [ctx, readiness, version])
  return h(
    'section',
    { 'aria-label': ctx.locale.locale === 'zh-CN' ? '交互卡片' : 'Interaction cards' },
    error && h(StatusMessage, { kind: 'error' }, error),
    h(Button, { onClick: () => refresh((n) => n + 1) }, ctx.locale.locale === 'zh-CN' ? '刷新' : 'Refresh'),
    ...(data?.surfaces ?? []).map((record) =>
      h(Surface, {
        key: `${readiness.epoch}:${record.surface.id}:${record.surface.revision}`,
        ctx,
        readiness,
        record,
        receipts: data.actions,
        refresh: () => refresh((n) => n + 1),
      }),
    ),
  )
}
function Surface({ ctx, readiness, record, receipts, refresh }) {
  const [input, setInput] = useState({})
  const [selection, setSelection] = useState({})
  const [confirmation, setConfirmation] = useState()
  const [pending, setPending] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [error, setError] = useState('')
  const [command, setCommand] = useState()
  async function submit(action, confirmed = false, retry) {
    if (pending || readiness.status !== 'ready' || ctx.session.readiness.getSnapshot() !== readiness) return
    const request = retry ?? {
      surfaceId: record.surface.id,
      revision: record.surface.revision,
      actionId: action.id,
      commandId: crypto.randomUUID(),
      input,
      selection,
      confirmed,
    }
    setCommand(request)
    setPending(true)
    try {
      await ctx.agnes.sessions.get(readiness.sessionId).uiAction(request)
      refresh()
    } catch {
      setError(
        ctx.locale.locale === 'zh-CN'
          ? '读取回执后再重试；重用同一命令。'
          : 'Read the receipt before retrying; reuse the same command.',
      )
    } finally {
      setPending(false)
      setConfirmation(undefined)
    }
  }
  return h(IntelligentSurface, {
    record,
    placement: 'workbench',
    input,
    selection,
    receipts: receipts.filter((r) => r.surfaceId === record.surface.id),
    locked: readiness.status !== 'ready' || record.status === 'closed',
    invalid,
    needsReview: false,
    draftChanged: false,
    transportPending: pending,
    error,
    confirmation,
    onInput: (key, value) => setInput((old) => ({ ...old, [key]: value })),
    onSelection: (key, value) => setSelection((old) => ({ ...old, [key]: value })),
    onInvalid: (_, value) => setInvalid(value),
    onAction: (action) =>
      action.confirm ? setConfirmation({ action, revision: record.surface.revision }) : submit(action),
    onConfirm: () => confirmation && submit(confirmation.action, true),
    onCancel: () => setConfirmation(undefined),
    onRetry: () => command && submit(undefined, false, command),
    onReview: refresh,
    onRecover: refresh,
    onExpand() {},
    onApproval: () => ctx.presentation.focusApproval?.(),
    onRefreshSource: async () => {
      await ctx.agnes.sessions.get(readiness.sessionId).uiRefresh({ surfaceId: record.surface.id })
      refresh()
    },
  })
}
export function apply(ctx) {
  return ctx.presentationRoles.register({
    role: 'interaction',
    priority: 0,
    mount(child) {
      const component = () => h(InteractionView, { ctx: child })
      const off = [
        child.slots.register('conversation.view', component),
        child.workbenchPanels.register({
          id: 'example-interactions',
          edge: 'right',
          order: 60,
          titleKey: 'ui.example.interactions',
          component,
        }),
        child.locale.register('example.interaction', {
          en: { 'ui.example.interactions': 'Interactions' },
          'zh-CN': { 'ui.example.interactions': '交互卡片' },
        }),
      ]
      return () => {
        for (const stop of off.reverse()) stop()
      }
    },
  })
}
