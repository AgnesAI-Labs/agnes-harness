import type { TSchema } from '@sinclair/typebox'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { rejectUiInput } from './input-rejection.js'
import { reachableParameters } from './parameters.js'

const ajv = new Ajv2020({ strict: false, allErrors: true, addUsedSchema: false, validateFormats: false })
/** Check argument names before values exist. Branch value constraints still run at submission. */
function namesOnly(schema: unknown): unknown {
  if (typeof schema === 'boolean') return schema
  if (!schema || typeof schema !== 'object') return {}
  const source = schema as Record<string, unknown>,
    result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (['type', 'required', 'propertyNames', 'minProperties', 'maxProperties'].includes(key))
      result[key] = value
    else if (key === '$ref')
      result[key] = typeof value === 'string' && !value.startsWith('#') ? `#/$defs/${value}` : value
    else if (key === 'properties' || key === 'patternProperties')
      result[key] = Object.fromEntries(Object.keys(value as object).map((name) => [name, {}]))
    else if (key === 'additionalProperties' || key === 'unevaluatedProperties') result[key] = value !== false
    else if (key === '$defs')
      result[key] = Object.fromEntries(
        Object.entries(value as object).map(([name, child]) => [name, namesOnly(child)]),
      )
    else if (['allOf', 'anyOf', 'oneOf'].includes(key))
      result[key === 'oneOf' ? 'anyOf' : key] = (value as unknown[]).map(namesOnly)
  }
  return result
}
export function validateActionParameterNames(
  schema: TSchema,
  args: object,
  path: string,
  tool: string,
): void {
  const root = reachableParameters(schema)
  const validate = ajv.compile(namesOnly(root) as TSchema)
  if (validate(args)) return
  rejectUiInput(
    (validate.errors ?? []).map((error) => ({
      path: `${path}/${error.params.additionalProperty ?? error.params.missingProperty ?? ''}`,
      expected: `Argument names for tool "${tool}": ${error.message}; ${JSON.stringify(error.params)}. Declared parameters: ${Object.keys(root.properties ?? {}).join(', ') || '(see tool schema)'}. Match the tool's parameters, not only paramsSchema.`,
    })),
  )
}
