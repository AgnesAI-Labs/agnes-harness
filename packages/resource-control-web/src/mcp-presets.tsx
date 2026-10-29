import type { McpServerDefinitionInput } from '@agnes/protocol'
import { createMcpPreset, MCP_PRESETS } from '@agnes/resource-control-contracts/mcp-presets'
import {
  Button,
  createRegionHost,
  createSelectPicker,
  Field,
  type LocaleTranslator,
  renderRegion,
  SettingsSelect,
  unmountRegion,
} from '@agnes/web-ui'

/** Presets fill the existing form; its controller retains authorization and submission. */
export function mountMcpPresets(input: {
  form: HTMLFormElement
  toolbar: HTMLElement
  open: () => void
  fill: (definition: McpServerDefinitionInput) => void
  locale: () => 'en' | 'zh-CN'
  text: () => LocaleTranslator
}) {
  const buttonHost = createRegionHost(input.toolbar, 'span')
  const fieldHost = createRegionHost(input.form, 'div')
  input.form.querySelector('.dialog-intro')?.after(fieldHost)
  let button: HTMLButtonElement
  let select: HTMLSelectElement
  let availability = { hidden: true, disabled: true }
  let visible = false
  let value: string = MCP_PRESETS[0].id
  let picker: ReturnType<typeof createSelectPicker> | undefined
  const apply = () => {
    value = select.value
    input.fill(createMcpPreset(value))
    renderField()
    picker?.sync()
  }
  const renderField = () => {
    fieldHost.hidden = !visible
    const preset = MCP_PRESETS.find((entry) => entry.id === value)
    renderRegion(
      fieldHost,
      <>
        <Field
          className="form-field"
          hidden={!visible}
          htmlFor="mcp-preset"
          label={input.text()('preset.label')}
        >
          <SettingsSelect
            ref={(node) => {
              if (node) select = node
            }}
            id="mcp-preset"
            data-testid="mcp-preset"
            aria-describedby="mcp-preset-description"
            value={value}
            onChange={apply}
          >
            {MCP_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.displayName}
              </option>
            ))}
          </SettingsSelect>
        </Field>
        <p id="mcp-preset-description" hidden={!visible}>
          {preset ? `${preset.description[input.locale()]} ${input.text()('preset.output')}` : ''}
        </p>
      </>,
    )
  }
  const renderButton = () => {
    const { hidden, disabled } = availability
    buttonHost.hidden = hidden
    renderRegion(
      buttonHost,
      <Button
        ref={(node) => {
          if (node) button = node
        }}
        id="mcp-add-preset"
        data-testid="mcp-add-preset"
        hidden={hidden}
        disabled={disabled}
        onClick={() => {
          input.open()
          visible = true
          value = MCP_PRESETS[0].id
          input.fill(createMcpPreset(value))
          renderField()
          picker?.sync()
          input.form.querySelector<HTMLElement>('#mcp-preset-trigger')?.focus()
        }}
      >
        {input.text()('preset.add')}
      </Button>,
    )
  }
  renderButton()
  renderField()
  picker = createSelectPicker(select!, { label: input.text()('preset.label') })
  return {
    setAvailability(next: typeof availability) {
      availability = next
      renderButton()
    },
    get button() {
      return button
    },
    reset() {
      visible = false
      renderField()
    },
    localize() {
      renderButton()
      // Unmount the picker before React reconciles its native select's label/description.
      picker?.destroy()
      renderField()
      picker = createSelectPicker(select, { label: input.text()('preset.label') })
    },
    dispose() {
      picker?.destroy()
      unmountRegion(buttonHost)
      unmountRegion(fieldHost)
      buttonHost.remove()
      fieldHost.remove()
    },
  }
}
