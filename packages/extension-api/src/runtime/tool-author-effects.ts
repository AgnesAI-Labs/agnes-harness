import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  RuntimeMethodSchemaRefs,
  RuntimeServiceCatalog,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { AuthorEffectReference, AuthorEffects, TypedEffectOperation } from './authoring.js'
import { assertAuthorSchema } from './authoring-schemas.js'
import { assertFields, copyJson, declarationError, validName } from './authoring-validation.js'
import type { CallContext, EffectPorts, Outcome } from './public-api.js'

/** Routes are supplied by trusted assembly, never derived from author-controlled names. */
export type ToolAuthorEffectRoute = AuthorEffectReference & { readonly brokerOperation: string }
export interface ToolAuthorEffectsWindow {
  readonly effects: AuthorEffects
  readonly pending: number
  readonly dispatched: boolean
  /** An inline broker result passed the official output codec and integrity checks. */
  readonly confirmedSuccess: boolean
  readonly failure: Wire.RuntimeError | undefined
  close(): void
  waitForPending(): Promise<void>
}
type Method = {
  kind?: string
  local?: boolean
  sameAttemptBrokerAllowed: boolean
  input?: string
  output?: string
}
const catalog: Readonly<Record<string, { methods: Readonly<Record<string, Method>> }>> = RuntimeServiceCatalog
const refs: Readonly<
  Record<string, Readonly<Record<string, { input: Wire.SchemaRef; output: Wire.SchemaRef }>>>
> = RuntimeMethodSchemaRefs
function key(value: AuthorEffectReference): string {
  return JSON.stringify([value.contract, value.logicalName, value.method])
}
function equal(a: unknown, b: unknown): boolean {
  return canonicalJsonDigest(a as Wire.JsonValue) === canonicalJsonDigest(b as Wire.JsonValue)
}
function error(code: Wire.RuntimeErrorCode, detailCode: string): Wire.RuntimeError {
  return Object.freeze({
    code,
    detailCode,
    message: 'Tool effect adapter refused the operation',
    retryAdvice: Object.freeze({ kind: 'never' }),
    diagnosticId: 'tool-author-effects',
  })
}
function method(value: AuthorEffectReference): Method | undefined {
  if (!Object.hasOwn(catalog, value.contract)) return undefined
  const methods = catalog[value.contract]?.methods
  const operation = methods && Object.hasOwn(methods, value.method) ? methods[value.method] : undefined
  if (
    operation?.kind !== 'action' ||
    operation.local === true ||
    operation.sameAttemptBrokerAllowed !== true ||
    typeof operation.input !== 'string' ||
    typeof operation.output !== 'string'
  )
    return undefined
  return operation
}

/** Reject missing routes and methods that are not eligible for a same-attempt broker. */
export function validateToolAuthorEffectRoutes(
  declared: readonly AuthorEffectReference[],
  routes: readonly ToolAuthorEffectRoute[],
): readonly ToolAuthorEffectRoute[] {
  const lockedDeclarations = copyJson(declared)
  const lockedRoutes = copyJson(routes)
  const allowed = new Set<string>()
  for (const declaration of lockedDeclarations) {
    assertFields(declaration, ['contract', 'logicalName', 'method'])
    if (!method(declaration) || !validName(declaration.logicalName) || allowed.has(key(declaration)))
      declarationError('invalid declared broker operation')
    allowed.add(key(declaration))
  }
  const bound = new Map<string, ToolAuthorEffectRoute>()
  for (const route of lockedRoutes) {
    assertFields(route, ['contract', 'logicalName', 'method', 'brokerOperation'])
    if (!allowed.has(key(route)) || bound.has(key(route)) || !validName(route.brokerOperation))
      declarationError('invalid bound broker route')
    bound.set(key(route), route)
  }
  if (bound.size !== allowed.size) declarationError('missing bound broker route')
  return lockedRoutes
}

/**
 * One author execution window over real EffectPorts. This does not create a broker,
 * authorization, request owner or persistent recovery evidence. Blob output needs a
 * separate authorized resolver and is refused until trusted assembly supplies one.
 */
