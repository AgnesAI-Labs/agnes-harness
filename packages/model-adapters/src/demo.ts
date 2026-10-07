import type { ModelAdapterEvent } from '@agnes/extension-api'
import { type JsonValue, type RequestBody, type ToolSchema, validateAgainst } from '@agnes/protocol'
import { type TSchema, Type } from '@sinclair/typebox'
import { object } from './trace.js'

const label = '[Demo model — local, deterministic, no API key]'
const text = (message: string): ModelAdapterEvent => ({ type: 'text_delta', delta: label + ' ' + message })

/** A small teaching subset of JSON Schema. Unsupported constraints fail validation, never execution. */
function example(schema: unknown, message: string, depth = 0): JsonValue {
  if (!object(schema) || depth > 12) throw new Error('unsupported schema')
  if ('const' in schema) return schema.const as JsonValue
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0] as JsonValue
  if ('default' in schema) return schema.default as JsonValue
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf))
    return example(
      (Array.isArray(schema.anyOf) ? schema.anyOf : (schema.oneOf as unknown[]))[0],
      message,
      depth + 1,
    )
  switch (schema.type) {
    case 'object': {
      const properties = object(schema.properties) ? schema.properties : {}
      const args: Record<string, JsonValue> = Object.create(null)
      for (const key of Array.isArray(schema.required) ? schema.required : []) {
        if (typeof key !== 'string') throw new Error('invalid required field')
        args[key] = example(properties[key], message, depth + 1)
      }
      return args
    }
    case 'string': {
      const minimum = typeof schema.minLength === 'number' ? schema.minLength : 1
      const maximum = typeof schema.maxLength === 'number' ? schema.maxLength : 1024
      if (minimum > 1024 || minimum > maximum) throw new Error('unsupported string bounds')
      return (message || 'demo').padEnd(minimum, 'x').slice(0, Math.min(maximum, 1024))
    }
    case 'integer':
    case 'number': {
      let value = typeof schema.minimum === 'number' ? schema.minimum : 0
      if (typeof schema.exclusiveMinimum === 'number') value = schema.exclusiveMinimum + 1
      if (typeof schema.maximum === 'number') value = Math.min(value, schema.maximum)
      return schema.type === 'integer' ? Math.ceil(value) : value
    }
    case 'boolean':
      return false
    case 'null':
      return null
    case 'array': {
      const length = typeof schema.minItems === 'number' ? schema.minItems : 0
      if (length > 16) throw new Error('unsupported array bounds')
      return Array.from({ length }, () => example(schema.items, message, depth + 1))
    }
    default:
      throw new Error('unsupported schema')
  }
}
// Model requests carry plain JSON schemas; reconstruct supported TypeBox nodes for validation.
function validator(schema: unknown, depth = 0): TSchema {
  if (!object(schema) || depth > 12 || '$ref' in schema) throw new Error('unsupported schema')
  if (Object.keys(schema).length === 0) return Type.Unknown()
  const branch =
    'const' in schema ? 'const' : 'enum' in schema ? 'enum' : 'anyOf' in schema ? 'anyOf' : undefined
  if (branch) {
    const allowed = new Set([branch, 'description', 'title', 'default', '$schema', '$id'])
    if (branch !== 'anyOf') allowed.add('type')
    if (Object.keys(schema).some((key) => !allowed.has(key)))
      throw new Error('unsupported combined constraint')
  }
  if ('const' in schema) {
    if (
      schema.type !== undefined &&
      !(
        schema.type === typeof schema.const ||
        (schema.type === 'null' && schema.const === null) ||
        (schema.type === 'integer' && Number.isInteger(schema.const))
      )
    )
      throw new Error('constant type mismatch')
    if (schema.const === null) return Type.Null()
    if (['string', 'number', 'boolean'].includes(typeof schema.const))
      return Type.Literal(schema.const as string | number | boolean)
    throw new Error('unsupported constant')
  }
  if (Array.isArray(schema.enum))
    return Type.Union(
      schema.enum.map((value) =>
        validator({ const: value, ...(schema.type ? { type: schema.type } : {}) }, depth + 1),
      ),
    )
  if (Array.isArray(schema.anyOf)) return Type.Union(schema.anyOf.map((value) => validator(value, depth + 1)))
  // oneOf/allOf and custom keywords need a reasoning adapter or explicit author examples.
  const supported = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'minItems',
    'maxItems',
    'uniqueItems',
    'minLength',
    'maxLength',
    'pattern',
    'format',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'description',
    'title',
    'default',
    '$schema',
    '$id',
  ])
  if (Object.keys(schema).some((key) => !supported.has(key))) throw new Error('unsupported schema constraint')
  switch (schema.type) {
    case 'object': {
      const properties = object(schema.properties) ? schema.properties : {}
      const required = Array.isArray(schema.required) ? schema.required : []
      const fields = Object.fromEntries(
        Object.entries(properties).map(([key, value]) => {
          const field = validator(value, depth + 1)
          return [key, required.includes(key) ? field : Type.Optional(field)]
        }),
      )
      if (required.some((key) => typeof key !== 'string' || !(key in fields)))
        throw new Error('invalid required field')
      if (object(schema.additionalProperties)) throw new Error('unsupported additional properties')
      return Type.Object(fields, schema)
    }
    case 'string':
      return Type.String(schema)
    case 'integer':
      return Type.Integer(schema)
    case 'number':
      return Type.Number(schema)
    case 'boolean':
      return Type.Boolean()
    case 'null':
      return Type.Null()
    case 'array':
      return Type.Array(validator(schema.items ?? {}, depth + 1), schema)
    default:
      throw new Error('unsupported schema')
  }
}
function valid(tool: ToolSchema, args: unknown): boolean {
  return validateAgainst(validator(tool.parameters), args).ok
}
function argsFor(tool: ToolSchema, message: string): JsonValue {
  const raw = message.slice(message.indexOf(tool.name) + tool.name.length).trim()
  const args = raw.startsWith('{') ? JSON.parse(raw) : example(tool.parameters, message)
  if (!valid(tool, args)) throw new Error('arguments do not match the schema')
  return args as JsonValue
}
function data(message: RequestBody['messages'][number]): unknown {
  const content = message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  try {
    return JSON.parse(content) as unknown
  } catch {
    return undefined
  }
}

