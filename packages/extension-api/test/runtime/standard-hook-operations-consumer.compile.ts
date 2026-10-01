import {
  type AuthorEffects,
  defineInterceptor,
  defineTool,
  type NetworkRequest,
  type NetworkRequestResult,
  standardHookCapabilities,
  standardHookOperations,
} from '@agnes/extension-api/runtime'

export const headersTool = defineTool({
  id: 'request-headers',
  description: 'Read request headers',
  execution: 'pure',
  input: standardHookOperations.httpHeaders,
  execute(headers) {
    return { content: [], structured: { accept: headers.accept ?? null } }
  },
})

declare const request: NetworkRequest
export const networkInterceptor = defineInterceptor({
  id: 'request-observer',
  event: 'before_request',
  execution: 'opaque',
  config: { schema: standardHookOperations.httpHeaders, defaults: { accept: 'application/json' } },
  readFields: [],
  writeFields: [],
  permissions: [standardHookCapabilities.networkRequest],
  effects: [{ contract: 'agh.network', logicalName: 'default', method: 'request' }],
  async handle(_input, context) {
    const headers: Readonly<Record<string, string>> = context.config
    standardHookOperations.httpHeaders.encode(headers)
    const reply = await context.effects.invoke(standardHookOperations.networkRequest, request)
    if (reply.ok) {
      const result: NetworkRequestResult = reply.value
      standardHookOperations.networkRequest.output.encode(result)
    }
    return {}
  },
})

declare const effects: AuthorEffects
declare const response: NetworkRequestResult
// @ts-expect-error A network response is not the canonical request payload.
standardHookOperations.networkRequest.input.encode(response)
// @ts-expect-error Typed invocation rejects a response passed as its request.
effects.invoke(standardHookOperations.networkRequest, response)
// @ts-expect-error Header values must be strings.
standardHookOperations.httpHeaders.encode({ accept: 1 })
