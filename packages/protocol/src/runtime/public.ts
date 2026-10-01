// generated from schema/runtime by tools/gen-runtime.ts — do not edit
import type { TSchema } from '@sinclair/typebox'
import * as RuntimeSchemas from '../../gen/ts/runtime-public.js'
import type { RuntimeWireTypes } from '../../gen/ts/runtime-wire-types.js'
import { validateRuntimeValue } from './validation.js'

export type { ValidationError, ValidationResult } from '../../../protocol-validation/src/validate.js'
export type * from '../../gen/ts/runtime-public.js'
export { RuntimeMethodSchemaRefs, RuntimeSchemaRefs } from '../../gen/ts/runtime-schema-refs.js'
export type { RuntimeWireTypes } from '../../gen/ts/runtime-wire-types.js'
export { RuntimeSchemas }

const schemas: { [K in keyof RuntimeWireTypes]: TSchema } = RuntimeSchemas
export function validateRuntime<K extends keyof RuntimeWireTypes>(name: K, value: unknown) {
  return validateRuntimeValue<RuntimeWireTypes[K]>(schemas[name], value)
}
export {
  MAX_AUTHOR_INLINE_BYTES,
  RuntimeAuthorCapabilities,
  RuntimeAuthorCodecPolicy,
  RuntimeAuthorityTransferAPI,
  RuntimeConfigurationSchemas,
  RuntimeHttpHeaderPolicy,
  RuntimeInterceptorPolicy,
  RuntimeServiceCatalog,
} from '../../gen/ts/runtime-catalog.js'
