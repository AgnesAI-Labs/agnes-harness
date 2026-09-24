import type { Action, Decision, JobSpec, JobStatus, JsonValue, Target } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expectTypeOf, it } from 'vitest'
import type {
  CapabilityReport,
  ResolvedToolCallPolicy,
  SandboxEnforcement,
  ToolContext,
  ToolDef,
  ToolMeta,
  ToolResult,
} from '../src/index.js'
import { defineTool } from '../src/index.js'

declare const json: JsonValue

describe('tool types', () => {
  it('infers args from parameters schema', () => {
    const def = defineTool({
      name: 'read_x',
      description: 'd',
      parameters: Type.Object(
        { path: Type.String(), limit: Type.Optional(Type.Integer()) },
        { additionalProperties: false },
      ),
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe',
        costHint: undefined,
        deferLoading: undefined,
        requiresApproval: undefined,
      },
      execute: async (args, ctx) => {
        expectTypeOf(args).toEqualTypeOf<{ path: string; limit?: number }>()
        expectTypeOf(ctx).toEqualTypeOf<ToolContext>()
        return { content: [{ type: 'text', text: args.path }] }
      },
    })
    expectTypeOf(def).toExtend<ToolDef>()
  })
  it('infers validated args for a synchronous dynamic policy classifier', () => {
    const def = defineTool({
      name: 'computer_use',
      description: 'd',
      parameters: Type.Object(
        { action: Type.Union([Type.Literal('capture'), Type.Literal('click')]) },
        { additionalProperties: false },
      ),
      meta: {
        isReadOnly: false,
        isDestructive: true,
        isConcurrencySafe: false,
        isOpenWorld: false,
        replay: 'never',
        costHint: undefined,
        deferLoading: undefined,
        requiresApproval: 'destructive',
      },
      policyVersion: 'v1',
      classify: (args) => {
        expectTypeOf(args).toEqualTypeOf<Readonly<{ action: 'capture' | 'click' }>>()
        return {
          isReadOnly: args.action === 'capture',
          isDestructive: args.action === 'click',
          replay: args.action === 'capture' ? 'safe' : 'never',
          requiresApproval: args.action === 'capture' ? 'never' : 'destructive',
          approvalScopes: args.action === 'capture' ? [] : ['cua:click:background'],
        }
      },
      execute: async () => ({ content: [] }),
    })
    type Classifier = NonNullable<typeof def.classify>
    expectTypeOf<Parameters<Classifier>[0]>().toEqualTypeOf<Readonly<{ action: 'capture' | 'click' }>>()
    expectTypeOf<ReturnType<Classifier>>().toEqualTypeOf<ResolvedToolCallPolicy>()
    expectTypeOf(def.policyVersion).toEqualTypeOf<string | undefined>()
  })
  it('does not allow classifiers to return host authority or transport state', () => {
    const base = {
      name: 'read_x',
      description: 'd',
      parameters: Type.Object({}, { additionalProperties: false }),
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe' as const,
        costHint: undefined,
        deferLoading: undefined,
        requiresApproval: undefined,
      },
      policyVersion: 'v1',
      execute: async () => ({ content: [] }),
    }
    defineTool({
      ...base,
      classify: (): ResolvedToolCallPolicy => ({
        isReadOnly: true,
        isDestructive: false,
        replay: 'safe',
        requiresApproval: 'never',
        approvalScopes: [],
        // @ts-expect-error execution domains are Host attestations, not classifier output
        executionDomain: 'host-computer-use',
      }),
    })
    defineTool({
      ...base,
      // @ts-expect-error policy classifiers must be synchronous
      classify: async (): Promise<ResolvedToolCallPolicy> => ({
        isReadOnly: true,
        isDestructive: false,
        replay: 'safe',
        requiresApproval: 'never',
        approvalScopes: [],
      }),
    })
  })
  it('ToolMeta requires all eight keys (no optional markers)', () => {
    expectTypeOf<keyof ToolMeta>().toEqualTypeOf<
      | 'isReadOnly'
      | 'isDestructive'
      | 'isConcurrencySafe'
      | 'isOpenWorld'
      | 'replay'
      | 'costHint'
      | 'deferLoading'
      | 'requiresApproval'
    >()
    // @ts-expect-error costHint 键不能省略——「声明无」也要显式写 undefined
    const m: ToolMeta = {
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      isOpenWorld: false,
      replay: 'safe',
      deferLoading: undefined,
      requiresApproval: undefined,
    }
    void m
  })
  it('ToolContext exposes no raw fs / child_process / fetch', () => {
    expectTypeOf<ToolContext>().not.toHaveProperty('fetch')
    expectTypeOf<ToolContext>().not.toHaveProperty('spawn')
    expectTypeOf<ToolContext['fs']>().toHaveProperty('read')
    // `tools.invoke(name, args, opts?)`：逐位断言而不是整条元组一次比——expect-type 对
    // `JsonValue`（protocol 里是 `Type.Recursive`）做元素级深比较时会把它烙成 `never`，
    // 那是断言器的递归深度表现，不是签名有问题。第二参收 JsonValue 用一次赋值直接证明。
    type InvokeParams = Parameters<ToolContext['tools']['invoke']>
    expectTypeOf<InvokeParams['length']>().toEqualTypeOf<2 | 3>()
    expectTypeOf<InvokeParams[0]>().toEqualTypeOf<string>()
    expectTypeOf<InvokeParams[2]>().toEqualTypeOf<{ signal?: AbortSignal } | undefined>()
    const args: InvokeParams[1] = json
    void args
    // 拍板 Q1（2026-09-08）：沙箱经 confine 暴露；拍板 D4（2026-09-15）：再加只读 enforcement，此外没有别的沙箱开口。
    // 拍板 Q2：ctx 上没有 harness 成员
    expectTypeOf<ToolContext['sandbox']['confine']>().toExtend<(argv: string[]) => Promise<string[]>>()
    expectTypeOf<keyof ToolContext['sandbox']>().toEqualTypeOf<'confine' | 'enforcement'>()
    expectTypeOf<ToolContext>().not.toHaveProperty('harness')
    expectTypeOf<ToolResult['content'][number]>().toExtend<{ type: 'text' | 'image' | 'ref' }>()
  })
  it('ToolResult.structured is an optional machine-readable payload (ERRATA B16)', () => {
    const withStructured: ToolResult = { content: [], structured: { ok: true } }
    const withoutStructured: ToolResult = { content: [] }
    void [withStructured, withoutStructured]
    expectTypeOf<ToolResult>().toHaveProperty('structured')
    expectTypeOf<ToolResult['structured']>().toEqualTypeOf<unknown>()
  })
  it('subagent.spawn opts accepts cwd alongside model / isolation / budget', () => {
    type SpawnOpts = NonNullable<Parameters<ToolContext['subagent']['spawn']>[1]>
    expectTypeOf<SpawnOpts['cwd']>().toEqualTypeOf<string | undefined>()
    const opts: SpawnOpts = { cwd: '/fixture' }
    void opts
  })
  it('pins the exact key set: nine seam windows plus kernel facilities, nothing else (spec §6.1)', () => {
    expectTypeOf<keyof ToolContext>().toEqualTypeOf<
      | 'skillInstall'
      | 'mcpManage'
      | 'pluginManage'
      | 'projections'
      | 'session'
      | 'actor'
      | 'cwd'
      | 'exec'
      | 'fs'
      | 'net'
      | 'sandbox'
      | 'platform'
      | 'authorize'
      | 'tools'
      | 'runtime'
      | 'artifacts'
      | 'subagent'
      | 'plan'
      | 'requestCompaction'
      | 'progress'
      | 'signal'
      | 'timeoutMs'
      | 'lease'
      | 'log'
    >()
    expectTypeOf<ToolContext['platform']['shell']>().toEqualTypeOf<'posix' | 'powershell'>()
    expectTypeOf<ReturnType<ToolContext['platform']['capability']>>().toEqualTypeOf<CapabilityReport>()
    expectTypeOf<ReturnType<ToolContext['sandbox']['enforcement']>>().toEqualTypeOf<SandboxEnforcement>()
  })
})