/** Decisions are derived entirely from the request, so concurrent sessions and replay stay independent. */
export function demoReply(request: RequestBody): ModelAdapterEvent[] {
  const userIndex = request.messages.findLastIndex((message) => message.role === 'user')
  const user = request.messages[userIndex]
  const prompt = user?.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(' ') ?? ''
  const results = request.messages.slice(userIndex + 1).filter((message) => message.role === 'tool_result')
  let selected: ToolSchema | undefined
  let args: JsonValue | undefined
  const authoring = /(?:create|write|build|make).*plugin|(?:创建|编写|写).*插件/i.test(prompt)
  const find = (name: string) => request.tools.find((tool) => tool.name === name)
  const latest = results.at(-1)
  if (latest?.role === 'tool_result' && latest.isError)
    return finish(
      text(
        'The tool reported a failure: ' +
          latest.content
            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join(' ')
            .slice(0, 2048),
      ),
    )
  if (authoring && !results.length) {
    selected = find('plugin_helper_guide') ?? find('plugin_creator_guide')
    if (selected) args = selected.name === 'plugin_helper_guide' ? { kind: 'tool' } : {}
  } else if (authoring && latest && results.length === 1) {
    const guide = data(latest)
    if (object(guide) && Array.isArray(guide.files)) {
      selected = find('plugin_helper_create')
      if (selected) args = { files: guide.files as JsonValue[] }
    } else if (find('plugin_creator_guide') && find('plugin_scaffold')) {
      selected = find('plugin_scaffold')
      args = {
        template: 'tool',
        name: 'demo-hello-tool',
        directory: '.demo-plugin-' + request.derivedHash.slice(0, 12),
      }
    }
  }
  if (!selected && !results.length) {
    selected = request.tools.find((tool) => {
      const name = tool.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp('(^|[^A-Za-z0-9_])' + name + '($|[^A-Za-z0-9_])').test(prompt)
    })
  }
  if (selected) {
    try {
      args ??= argsFor(selected, prompt)
      if (!valid(selected, args)) throw new Error('invalid args')
      return finish(text('Calling ' + selected.name + ' with example arguments.'), {
        type: 'toolcall_end',
        call: {
          toolUseId: 'demo-' + request.derivedHash.slice(0, 24),
          name: selected.name,
          args,
          ordinal: 0,
        },
      })
    } catch {
      return finish(
        text(
          'Cannot derive valid arguments for ' +
            selected.name +
            '. Use: call ' +
            selected.name +
            ' {"field":"value"}, or configure a reasoning model.',
        ),
      )
    }
  }
  if (results.length) {
    const summary = results
      .flatMap((result) => result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])))
      .join(' ')
      .slice(0, 4096)
    return finish(
      text(
        'Tool result: ' +
          summary +
          (authoring
            ? ' Review the prepared files before requesting installation; approval remains required.'
            : ''),
      ),
    )
  }
  return finish(
    text(
      'Hello! Name a tool or say "call <tool>" to try it. Available tools: ' +
        (request.tools.map((tool) => tool.name).join(', ') || 'none') +
        '. This teaching model performs no reasoning.',
    ),
  )
}
function finish(...events: ModelAdapterEvent[]): ModelAdapterEvent[] {
  return [
    ...events,
    {
      type: 'usage',
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      creditSource: 'estimated',
    },
    { type: 'done', reason: events.some((event) => event.type === 'toolcall_end') ? 'toolUse' : 'stop' },
  ]
}
