import { Ajv2020 } from 'ajv/dist/2020.js'
import type { JsonValue, UiSurface } from '../gen/ts/intelligent-ui.js'

const ajv = new Ajv2020({ strict: false, validateFormats: false, addUsedSchema: false, ownProperties: true })

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const choices = (field: Record<string, unknown>): string[] | undefined => {
  const item = field.type === 'array' && object(field.items) ? field.items : field
  const values = field['x-ui-choices'] ?? item.enum
  return Array.isArray(values) && values.every((value) => typeof value === 'string') ? values : undefined
}
function simpleForm(surface: UiSurface) {
  const forms = surface.components.filter((component) => component.kind === 'form')
  if (forms.length !== 1) return undefined
  const form = forms[0]!
  if (
    'fallback' in form ||
    form.kind !== 'form' ||
    form.actionIds?.length !== 1 ||
    !object(form.schema) ||
    form.schema.type !== 'object' ||
    !object(form.schema.properties)
  )
    return undefined
  const action = surface.actions.find((action) => action.id === form.actionIds![0])
  if (!action || action.tool !== 'ui_submit' || action.confirm) return undefined
  if (
    !Object.values(form.schema.properties).every(
      (field) =>
        object(field) &&
        (field.type === 'string' ||
          (field.type === 'array' && object(field.items) && field.items.type === 'string')),
    )
  )
    return undefined
  return { form, action, schema: form.schema, fields: form.schema.properties }
}

/** A terminal may submit only a simple collector form. Other actions use authenticated Web. */
export const canAnswerSurface = (surface: UiSurface): boolean => !!simpleForm(surface)

function textValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}
/** Display-only. The model does not emit or store this percentage. */
function displayPercent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)))
}
function placedIds(surface: UiSurface): Set<string> {
  const placed = new Set<string>()
  for (const component of surface.components) {
    if ('fallback' in component || component.kind !== 'tabs') continue
    for (const tab of component.tabs) for (const id of tab.componentIds) placed.add(id)
  }
  return placed
}
function componentLines(surface: UiSurface, component: UiSurface['components'][number]): string[] {
  const lines: string[] = []
  if (component.title) lines.push(component.title)
  if ('fallback' in component) {
    lines.push(component.fallback)
    return lines
  }
  if (component.kind === 'text' || component.kind === 'status')
    lines.push(String(surface.data[component.dataKey]))
  else if (component.kind === 'table') {
    lines.push(component.columns.map((column) => column.label).join(' | '))
    const rows = surface.data[component.dataKey]
    if (Array.isArray(rows))
      for (const row of rows)
        if (object(row))
          lines.push(component.columns.map((column) => String(row[column.key] ?? '')).join(' | '))
  } else if (component.kind === 'form' && object(component.schema) && object(component.schema.properties)) {
    const bound = surface.data[component.dataKey]
    const record = object(bound) ? bound : undefined
    for (const [id, field] of Object.entries(component.schema.properties))
      if (object(field)) {
        const title = String(field.title ?? id)
        lines.push(`${id}: ${title}`)
        for (const [index, label] of (choices(field) ?? []).entries()) lines.push(`${index + 1}. ${label}`)
        const value = record?.[id]
        if (
          (field.format === 'date' || field.format === 'date-time') &&
          typeof value === 'string' &&
          value !== ''
        )
          lines.push(`${id}: ${title} = ${value}`)
      }
  } else if (component.kind === 'chart') lines.push(JSON.stringify(surface.data[component.dataKey]))
  else if (component.kind === 'detail-card') {
    const data = surface.data[component.dataKey]
    if (object(data)) {
      for (const field of component.fields) lines.push(`${field.label}: ${textValue(data[field.key])}`)
      if (component.statusKey && typeof data[component.statusKey] === 'string')
        lines.push(data[component.statusKey])
      if (component.secondaryKey && typeof data[component.secondaryKey] === 'string')
        lines.push(data[component.secondaryKey])
    }
  } else if (component.kind === 'steps') {
    const steps = surface.data[component.dataKey]
    if (Array.isArray(steps))
      for (const step of steps)
        if (object(step)) {
          lines.push(`${textValue(step.label)} — ${textValue(step.state)}`)
          if (typeof step.description === 'string' && step.description) lines.push(step.description)
        }
  } else if (component.kind === 'progress') {
    const data = surface.data[component.dataKey]
    if (
      object(data) &&
      typeof data.label === 'string' &&
      typeof data.value === 'number' &&
      typeof data.total === 'number'
    )
      lines.push(`${data.label}: ${data.value}/${data.total} (${displayPercent(data.value, data.total)}%)`)
  } else if (component.kind === 'image') {
    lines.push(component.alt)
    const data = surface.data[component.dataKey]
    const source = object(data) && object(data.source) ? data.source : undefined
    if (source?.kind === 'artifact') lines.push(`artifact ${textValue(source.sha256)}`)
    else if (source?.kind === 'attachment') lines.push(`attachment ${textValue(source.uri)}`)
    else if (source?.kind === 'data-url') lines.push('data-url')
  } else if (component.kind === 'tabs') {
    const byId = new Map(surface.components.map((item) => [item.id, item]))
    for (const tab of component.tabs) {
      lines.push(tab.label)
      for (const id of tab.componentIds) {
        const child = byId.get(id)
        if (!child || (!('fallback' in child) && child.kind === 'tabs')) continue
        lines.push(...componentLines(surface, child))
      }
    }
  }
  return lines
}

