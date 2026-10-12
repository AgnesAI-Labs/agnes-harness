import type { SystemInput } from '@agnes/protocol'
import type { Translate } from '../locales/index.js'

/** Typed backend presentation only. Machine input remains available in the execution trace. */
export function systemInputText(system: SystemInput | undefined, t: Translate): string | undefined {
  if (!system) return undefined
  const presentation = system.presentation
  if (!presentation) return system.summary
  if (presentation.kind === 'child-completed')
    return t(`timeline.childCompleted.${presentation.status}`, { label: presentation.label })
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
