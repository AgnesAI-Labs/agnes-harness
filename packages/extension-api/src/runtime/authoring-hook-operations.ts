import {
  type ControlledHttpHeaders,
  type NetworkRequest,
  type NetworkRequestResult,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateControlledHttpHeaders,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { AuthorSchema, TypedEffectOperation } from './authoring.js'
import { createAuthorSchema } from './authoring-schema-core.js'

const networkRefs = RuntimeMethodSchemaRefs['agh.network'].request

/** Typed declarations for the official request operation; execution uses the bound effect ports. */
export const standardHookOperations: Readonly<{
  networkRequest: Readonly<TypedEffectOperation<NetworkRequest, NetworkRequestResult>>
  httpHeaders: AuthorSchema<Readonly<ControlledHttpHeaders>>
}> = Object.freeze({
  networkRequest: Object.freeze({
    contract: 'agh.network',
    logicalName: 'default',
    method: 'request',
    input: createAuthorSchema(networkRefs.input, (value) => validateRuntime('NetworkRequest', value)),
    output: createAuthorSchema(networkRefs.output, (value) => validateRuntime('NetworkRequestResult', value)),
  }),
  httpHeaders: createAuthorSchema(RuntimeSchemaRefs.ControlledHttpHeaders, (value) =>
    validateControlledHttpHeaders('request', value),
  ),
})
