import { tr } from './locale-bridge.js'
import { createSelectPicker, type SelectPicker } from '@agnes/web-ui'

export function createProviderPicker(select: HTMLSelectElement): SelectPicker {
  return createSelectPicker(select, {
    label: 'Provider',
    includeEmpty: false,
    formatOption: (label) => label.replace(tr('settings.provider.subscriptionSuffix'), ''),
  })
}

export function createAccountPickers(ui: {
  provider: HTMLSelectElement
  authMethod: HTMLSelectElement
  models: HTMLSelectElement
}): Pick<SelectPicker, 'sync' | 'close'> {
  const pickers = [
    createProviderPicker(ui.provider),
    createSelectPicker(ui.authMethod, { label: tr('settings.oauth.methodLabel'), translate: tr }),
    createSelectPicker(ui.models, { label: tr('settings.modelPicker.default'), translate: tr }),
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
