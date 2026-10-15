import type { AiErrorCode, Billing, JsonValue, RequestBody, TokenCounts } from '@agnes/protocol'
import { expectTypeOf, it } from 'vitest'
import type {
  GenericLoopPorts,
  LoopContext,
  LoopSideCallPort,
  ModelAdapterCapabilities,
  PreparedSideCall,
  SideCallFailure,
  SideCallOptions,
  SideCallResult,
  SideCallStatus,
  SideCallTarget,
  SideCallUsage,
} from '../src/index.js'
import type { CostLedger } from '../src/seams.js'

it('exposes the side call port on the generic loop ports as an optional member', () => {
  expectTypeOf<GenericLoopPorts>().toHaveProperty('sideCall')
  expectTypeOf<GenericLoopPorts['sideCall']>().toEqualTypeOf<LoopSideCallPort | undefined>()
  expectTypeOf<LoopContext>().toExtend<GenericLoopPorts>()
  // Existing test doubles that do not provide the port keep compiling.
  type WithoutPort = Omit<GenericLoopPorts, 'sideCall'>
  expectTypeOf<WithoutPort>().toExtend<GenericLoopPorts>()
})

it('shapes the three port methods', () => {
  expectTypeOf<LoopSideCallPort['prepare']>().toEqualTypeOf<
    (options: SideCallOptions) => Promise<PreparedSideCall>
  >()
  expectTypeOf<LoopSideCallPort['invoke']>().toEqualTypeOf<
    (prepared: PreparedSideCall, signal: AbortSignal) => Promise<SideCallResult>
  >()
  expectTypeOf<LoopSideCallPort['status']>().toEqualTypeOf<
    (invocationId: string) => Promise<SideCallStatus>
  >()
})

it('targets a route and model only', () => {
  expectTypeOf<SideCallTarget>().toEqualTypeOf<Readonly<{ route: string; model: string }>>()
  expectTypeOf<SideCallOptions['target']>().toEqualTypeOf<SideCallTarget>()
  expectTypeOf<SideCallOptions['label']>().toEqualTypeOf<string>()
  expectTypeOf<SideCallOptions['payload']>().toEqualTypeOf<JsonValue | undefined>()
  expectTypeOf<SideCallOptions['messages']>().toEqualTypeOf<RequestBody['messages'] | undefined>()
  expectTypeOf<SideCallOptions['sampling']>().toEqualTypeOf<RequestBody['sampling']>()
  expectTypeOf<SideCallOptions['output']>().toEqualTypeOf<'text' | 'json' | undefined>()
  expectTypeOf<SideCallOptions['deadlineMs']>().toEqualTypeOf<number | undefined>()
  expectTypeOf<SideCallOptions['invocationId']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<SideCallOptions['system']>().toEqualTypeOf<string | undefined>()
})

it('brands a prepared call so a plain object cannot stand in for one', () => {
  expectTypeOf<PreparedSideCall['invocationId']>().toEqualTypeOf<string>()
  expectTypeOf<PreparedSideCall['target']>().toEqualTypeOf<Readonly<{ route: string; model: string }>>()
  expectTypeOf<PreparedSideCall['adapter']>().toEqualTypeOf<Readonly<{
    id: string
    version: string | null
    api: string
    endpointHost: string | null
  }> | null>()
  expectTypeOf<PreparedSideCall['estimate']>().toEqualTypeOf<
    Readonly<{
      inputTokens: number
      source: 'provider' | 'estimate'
      projectedCredits: number | null
      contextWindow: number | null
    }>
  >()
  // @ts-expect-error A plain object with every visible field still lacks the brand.
  const forged: PreparedSideCall = {
    invocationId: 'side-1',
    label: 'sample.decide',
    target: { route: 'route', model: 'model' },
    adapter: null,
    deadlineMs: 1000,
    requestHash: 'hash',
    estimate: { inputTokens: 1, source: 'estimate', projectedCredits: null, contextWindow: null },
  }
  void forged
})

it('reports usage with the protocol token counts and optional vendor billing', () => {
  expectTypeOf<SideCallUsage['tokens']>().toEqualTypeOf<TokenCounts>()
  expectTypeOf<SideCallUsage['credits']>().toEqualTypeOf<number>()
  expectTypeOf<SideCallUsage['creditSource']>().toEqualTypeOf<'gateway' | 'estimated'>()
  expectTypeOf<SideCallUsage['billing']>().toEqualTypeOf<Billing | undefined>()
})

it('closes the result union over four statuses and one unknown reason', () => {
  expectTypeOf<SideCallResult['status']>().toEqualTypeOf<'ok' | 'failed' | 'unknown' | 'refused'>()
  expectTypeOf<SideCallFailure>().toEqualTypeOf<
    'deadline' | 'cancelled' | 'adapter-error' | 'invalid-output'
  >()
  expectTypeOf<Extract<SideCallResult, { status: 'unknown' }>['reason']>().toEqualTypeOf<'interrupted'>()
  expectTypeOf<Extract<SideCallResult, { status: 'refused' }>['reason']>().toEqualTypeOf<
    'budget' | 'usage-unrecorded'
  >()
  expectTypeOf<Extract<SideCallResult, { status: 'failed' }>['reason']>().toEqualTypeOf<SideCallFailure>()
  expectTypeOf<Extract<SideCallResult, { status: 'failed' }>['code']>().toEqualTypeOf<
    AiErrorCode | undefined
  >()
  expectTypeOf<Extract<SideCallResult, { status: 'failed' }>['dispatch']>().toEqualTypeOf<
    'not-sent' | 'may-have-sent'
  >()
  expectTypeOf<Extract<SideCallResult, { status: 'failed' }>['retryAfterMs']>().toEqualTypeOf<
    number | undefined
  >()
  expectTypeOf<Extract<SideCallResult, { status: 'ok' }>>().not.toHaveProperty('retryAfterMs')
  expectTypeOf<Extract<SideCallResult, { status: 'refused' }>>().not.toHaveProperty('retryAfterMs')
  expectTypeOf<Extract<SideCallResult, { status: 'ok' }>['json']>().toEqualTypeOf<JsonValue | undefined>()
  expectTypeOf<SideCallStatus['status']>().toEqualTypeOf<'absent' | 'in-flight' | 'finished'>()
  expectTypeOf<Extract<SideCallStatus, { status: 'finished' }>['result']>().toEqualTypeOf<SideCallResult>()
})

it('declares the side-call cost purpose and the optional route, adapter and endpoint host', () => {
  expectTypeOf<CostLedger['purpose']>().toExtend<string>()
  expectTypeOf<'side-call'>().toExtend<CostLedger['purpose']>()
  expectTypeOf<'approval-guardian'>().toExtend<CostLedger['purpose']>()
  expectTypeOf<CostLedger['route']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<CostLedger['adapter']>().toEqualTypeOf<{ id: string; version?: string } | undefined>()
  expectTypeOf<CostLedger['endpointHost']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<CostLedger>().not.toHaveProperty('slot')
})

it('declares the optional payload capabilities of a model adapter', () => {
  expectTypeOf<ModelAdapterCapabilities['payload']>().toEqualTypeOf<boolean | undefined>()
  expectTypeOf<ModelAdapterCapabilities['payloadOnly']>().toEqualTypeOf<boolean | undefined>()
  // The three original capabilities stay required; the new ones are optional.
  expectTypeOf<{ imageInput: false; tools: false; streaming: false }>().toExtend<ModelAdapterCapabilities>()
})
