import type { InputPresentation } from '@agnes/protocol'
import type { Translate } from '../locales/index.js'

/** Typed backend presentation only. Machine input remains available in the execution trace. */
export function inputPresentationText(
  presentation: InputPresentation | undefined,
  t: Translate,
): string | undefined {
  if (!presentation) return undefined
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
