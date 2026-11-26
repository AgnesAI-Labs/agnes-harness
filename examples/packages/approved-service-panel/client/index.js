import { useDocumentLanguage } from '@agnes/web-ui'
import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react'

function ServiceVersion({ ctx }) {
  const language = useDocumentLanguage()
  const text = (en, zh) => (language === 'zh-CN' ? zh : en)
  const title = text('Service version', '服务版本')
  const readiness = useSyncExternalStore(ctx.session.readiness.subscribe, ctx.session.readiness.getSnapshot)
  const binding = useSyncExternalStore(ctx.availability.subscribe, ctx.availability.getSnapshot)
  const [result, setResult] = useState()

  useEffect(() => {
    if (readiness.status !== 'ready' || binding?.availability !== 'active') return
    let live = true
    const current = () =>
      live && ctx.session.readiness.getSnapshot() === readiness && ctx.availability.getSnapshot() === binding
    if (!current()) return
    const publish = (version) => {
      if (current()) setResult({ readiness, binding, version })
    }
    void ctx.agnes.services.call('approved.panel.version', {}).then(
      (output) => publish(typeof output?.version === 'string' ? output.version : null),
      () => publish(null),
    )
    return () => {
      live = false
    }
  }, [ctx, readiness, binding])

  if (binding?.availability !== 'active') return null
  let status
  if (readiness.status === 'no-session')
    status = text('Open a session to read the version.', '打开会话后可读取版本。')
  else if (readiness.status === 'connecting') status = text('Waiting for the session…', '正在等待会话…')
  else if (readiness.status !== 'ready') status = text('Service unavailable.', '服务不可用。')
  else if (result?.readiness !== readiness || result.binding !== binding)
    status = text('Reading the backend version…', '正在读取后端版本…')
  else
    status =
      result.version === null ? text('Service unavailable.', '服务不可用。') : `backend ${result.version}`
  return h('section', { 'aria-label': title }, h('h2', null, title), h('p', { role: 'status' }, status))
}

export function apply(ctx) {
  ctx.homeEntries.register({
    id: 'service-version',
    icon: 'plugin',
    titleKey: 'Service version',
    order: 0,
    placement: 'secondary',
    component: () => h(ServiceVersion, { ctx }),
  })
}
