// Same TypeBox Kind tagging as AGH examples/packages/hot-tool-plugin; no runtime dependency.
const Kind = Symbol.for('TypeBox.Kind'),
  Optional = Symbol.for('TypeBox.Optional')
export const string = (maxLength = 4096, minLength = 1) => ({
  [Kind]: 'String',
  type: 'string',
  minLength,
  maxLength,
})
export const boolean = () => ({ [Kind]: 'Boolean', type: 'boolean' })
export const enumeration = (...values) => ({
  [Kind]: 'Union',
  anyOf: values.map((value) => ({ [Kind]: 'Literal', const: value, type: 'string' })),
})
export const optional = (schema) => ({ ...schema, [Optional]: 'Optional' })
export const object = (properties) => ({
  [Kind]: 'Object',
  type: 'object',
  properties,
  required: Object.keys(properties).filter((key) => !properties[key][Optional]),
  additionalProperties: false,
})
export const array = (items, maxItems) => ({ [Kind]: 'Array', type: 'array', items, minItems: 0, maxItems })