export function createToolAuthorEffects(
  declared: readonly AuthorEffectReference[],
  routes: readonly ToolAuthorEffectRoute[],
  ports: EffectPorts,
  context: CallContext,
  signal: AbortSignal,
): ToolAuthorEffectsWindow {
  const bound = new Map(validateToolAuthorEffectRoutes(declared, routes).map((route) => [key(route), route]))
  const { signal: contextSignal, ...wireContext } = context
  if (!validateRuntime('CallContextWire', wireContext).ok) declarationError('invalid broker context')
  const portContext = Object.freeze({
    ...copyJson(wireContext),
    signal: AbortSignal.any([contextSignal, signal]),
  })
  let closed = false
  let pending = 0
  let dispatched = false
  let confirmedSuccess = false
  let failure: Wire.RuntimeError | undefined
  const settled = new Set<() => void>()
  function latch(value: Wire.RuntimeError): void {
    if (failure === undefined || value.code === 'unknown_effect') failure = copyJson(value)
  }
  function cancelled(): Wire.RuntimeError | undefined {
    if (signal.aborted || contextSignal.aborted) return error('cancelled', 'tool_effect_cancelled')
    if (Date.now() >= Date.parse(wireContext.deadline)) return error('timeout', 'tool_effect_deadline')
    return undefined
  }
  const effects: AuthorEffects = Object.freeze({
    async invoke<I, O>(operation: TypedEffectOperation<I, O>, input: I): Promise<Outcome<O>> {
      const stop = cancelled()
      if (closed || stop || failure)
        return { ok: false, error: failure ?? stop ?? error('cancelled', 'tool_effect_window_closed') }
      let route: ToolAuthorEffectRoute | undefined
      let registered: Method | undefined
      let encoded: Outcome<Wire.DataRef>
      let outputCodec: TypedEffectOperation<I, O>['output']
      try {
        assertFields(operation, ['contract', 'logicalName', 'method', 'input', 'output'])
        route = bound.get(key(operation))
        registered = method(operation)
        if (!route || !registered) return { ok: false, error: error('denied', 'tool_effect_not_declared') }
        assertAuthorSchema(operation.input)
        assertAuthorSchema(operation.output)
        outputCodec = operation.output
        const official = refs[route.contract]?.[route.method]
        if (
          !official ||
          !equal(official.input, operation.input.ref) ||
          !equal(official.output, operation.output.ref)
        )
          return { ok: false, error: error('invalid_input', 'tool_effect_codec_schema') }
        encoded = operation.input.encode(input)
        if (!encoded.ok) return encoded
        if (
          encoded.value.kind !== 'inline' ||
          !validateRuntime(registered.input as keyof Wire.RuntimeWireTypes, encoded.value.value).ok
        )
          return { ok: false, error: error('invalid_input', 'tool_effect_input') }
      } catch {
        return { ok: false, error: error('invalid_input', 'tool_effect_codec') }
      }
      const beforeDispatch = cancelled()
      if (closed || beforeDispatch)
        return { ok: false, error: beforeDispatch ?? error('cancelled', 'tool_effect_window_closed') }
      pending++
      dispatched = true
      try {
        const result = await ports.invoke(
          { operation: route.brokerOperation, input: encoded.value },
          portContext,
        )
        if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean')
          throw new Error('invalid effect outcome')
        if (!result.ok) {
          if (!validateRuntime('RuntimeError', result.error).ok) throw new Error('invalid effect error')
          latch(result.error)
          return { ok: false, error: copyJson(result.error) }
        }
        const ref = result.value
        if (
          !validateRuntime('DataRef', ref).ok ||
          ref.kind !== 'inline' ||
          !equal(ref.schema, outputCodec.ref) ||
          !validateRuntime(registered.output as keyof Wire.RuntimeWireTypes, ref.value).ok
        )
          throw new Error('invalid effect output')
        const parsed = outputCodec.parse(ref.value)
        if (!parsed.ok) throw new Error('invalid effect output value')
        const encodedOutput = outputCodec.encode(parsed.value)
        if (!encodedOutput.ok || !equal(encodedOutput.value, ref))
          throw new Error('invalid effect output encoding')
        confirmedSuccess = true
        const afterDispatch = cancelled()
        if (afterDispatch) {
          latch(afterDispatch)
          return { ok: false, error: afterDispatch }
        }
        return parsed
      } catch {
        const unknown = error('unknown_effect', 'tool_effect_confirmation_unknown')
        latch(unknown)
        return { ok: false, error: unknown }
      } finally {
        pending--
        if (pending === 0) {
          for (const resolve of settled) resolve()
          settled.clear()
        }
      }
    },
  })
  return Object.freeze({
    effects,
    get pending() {
      return pending
    },
    get dispatched() {
      return dispatched
    },
    get confirmedSuccess() {
      return confirmedSuccess
    },
    get failure() {
      return failure
    },
    close() {
      closed = true
    },
    waitForPending() {
      return pending === 0 ? Promise.resolve() : new Promise<void>((resolve) => settled.add(resolve))
    },
  })
}