/** Display committed data; never interpret model text as an action or a permission. */
export function surfaceText(surface: UiSurface): string {
  const placed = placedIds(surface)
  const lines = [`${surface.title} (revision ${surface.revision})`]
  for (const component of surface.components) {
    if (placed.has(component.id)) continue
    lines.push(...componentLines(surface, component))
  }
  return lines.join('\n')
}

/** Translate numbered labels locally, then validate the full form before the ordinary action RPC. */
export function numberedSurfaceInput(
  surface: UiSurface,
  text: string,
): {
  actionId: string
  input: Record<string, JsonValue>
  selection: Record<string, string[]>
} {
  const simple = simpleForm(surface)
  if (!simple) throw new Error('Open this surface in authenticated Web to submit.')
  const entries = Object.entries(simple.fields)
  let answer: unknown
  try {
    answer = JSON.parse(text)
  } catch {
    /* Single fields also accept plain text. */
  }
  if (!object(answer)) {
    if (entries.length !== 1)
      throw new Error('Use a JSON object mapping field ids to answers; multiple choices use arrays.')
    const [id, field] = entries[0]!
    if (!object(field)) throw new Error('Invalid form schema')
    answer = { [id]: field.type === 'array' ? text.split(',').map((value) => value.trim()) : text.trim() }
  }
  if (!object(answer)) throw new Error('Invalid form answer')
  const translated: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(answer)) {
    const field = simple.fields[key]
    if (!object(field)) throw new Error('Unknown form field')
    const options = choices(field)
    const translate = (value: unknown): JsonValue => {
      if (typeof value !== 'string' && typeof value !== 'number')
        throw new Error('Choose labels, numbers or free text.')
      const label = String(value).trim()
      return options && /^\d+$/.test(label) ? (options[Number(label) - 1] ?? label) : label
    }
    translated[key] = Array.isArray(value) ? value.map(translate) : translate(value)
  }
  let valid = false
  try {
    valid = simple.schema.$async === undefined && ajv.compile(simple.schema)(translated) === true
  } catch {
    // Invalid or unresolved schemas cannot admit a terminal answer.
  }
  if (!valid) throw new Error('Choose the listed option(s), or supply free text when allowed.')
  return { actionId: simple.action.id, input: { [simple.form.id]: translated }, selection: {} }
}
