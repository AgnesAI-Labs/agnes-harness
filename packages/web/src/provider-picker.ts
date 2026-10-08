import { tr } from '@agnes/web-foundation/locale-bridge'
import { createSelectPicker, type SelectPicker } from '@agnes/web-ui'

export function createProviderPicker(select: HTMLSelectElement): SelectPicker {
  return createSelectPicker(select, {
    label: tr('settings.provider.label'),
    includeEmpty: false,
    formatOption: (label) => label.replace(tr('settings.provider.subscriptionLoginSuffix'), ''),
  })
}

export function createAccountPickers(ui: {
  provider: HTMLSelectElement
  authMethod: HTMLSelectElement
  models: HTMLSelectElement
  thinking?: HTMLSelectElement | undefined
}): Pick<SelectPicker, 'sync' | 'close'> {
  const pickers = [
    createProviderPicker(ui.provider),
    createSelectPicker(ui.authMethod, { label: tr('settings.oauth.methodLabel') }),
    createSelectPicker(ui.models, { label: tr('accounts.defaultModelLabel') }),
    ...(ui.thinking ? [createSelectPicker(ui.thinking, { label: tr('settings.model.thinkingLabel') })] : []),
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
