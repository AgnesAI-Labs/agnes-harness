import type { SystemInput } from '@agnes/protocol'
import type { Translate } from '../locales/index.js'

/** Typed backend presentation only. Machine input remains available in the execution trace. */
export function systemInputText(system: SystemInput | undefined, t: Translate): string | undefined {
  if (!system) return undefined
  // An instruction addressed to the loop, not to the reader: say what is happening instead.
  if (system.source === 'agnes/deferred-invocations' && system.type === 'invocation-queued')
    return t('timeline.deferredQueued')
  const presentation = system.presentation
  if (!presentation) {
    if (system.source === 'agnes/child' && system.type === 'child-batch-completed') {
      const data =
        system.data && typeof system.data === 'object' && !Array.isArray(system.data)
          ? system.data
          : undefined
      const children = Array.isArray(data?.children) ? data.children : []
      const statuses = children.map((child) =>
        child && typeof child === 'object' && !Array.isArray(child) && typeof child.status === 'string'
          ? child.status
          : 'completed',
      )
      const status = statuses.includes('failed')
        ? 'failed'
        : statuses.includes('budget_stopped')
          ? 'budget_stopped'
          : statuses.length > 0 && statuses.every((item) => item === 'cancelled')
            ? 'cancelled'
            : 'completed'
      const label =
        children.length > 0
          ? children
              .map((child) => {
                const key =
                  child &&
                  typeof child === 'object' &&
                  !Array.isArray(child) &&
                  typeof child.childKey === 'string'
                    ? child.childKey
                    : ''
                return key ? key.slice(-6) : ''
              })
              .filter(Boolean)
              .join(' / ') || String(children.length)
          : system.type
      return t(`timeline.childCompleted.${status}`, { label })
    }
    if (system.source === 'agnes/child' && system.type === 'child-state') {
      const data =
        system.data && typeof system.data === 'object' && !Array.isArray(system.data)
          ? system.data
          : undefined
      const childKey = typeof data?.childKey === 'string' ? data.childKey.slice(-6) : ''
      const state = typeof data?.state === 'string' ? data.state : ''
      return [childKey, state].filter(Boolean).join(' · ') || system.type
    }
    return system.summary
  }
  if (presentation.kind === 'child-completed') {
    const data = system.data
    const role = data && typeof data === 'object' && !Array.isArray(data) ? data.role : undefined
    const label = role ? t('timeline.handledBy', { role: presentation.label }) : presentation.label
    return t(`timeline.childCompleted.${presentation.status}`, { label })
  }
  if (presentation.status !== 'succeeded')
    return t(`timeline.uiAction.${presentation.status}`, { label: presentation.label })
  if (presentation.operation === 'submit')
    return t('timeline.uiAction.submitted', {
      fields: presentation.fields.length
        ? presentation.fields.join(t('timeline.uiAction.separator'))
        : presentation.label,
    })
  return t('timeline.uiAction.completed', { label: presentation.label })
}