describe('protocol jobs reattachment', () => {
  it('keeps generated payload/status and lets only core supply session identity and schedule defaults', () => {
    type Submit = Parameters<ToolContext['artifacts']['submitJob']>[0]
    expectTypeOf<Submit>().not.toHaveProperty('sessionKey')
    expectTypeOf<Submit['schedule']>().toEqualTypeOf<JobSpec['schedule'] | undefined>()
    expectTypeOf<Awaited<ReturnType<ToolContext['artifacts']['poll']>>>().toEqualTypeOf<JobStatus>()
    const payload: Submit['payload'] = { kind: 'shell', command: 'printf fixture', cwd: '/fixture' }
    const spec: Submit = { idempotencyKey: 'fixture', payload }
    void spec
    // @ts-expect-error unknown payload cannot be smuggled through the former JsonValue placeholder
    const invalid: Submit = { idempotencyKey: 'fixture', payload: { kind: 'invented' } }
    void invalid
  })
})

describe('protocol authz reattachment', () => {
  it('exposes the generated action, target and structured decision', () => {
    expectTypeOf<Parameters<ToolContext['authorize']>[0]>().toEqualTypeOf<Action>()
    expectTypeOf<Parameters<ToolContext['authorize']>[1]>().toEqualTypeOf<Target>()
    expectTypeOf<Awaited<ReturnType<ToolContext['authorize']>>>().toEqualTypeOf<Decision>()
    // @ts-expect-error Target is closed over the defined resource kinds, not arbitrary JsonValue
    const target: Target = { kind: 'unknown', id: 'fixture' }
    // @ts-expect-error a decision cannot omit its reason
    const decision: Decision = { decisionId: 'fixture', effect: 'allow' }
    void target
    void decision
  })
})
