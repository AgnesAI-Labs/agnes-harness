import type { UiSurfaceRecord } from '@agnes/protocol'
import type { ChannelFormField, ChannelSurfaceBlock } from '../adapter.js'

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Only a resolved collector form has a portable answer contract. */
export function surfaceBlock(
  record: UiSurfaceRecord,
  sessionId: string,
  fallbackUrl: string,
): ChannelSurfaceBlock | undefined {
  const { surface } = record
  if (
    surface.components.some(
      (component) => 'fallback' in component || !['form', 'text', 'status'].includes(component.kind),
    )
  )
    return undefined
  if (Object.values(surface.data).some((value) => object(value) && '$source' in value)) return undefined
  const forms = surface.components.filter((component) => component.kind === 'form')
  const form = forms.length === 1 ? forms.at(0) : undefined
  if (
    !form ||
    'fallback' in form ||
    form.kind !== 'form' ||
    form.actionIds?.length !== 1 ||
    !object(form.schema) ||
    form.schema.type !== 'object' ||
    !object(form.schema.properties)
  )
    return undefined
  const action = surface.actions.find((item) => item.id === form.actionIds?.at(0))
  if (!action || action.tool !== 'ui_submit' || action.confirm || Object.keys(record.sources ?? {}).length)
    return undefined
  const answers = action.argsTemplate.answers
  if (
    !object(answers) ||
    !('from' in answers) ||
    answers.from !== 'input' ||
    !('key' in answers) ||
    answers.key !== form.id
  )
    return undefined
  const required = new Set(Array.isArray(form.schema.required) ? form.schema.required : [])
  const fields: ChannelFormField[] = []
  for (const [name, schema] of Object.entries(form.schema.properties)) {
    if (!object(schema)) return undefined
    const common = {
      name,
      label: typeof schema.title === 'string' ? schema.title : name,
      required: required.has(name),
      binding: 'input' as const,
      inputKey: form.id,
    }
    const item = schema.type === 'array' && object(schema.items) ? schema.items : schema
    const choices = item.enum ?? schema['x-ui-choices'] ?? (schema.type === 'array' ? [] : undefined)
    const allowFreeText = !Array.isArray(item.enum)
    if (Array.isArray(choices) && choices.every((v) => typeof v === 'string')) {
      const options = choices.map((value) => ({ value: value as string, label: value as string }))
      if (schema.type === 'array')
        fields.push({
          ...common,
          kind: 'multi',
          options,
          ...(allowFreeText ? { allowFreeText: true } : {}),
          ...(typeof schema.minItems === 'number' ? { minItems: schema.minItems } : {}),
          ...(typeof schema.maxItems === 'number' ? { maxItems: schema.maxItems } : {}),
        })
      else if (schema.type === 'string')
        fields.push({ ...common, kind: 'single', options, ...(allowFreeText ? { allowFreeText: true } : {}) })
      else return undefined
    } else if (schema.type === 'string')
      fields.push({
        ...common,
        kind: 'text',
        multiline: true,
        ...(typeof schema.maxLength === 'number' ? { maxLength: schema.maxLength } : {}),
      })
    else return undefined
  }
  if (!fields.length || fields.length > 32) return undefined
  return {
    kind: 'surface',
    sessionId,
    surfaceId: surface.id,
    revision: surface.revision,
    title: surface.title,
    ...(surface.summary ? { body: surface.summary } : {}),
    fallbackUrl,
    form:
      record.status === 'closed'
        ? { state: 'closed', summary: '已处理 / Closed' }
        : { state: 'open', actionId: action.id, submitLabel: action.label, fields },
  }
}
