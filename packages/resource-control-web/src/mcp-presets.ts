import type { McpServerDefinitionInput } from '@agnes/protocol'
import { createMcpPreset, MCP_PRESETS } from '@agnes/resource-control-contracts/mcp-presets'
import {
  createSelectPicker,
  createSettingsButton,
  createSettingsControl,
  type LocaleTranslator,
} from '@agnes/web-ui'

/** Presets only fill the existing form; its controller retains confirmation and submission. */
export function mountMcpPresets(input: {
  form: HTMLFormElement
  toolbar: HTMLElement
  open: () => void
  fill: (definition: McpServerDefinitionInput) => void
  locale: () => 'en' | 'zh-CN'
  text: () => LocaleTranslator
}) {
  const button = createSettingsButton(document)
  button.hidden = true
  button.disabled = true
  button.id = 'mcp-add-preset'
  button.dataset.testid = 'mcp-add-preset'
  input.toolbar.append(button)
  const field = document.createElement('label')
  field.className = 'form-field agnes-ui-field'
  field.hidden = true
  const label = document.createElement('span')
  label.className = 'agnes-ui-field-label'
  field.htmlFor = 'mcp-preset'
  const select = createSettingsControl(document, 'select')
  select.id = 'mcp-preset'
  select.dataset.testid = 'mcp-preset'
  select.setAttribute('aria-describedby', 'mcp-preset-description')
  for (const preset of MCP_PRESETS) {
    const option = document.createElement('option')
    option.value = preset.id
    option.textContent = preset.displayName
    select.append(option)
  }
  const description = document.createElement('p')
  description.id = 'mcp-preset-description'
  field.append(label, select)
  input.form.querySelector('.dialog-intro')?.after(field, description)
  let picker = createSelectPicker(select, { label: input.text()('preset.label') })
  const describe = () => {
    const preset = MCP_PRESETS.find((entry) => entry.id === select.value)
    description.textContent = preset
      ? `${preset.description[input.locale()]} ${input.text()('preset.output')}`
      : ''
  }
  const apply = () => {
    input.fill(createMcpPreset(select.value))
    describe()
    picker.sync()
  }
  button.addEventListener('click', () => {
    input.open()
    field.hidden = false
    description.hidden = false
    select.value = MCP_PRESETS[0].id
    apply()
  })
  select.addEventListener('change', apply)
  return {
    button,
    reset() {
      field.hidden = true
      description.hidden = true
    },
    localize() {
      button.textContent = input.text()('preset.add')
      label.textContent = input.text()('preset.label')
      describe()
      picker.destroy()
      picker = createSelectPicker(select, { label: input.text()('preset.label') })
    },
    dispose() {
      picker.destroy()
      button.remove()
      field.remove()
      description.remove()
    },
  }
}
