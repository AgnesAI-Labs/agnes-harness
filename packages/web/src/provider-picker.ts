import { createSelectPicker, type SelectPicker } from '@agnes/web-ui'

export function createProviderPicker(select: HTMLSelectElement): SelectPicker {
  return createSelectPicker(select, {
    label: 'Provider',
    includeEmpty: false,
    formatOption: (label) => label.replace(/ · 订阅登录$/, ''),
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
    createSelectPicker(ui.authMethod, { label: '认证方式' }),
    createSelectPicker(ui.models, { label: '默认模型' }),
    ...(ui.thinking ? [createSelectPicker(ui.thinking, { label: '默认思考强度' })] : []),
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
