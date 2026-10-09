import { Type } from '@sinclair/typebox'
import type { JsonValue, UiSurface } from '../gen/ts/intelligent-ui.js'
import { validateAgainst } from './validate.js'

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

/** Display committed data; never interpret model text as an action or a permission. */
export function surfaceText(surface: UiSurface): string {
  const lines = [`${surface.title} (revision ${surface.revision})`]
  for (const component of surface.components) {
    if (component.title) lines.push(component.title)
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
      for (const [id, field] of Object.entries(component.schema.properties))
        if (object(field)) {
          lines.push(`${id}: ${String(field.title ?? id)}`)
          for (const [index, label] of (choices(field) ?? []).entries()) lines.push(`${index + 1}. ${label}`)
        }
    } else if (component.kind === 'chart') lines.push(JSON.stringify(surface.data[component.dataKey]))
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
  if (!validateAgainst(Type.Unsafe(simple.schema), translated).ok)
    throw new Error('Choose the listed option(s), or supply free text when allowed.')
  return { actionId: simple.action.id, input: { [simple.form.id]: translated }, selection: {} }
}
