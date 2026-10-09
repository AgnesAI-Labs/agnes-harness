import { type ReactNode, useId } from 'react'
import { PluginSchemaFields, type PluginSchemaFieldsProps } from '../plugin-schema-fields.js'
import { isSchemaObject } from '../plugin-schema-model.js'
import { useUiText } from '../ui-locale.js'
import { INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog } from './locales.js'

/** Schema display hints change controls only; full schema validation remains backend-owned. */
export function SurfaceFormFields(props: PluginSchemaFieldsProps) {
  const instance = useId()
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const schema = props.schema
  if (
    !isSchemaObject(schema) ||
    schema.type !== 'object' ||
    !isSchemaObject(schema.properties) ||
    !Object.values(schema.properties).some(
      (field) => isSchemaObject(field) && Array.isArray(field['x-ui-choices']),
    )
  )
    return <PluginSchemaFields {...props} />
  const values = isSchemaObject(props.value) ? props.value : {}
  return (
    <>
      {Object.entries(schema.properties).map(([key, field]) => {
        if (!isSchemaObject(field)) return null
        const choices = field['x-ui-choices']
        const change = (value: unknown) => props.onChange({ ...values, [key]: value })
        if (!Array.isArray(choices) || !choices.every((value) => typeof value === 'string'))
          return (
            <PluginSchemaFields
              key={key}
              {...props}
              schema={field}
              path={`${props.path}/${key}`}
              value={values[key]}
              onChange={change}
            />
          )
        const multiple = field.type === 'array'
        const selected = multiple
          ? Array.isArray(values[key])
            ? (values[key] as string[])
            : []
          : [values[key]]
        const item = multiple && isSchemaObject(field.items) ? field.items : field
        const free = !Array.isArray(item.enum)
        const other = selected.filter((value) => typeof value === 'string' && !choices.includes(value))
        let extra: ReactNode
        if (free)
          extra = (
            <label>
              {t('ui.otherAnswer')}
              <input
                type="text"
                value={other.join(', ')}
                disabled={props.disabled}
                maxLength={8192}
                data-testid={`ui-free-${key}`}
                aria-label={t('ui.otherAnswer')}
                onChange={(event) =>
                  change(
                    multiple
                      ? [
                          ...selected.filter((value) => typeof value === 'string' && choices.includes(value)),
                          ...(event.currentTarget.value ? [event.currentTarget.value] : []),
                        ]
                      : event.currentTarget.value,
                  )
                }
              />
            </label>
          )
        return (
          <fieldset
            className="agnes-intelligent-choices"
            key={key}
            disabled={props.disabled}
            data-testid={`ui-choice-${key}`}
          >
            <legend>{String(field.title ?? key)}</legend>
            {choices.map((choice, index) => (
              <label key={choice}>
                <input
                  type={multiple ? 'checkbox' : 'radio'}
                  name={`${instance}-${key}`}
                  checked={selected.includes(choice)}
                  data-testid={`ui-option-${key}-${index}`}
                  onChange={(event) =>
                    change(
                      multiple
                        ? event.currentTarget.checked
                          ? [...selected, choice]
                          : selected.filter((value) => value !== choice)
                        : choice,
                    )
                  }
                />
                {choice}
              </label>
            ))}
            {extra}
          </fieldset>
        )
      })}
    </>
  )
}
