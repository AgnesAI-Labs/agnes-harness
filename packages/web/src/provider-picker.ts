import { createSelectPicker, type SelectPicker } from '@agnes/web-ui'
import type { Translate } from './presentation.js'

export function createProviderPicker(select: HTMLSelectElement, t: Translate): SelectPicker {
  return createSelectPicker(select, {
    label: t('settings.provider.label'),
    includeEmpty: false,
    formatOption: (label) => label.replace(t('settings.provider.subscriptionLoginSuffix'), ''),
  })
}

export function createAccountPickers(
  ui: {
    provider: HTMLSelectElement
    authMethod: HTMLSelectElement
    models: HTMLSelectElement
    thinking?: HTMLSelectElement | undefined
  },
  t: Translate,
): Pick<SelectPicker, 'sync' | 'close'> {
  const pickers = [
    createProviderPicker(ui.provider, t),
    createSelectPicker(ui.authMethod, { label: t('settings.oauth.methodLabel') }),
    createSelectPicker(ui.models, { label: t('accounts.defaultModelLabel') }),
    ...(ui.thinking ? [createSelectPicker(ui.thinking, { label: t('settings.model.thinkingLabel') })] : []),
  ]
  return {
    sync: () => {
      for (const picker of pickers) picker.sync()
    },
    close: () => {
      for (const picker of pickers) picker.close()
    },
  }
}
