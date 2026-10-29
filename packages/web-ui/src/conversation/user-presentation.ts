import type { SystemInput } from '@agnes/protocol'
import type { Translate } from '../locales/index.js'

/** Typed backend presentation only. Machine input remains available in the execution trace. */
export function systemInputText(system: SystemInput | undefined, t: Translate): string | undefined {
  if (!system) return undefined
  // An instruction addressed to the loop, not to the reader: say what is happening instead.
  if (system.source === 'agnes/deferred-invocations' && system.type === 'invocation-queued')
    return t('timeline.deferredQueued')
  const presentation = system.presentation
  if (!presentation) return system.summary
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
