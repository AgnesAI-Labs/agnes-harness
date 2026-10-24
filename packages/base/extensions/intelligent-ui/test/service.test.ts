import type { ToolDef } from '@agnes/extension-api'
import type { ExtensionAPI } from '@agnes/extension-api/host'
import type {
  IntelligentUiCapabilities,
  IntelligentUiInstance,
  UiSourceResolveInput,
  UiSourceResolveResult,
} from '@agnes/intelligent-ui-contract'
import { extensionFactoryOf } from '@agnes/plugin-runtime/bundled'
import type {
  DeferredInvocationReceipt,
  DeferredToolInvocation,
  DeferredToolInvocationQueue,
} from '@agnes/plugin-runtime/deferred-contract'
import {
  type Actor,
  type EventEnvelope,
  jcs,
  rpcError,
  type UiActionParams,
  type UiSourceStatus,
  type UiSurface,
  validateAgainst,
} from '@agnes/protocol'
import { UiCloseParams, UiRenderParams, UiUpdateParams } from '@agnes/protocol/gen/intelligent-ui'
import { surfaceText, validIntelligentSurface } from '@agnes/protocol/intelligent-ui'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'
import { questionSurface } from '../../interaction/src/question.js'
import { validateActionParameterNames } from '../src/action-parameters.js'
import intelligentUi from '../src/index.js'
import { reachableParameters } from '../src/parameters.js'
import { createIntelligentUiService } from '../src/service.js'
import { uiProjection } from '../src/state.js'
import { bindArguments } from '../src/validation.js'

const actor: Actor = { id: 'operator', org: 'synthetic', role: 'owner', deptPath: [], attrs: {} }
const signal = new AbortController().signal
const parameters = Type.Object(
  {
    amount: Type.Number(),
    reason: Type.String({ minLength: 1 }),
    rows: Type.Union([
      Type.Array(Type.Object({ id: Type.String(), amount: Type.Number() })),
      Type.Object({ id: Type.String(), amount: Type.Number() }),
      Type.String(),
    ]),
  },
  { additionalProperties: false },
)
const surface = (): UiSurface => ({
  id: 'reconcile',
  revision: 1,
  title: 'Differences',
  placement: { inline: true, workbench: true },
  data: {
    rows: [{ id: 'a', amount: 12 }],
    chart: [{ label: 'a', amount: 12 }],
    form: { amount: 12, reason: 'reviewed' },
    status: 'Review adjustments',
  },
  components: [
    {
      id: 'differences',
      kind: 'table',
      dataKey: 'rows',
      rowKey: 'id',
      columns: [
        { key: 'id', label: 'Id' },
        { key: 'amount', label: 'Amount' },
      ],
      selection: 'multiple',
      rowActionIds: ['confirm'],
    },
    {
      id: 'amounts',
      kind: 'chart',
      chartType: 'bar',
      dataKey: 'chart',
      categoryKey: 'label',
      series: [{ key: 'amount', label: 'Amount' }],
    },
    {
      id: 'adjustment',
      kind: 'form',
      dataKey: 'form',
      schema: {
        type: 'object',
        required: ['amount', 'reason'],
        properties: { amount: { type: 'number' }, reason: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
      actionIds: ['confirm'],
    },
    { id: 'controls', kind: 'button-group', actionIds: ['confirm'] },
    { id: 'summary', kind: 'status', dataKey: 'status' },
  ],
  actions: [
    {
      id: 'confirm',
      label: 'Confirm',
      tool: 'adjust',
      confirm: 'Confirm adjustment?',
      argsTemplate: {
        amount: { from: 'input', key: 'adjustment', pointer: '/amount' },
        reason: { from: 'input', key: 'adjustment', pointer: '/reason' },
        rows: { from: 'selection', key: 'differences' },
      },
      paramsSchema: {
        type: 'object',
        required: ['amount', 'reason', 'rows'],
        properties: { amount: { type: 'number' }, reason: { type: 'string' }, rows: { type: 'array' } },
        additionalProperties: false,
      },
    },
  ],
})
const request = (commandId = 'one'): UiActionParams => ({
  sessionId: 'session',
  surfaceId: 'reconcile',
  revision: 1,
  actionId: 'confirm',
  commandId,
  input: { adjustment: { amount: 12, reason: 'reviewed' } },
  selection: { differences: ['a'] },
  confirmed: true,
})
function fixture(
  components: readonly import('@agnes/protocol/gen/extension-manifest').UiComponentDeclaration[] = [],
  collector = false,
  additionalTools: readonly Pick<ToolDef, 'name' | 'parameters'>[] = [],
) {
  const rows: EventEnvelope[] = [],
    calls = new Map<string, DeferredInvocationReceipt>(),
    deliveries = new Map<string, number>()
  let checker: IntelligentUiCapabilities['checkArtifact'] = async () => 'not_found'
  let service: IntelligentUiInstance,
    available = true,
    deferredSupported = true,
    now = 100000,
    lostWake = false,
    failDelivery = false,
    failAdmission = false,
    scans = 0,
    invocation: string | undefined,
    admitted: Actor | undefined = actor,
    resolver: ((input: UiSourceResolveInput) => Promise<UiSourceResolveResult>) | undefined
  const row = (name: string, data: unknown, origin = 'ext:agnes/intelligent-ui') => {
    const seq = rows.length + 1
    rows.push({
      seq,
      id: `row-${seq}`,
      ts: new Date(now).toISOString(),
      type: `x/agnes/intelligent-ui/${name}`,
      data: JSON.parse(jcs(data)),
      actor,
      origin,
      trust: 'untrusted',
      lane: 'main',
      ignorable: true,
    })
    return seq
  }
  const queue: DeferredToolInvocationQueue = {
    sessionKey: 'session',
    lane: 'main',
    async enqueue(invocation, signal) {
      if (failAdmission) throw new Error('admission unavailable')
      const old = calls.get(invocation.id)
      if (old) {
        if (jcs(old.invocation) !== jcs(invocation)) throw new Error('conflict')
        return old
      }
      await service.validate(invocation, signal)
      const receipt: DeferredInvocationReceipt = {
        invocation,
        state: 'queued',
        seq: row('queue', { invocation }),
      }
      calls.set(invocation.id, receipt)
      if (lostWake) throw new Error('wake lost after durable admission')
      return receipt
    },
    async next() {
      return [...calls.values()].find((item) => !['succeeded', 'failed'].includes(item.state)) ?? null
    },
    async read(id) {
      return calls.get(id) ?? null
    },
    async transition(id, _seq, state, outcome = {}) {
      const old = calls.get(id)!
      const receipt = { ...old, ...outcome, state, seq: row('queue', { id, state }) }
      calls.set(id, receipt)
      return receipt
    },
    async notify(signal) {
      for (const receipt of calls.values()) await service.changed(receipt, signal)
    },
  }
  const tools = () => [
    ...additionalTools,
    ...(available
      ? [
          {
            name: collector ? 'ui_submit' : 'adjust',
            parameters: collector
              ? Type.Object(
                  {
                    surfaceId: Type.String(),
                    answers: Type.Record(
                      Type.String(),
                      Type.Union([Type.String(), Type.Array(Type.String())]),
                    ),
                  },
                  { additionalProperties: false },
                )
              : parameters,
          },
        ]
      : []),
  ]
  const restart = () =>
    (service = createIntelligentUiService({
      binding: {
        owner: 'agnes/intelligent-ui',
        packageId: '@agnes/base',
        session: { key: 'session', lane: 'main', workspaceRoot: '/synthetic' },
        signal,
      },
      get lastSeq() {
        return rows.length
      },
      ledger: {
        async scanOwn(query) {
          scans++
          const names = new Set(query.names)
          return {
            events: rows.filter(
              (item) =>
                names.has(item.type.slice('x/agnes/intelligent-ui/'.length)) &&
                item.origin === 'ext:agnes/intelligent-ui' &&
                item.trust === 'untrusted' &&
                item.lane === 'main',
            ),
            asOfSeq: rows.length,
          }
        },
        async appendOwn(name, data) {
          return row(name, data)
        },
      },
      input: {
        async deliver(key, system, deliverSignal) {
          deliverSignal.throwIfAborted()
          if (failDelivery) throw new Error('delivery interrupted')
          const commandId = key.startsWith('ui-result:') ? key.slice('ui-result:'.length) : ''
          const matched = [...rows].reverse().find((item) => {
            if (item.type !== 'x/agnes/intelligent-ui/action.received') return false
            if (item.origin !== 'ext:agnes/intelligent-ui' || item.trust !== 'untrusted') return false
            const record = (item.data as { record?: { request?: { commandId?: string }; actor?: Actor } })
              .record
            return record?.request?.commandId === commandId && !!record.actor?.id && !!record.actor.org
          })
          const deliveredActor = (matched?.data as { record?: { actor?: Actor } } | undefined)?.record?.actor
          if (!deliveredActor) throw new Error('missing action actor')
          if (!deliveries.has(key))
            deliveries.set(
              key,
              row('inbox', {
                key,
                system: { ...system, source: 'agnes/intelligent-ui' },
                actor: deliveredActor,
              }),
            )
          return deliveries.get(key)!
        },
      },
      capabilities: {
        checkArtifact: (ref, signal) => checker!(ref, signal),
        taskId: () => 'task',
        get supportsDeferredInvocations() {
          return deferredSupported
        },
        components: () => components,
        queue,
        tools,
        invocationId: async (toolUseId) => (toolUseId === 'collector-call' ? invocation : undefined),
        get authenticatedActor() {
          return admitted
        },
        get resolveSources() {
          return resolver
        },
      },
      now: () => now,
    }))
  restart()
  return {
    rows,
    scans: () => scans,
    checkArtifact: (value: NonNullable<IntelligentUiCapabilities['checkArtifact']>) => {
      checker = value
    },
    calls,
    bindInvocation: (id: string) => (invocation = id),
    deliveries,
    queue,
    restart,
    service: () => service,
    admit: (value?: Actor) => {
      admitted = value
    },
    row,
    deferredSupported: (value: boolean) => {
      deferredSupported = value
    },
    tool: (value: boolean) => (available = value),
    clock: (value: number) => (now = value),
    wakeFail: (value: boolean) => (lostWake = value),
    deliveryFail: (value: boolean) => (failDelivery = value),
    admissionFail: (value: boolean) => (failAdmission = value),
    source: (value: (input: UiSourceResolveInput) => Promise<UiSourceResolveResult>) => {
      resolver = value
    },
    async outcome(state: DeferredInvocationReceipt['state'], error?: DeferredInvocationReceipt['error']) {
      const old = [...calls.values()].at(-1)!
      const seq = row('queue', { state })
      const receipt: DeferredInvocationReceipt = {
        ...old,
        state,
        seq,
        ...(state === 'pending-approval' ? { approvalId: 'original-ticket' } : {}),
        ...(state === 'succeeded'
          ? {
              resultSeq: row('tool-result', {}),
              result: { content: [{ type: 'text', text: 'Adjustment recorded' }] },
            }
          : {}),
        ...(error ? { error } : {}),
      }
      calls.set(old.invocation.id, receipt)
      await service.changed(receipt, signal)
    },
  }
}
async function opened() {
  const f = fixture()
  await f.service().render({ surface: surface() }, signal)
  return f
}

describe('preset surface contract and ledger lifecycle', () => {
  it('offers compact UI tools, loads full contracts on demand and keeps nested execution validation', async () => {
    const tools: ToolDef[] = []
    const f = fixture()
    extensionFactoryOf(intelligentUi)({
      providers: { register: () => () => {}, bindOwn: async () => f.service() },
      registerProjection: () => () => {},
      registerTool: (tool: ToolDef) => {
        tools.push(tool)
        return () => {}
      },
    } as unknown as ExtensionAPI)
    expect(tools.map((tool) => tool.name)).toEqual([
      'ui_guide',
      'ui_render',
      'ui_update',
      'ui_close',
      'ui_submit',
    ])
    expect(tools.filter((tool) => tool.meta.deferLoading === false).map((tool) => tool.name)).toEqual([
      'ui_guide',
      'ui_render',
      'ui_update',
      'ui_close',
    ])
    const ctx = fakeToolContext()
    ctx.tools.list = () => tools
    const guide = tools.find((tool) => tool.name === 'ui_guide')!
    for (const operation of ['render', 'update']) {
      const result = await guide.execute({ operation }, ctx)
      const text = (result.content[0] as { text: string }).text
      for (const contract of [
        'table:',
        'rowKey',
        'chart:',
        'categoryKey',
        'form:',
        'schema',
        'surface.data[component.dataKey]',
        'No invented refs',
        'No remote URLs',
        'exact fallback',
      ])
        expect(text).toContain(contract)
      const full = JSON.parse(text.split('Parameters: ')[1]!)
      expect(full.required).toContain('surface')
      expect(full.properties.surface).toBeDefined()
      expect(JSON.stringify(full.$defs)).toContain('chartType')
      expect(JSON.stringify(full.$defs)).toContain('paramsSchema')
    }
    for (const name of ['ui_render', 'ui_update']) {
      const tool = tools.find((tool) => tool.name === name)!
      expect(tool.description).toContain('ui_guide')
      expect(
        Buffer.byteLength(JSON.stringify(tool.parameters)) + Buffer.byteLength(tool.description),
      ).toBeLessThan(1500)
      expect(JSON.stringify(tool.parameters)).not.toContain('$defs')
    }
    const replacement = { ...surface(), revision: 2 }
    const pointerRoot = reachableParameters({ ...UiRenderParams, $ref: '#/$defs/UiRenderParams' })
    expect(pointerRoot).toMatchObject({ type: 'object' })
    expect(validateAgainst(pointerRoot, { surface: surface() }).ok).toBe(true)
    const rows = [
      { schema: UiRenderParams, good: { surface: surface() } },
      { schema: UiUpdateParams, good: { surfaceId: 'reconcile', expectedRevision: 1, surface: replacement } },
      { schema: UiCloseParams, good: { surfaceId: 'reconcile', expectedRevision: 1 } },
    ]
    for (const { schema, good } of rows) {
      const compact = reachableParameters(schema)
      expect(validateAgainst(compact, good).ok).toBe(true)
      expect(Value.Check(compact, Object.values(compact.$defs), good)).toBe(true)
      for (const invalid of [
        {},
        { ...good, unexpected: true },
        { ...good, surfaceId: 'invalid key!' },
        { ...good, surface: { ...surface(), components: [{ id: 'unsafe', kind: 'html' }] } },
      ]) {
        expect(validateAgainst(compact, invalid).ok).toBe(false)
        expect(validateAgainst(schema, invalid).ok).toBe(false)
      }
      expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(schema).length)
    }
    for (const name of ['ui_render', 'ui_update', 'ui_close']) {
      const result = await tools.find((tool) => tool.name === name)!.execute({}, ctx)
      expect(result).toMatchObject({
        isError: true,
        structured: {
          code: 'UI_INVALID',
          effect: 'none',
          issues: expect.arrayContaining([
            { path: expect.stringMatching(/^\//), expected: expect.any(String) },
          ]),
        },
      })
      expect(result.content[0]).toMatchObject({
        type: 'text',
        text: expect.stringContaining('Correct the input and retry'),
      })
    }
    const invalid = { ...surface(), data: { ...surface().data, status: { label: 'Ready' } } }
    const invalidResult = await tools
      .find((tool) => tool.name === 'ui_render')!
      .execute({ surface: invalid }, ctx)
    expect(invalidResult).toMatchObject({
      isError: true,
      structured: { issues: [{ path: '/surface/data/status', expected: expect.stringContaining('string') }] },
    })
    for (const badKey of ['form', 'differences', 'summary']) {
      const bad = surface()
      bad.actions[0]!.argsTemplate.amount = { from: 'input', key: badKey }
      expect(
        await tools.find((tool) => tool.name === 'ui_render')!.execute({ surface: bad }, ctx),
      ).toMatchObject({
        isError: true,
        structured: {
          effect: 'none',
          issues: [
            {
              path: '/surface/actions/0/argsTemplate/amount/key',
              expected: expect.stringContaining(`"${badKey}"`),
            },
          ],
        },
      })
      const result = await tools.find((tool) => tool.name === 'ui_render')!.execute({ surface: bad }, ctx)
      expect(JSON.stringify(result)).toContain('adjustment')
    }
    const wrongArgument = surface()
    const template = wrongArgument.actions[0]!.argsTemplate
    template.values = template.amount!
    delete template.amount
    expect(
      await tools.find((tool) => tool.name === 'ui_render')!.execute({ surface: wrongArgument }, ctx),
    ).toMatchObject({
      isError: true,
      structured: {
        effect: 'none',
        issues: expect.arrayContaining([
          {
            path: '/surface/actions/0/argsTemplate/values',
            expected: expect.stringContaining('adjust'),
          },
        ]),
      },
    })
    expect((await f.service().read({ sessionId: 'session' }, signal)).surfaces).toEqual([])
    // Stateful failures and cancellation still propagate; they do not carry the private rejection marker.
    await expect(
      tools
        .find((tool) => tool.name === 'ui_update')!
        .execute({ surfaceId: 'reconcile', expectedRevision: 1, surface: replacement }, ctx),
    ).rejects.toMatchObject({ data: { code: 'UI_STALE' } })
    const submit = tools.find((tool) => tool.name === 'ui_submit')!.parameters
    expect(validateAgainst(submit, { surfaceId: 'reconcile', answers: { choice: 'yes' } }).ok).toBe(true)
    expect(validateAgainst(submit, { surfaceId: 'reconcile', answers: { choice: 42 } }).ok).toBe(false)
  })
  it('retains a root definition reached recursively after inlining', () => {
    const schema = Type.Module({
      Node: Type.Object({ value: Type.String(), child: Type.Optional(Type.Ref('Node')) }),
      Unused: Type.Number(),
    }).Import('Node')
    const compact = reachableParameters(schema)
    expect(compact.type).toBe('object')
    expect(Object.keys(compact.$defs)).toEqual(['Node'])
    expect(validateAgainst(compact, { value: 'a', child: { value: 'b' } }).ok).toBe(true)
    expect(validateAgainst(compact, { value: 'a', child: { value: 42 } }).ok).toBe(false)
    // Render validates names, not the not-yet-submitted values; records and alternatives remain valid.
    expect(() =>
      validateActionParameterNames(schema, { value: {}, child: {} }, '/args', 'recursive'),
    ).not.toThrow()
    expect(() =>
      validateActionParameterNames(
        Type.Record(Type.String(), Type.Number()),
        { dynamic: {} },
        '/args',
        'record',
      ),
    ).not.toThrow()
    const union = Type.Union([
      Type.Object({ left: Type.String() }, { additionalProperties: false }),
      Type.Object({ right: Type.Number() }, { additionalProperties: false }),
    ])
    expect(() => validateActionParameterNames(union, { right: {} }, '/args', 'union')).not.toThrow()
    expect(() => validateActionParameterNames(union, { unknown: {} }, '/args', 'union')).toThrow()
  })
  it('opens, replaces revision n+1, closes and retains a tombstone across restart', async () => {
    const f = await opened(),
      first = (await f.service().read({ sessionId: 'session' }, signal)).surfaces[0]!
    expect(first).toMatchObject({
      status: 'open',
      owner: 'agnes/intelligent-ui',
      lane: 'main',
      taskId: 'task',
    })
    const updated = surface()
    updated.revision = 2
    updated.data.status = 'Finished'
    await f.service().update({ surfaceId: 'reconcile', expectedRevision: 1, surface: updated }, signal)
    await f.service().close({ surfaceId: 'reconcile', expectedRevision: 2 }, signal)
    const before = f.rows.length
    await f.service().close({ surfaceId: 'reconcile', expectedRevision: 2 }, signal)
    expect(f.rows).toHaveLength(before)
    f.restart()
    expect(
      (await f.service().read({ sessionId: 'session', surfaceId: 'reconcile' }, signal)).surfaces[0],
    ).toMatchObject({
      status: 'closed',
      surface: { revision: 2 },
    })
    await expect(f.service().render({ surface: surface() }, signal)).rejects.toMatchObject({
      data: { code: 'UI_STALE' },
    })
  })
  it('records received, executing, original approval, success and one SC1 delivery', async () => {
    const f = await opened()
    expect(await f.service().action(request(), actor, signal)).toMatchObject({ status: 'received' })
    expect([...f.calls.values()][0]!.invocation.args).toEqual({
      amount: 12,
      reason: 'reviewed',
      rows: [{ id: 'a', amount: 12 }],
    })
    await f.outcome('executing')
    await f.outcome('pending-approval')
    f.restart()
    expect((await f.service().read({ sessionId: 'session' }, signal)).actions[0]).toMatchObject({
      status: 'pending-approval',
      approvalId: 'original-ticket',
    })
    await f.outcome('executing')
    await f.outcome('succeeded')
    const duplicate = await f.service().action(request(), actor, signal)
    expect(duplicate).toMatchObject({ status: 'succeeded', duplicate: true, resultSeq: expect.any(Number) })
    expect(f.deliveries.size).toBe(1)
    expect(f.calls.size).toBe(1)
    expect(f.rows.filter((row) => row.type.endsWith('action.executing'))).toHaveLength(2)
  })
  it.each(['invalid', 'stale', 'closed', 'unauthorized'] as const)(
    'persists typed refusal %s and delivers it',
    async (reason) => {
      const f = await opened(),
        req = request()
      if (reason === 'invalid') req.selection = { differences: ['forged-row'] }
      if (reason === 'stale') req.revision = 2
      if (reason === 'closed')
        await f.service().close({ surfaceId: 'reconcile', expectedRevision: 1 }, signal)
      if (reason === 'unauthorized') {
        const open = f.rows.find((row) => row.type.endsWith('surface.opened'))!
        ;(open.data as any).record.owner = 'another-plugin'
      }
      const receipt = await f.service().action(req, actor, signal)
      expect(receipt).toMatchObject({ status: 'rejected', refusal: { reason } })
      expect(f.calls.size).toBe(0)
      expect(f.deliveries.size).toBe(1)
      expect(f.rows.some((row) => row.type.endsWith('action.received'))).toBe(true)
    },
  )
  it('dedupes before stale/quota, refuses a changed command binding and cross-session access', async () => {
    const f = await opened()
    await f.service().action(request(), actor, signal)
    await f.outcome('executing')
    await f.outcome('succeeded')
    const next = surface()
    next.revision = 2
    await f.service().update({ surfaceId: 'reconcile', expectedRevision: 1, surface: next }, signal)
    expect(await f.service().action(request(), actor, signal)).toMatchObject({
      duplicate: true,
      status: 'succeeded',
    })
    await expect(f.service().action({ ...request(), revision: 2 }, actor, signal)).rejects.toMatchObject({
      data: { code: 'UI_COMMAND_CONFLICT' },
    })
    await expect(
      f.service().action({ ...request(), sessionId: 'other' }, actor, signal),
    ).rejects.toMatchObject({ code: expect.any(Number) })
    const changedActor = { ...actor, role: 'admin' }
    f.admit(changedActor)
    await expect(f.service().action(request(), changedActor, signal)).rejects.toMatchObject({
      data: { code: 'UI_COMMAND_CONFLICT' },
    })
    expect(f.calls.size).toBe(1)
  })
  it.each(['HOOK_DENIED', 'AUTHZ_DENIED', 'POLICY_DENIED', 'APPROVAL_REJECTED', 'SANDBOX_UNAVAILABLE'])(
    'reuses backend denial %s as unauthorized',
    async (code) => {
      const f = await opened()
      await f.service().action(request(), actor, signal)
      await f.outcome('failed', { code, message: 'Denied', outcomeUnknown: false, retryable: true })
      expect((await f.service().read({ sessionId: 'session' }, signal)).actions[0]).toMatchObject({
        status: 'rejected',
        refusal: { reason: 'unauthorized' },
      })
    },
  )
  it('refuses update/close while approval or uncertain execution is pending', async () => {
    const f = await opened()
    await f.service().action(request(), actor, signal)
    await f.outcome('pending-approval')
    const next = surface()
    next.revision = 2
    await expect(
      f.service().update({ surfaceId: 'reconcile', expectedRevision: 1, surface: next }, signal),
    ).rejects.toMatchObject({ data: { code: 'UI_BUSY' } })
    await expect(
      f.service().close({ surfaceId: 'reconcile', expectedRevision: 1 }, signal),
    ).rejects.toMatchObject({ data: { code: 'UI_BUSY' } })
    await f.outcome('failed', {
      code: 'DEFERRED_OUTCOME_UNKNOWN',
      message: 'Reconcile first',
      retryable: false,
      outcomeUnknown: true,
    })
    expect(await f.service().action({ ...request('retry'), retryOf: 'one' }, actor, signal)).toMatchObject({
      status: 'rejected',
      refusal: { reason: 'invalid' },
    })
    await expect(
      f.service().close({ surfaceId: 'reconcile', expectedRevision: 1 }, signal),
    ).rejects.toMatchObject({ data: { code: 'UI_BUSY' } })
  })
  it('retries a known not-dispatched failure with a new command and revalidates bindings', async () => {
    const f = await opened()
    await f.service().action(request(), actor, signal)
    await f.outcome('failed', {
      code: 'TOOL_DISPATCH_NOT_SENT',
      message: 'Not dispatched',
      retryable: true,
      outcomeUnknown: false,
    })
    expect(await f.service().action({ ...request('retry'), retryOf: 'one' }, actor, signal)).toMatchObject({
      status: 'received',
      retryOf: 'one',
    })
    expect(f.calls.size).toBe(2)
    expect(f.rows.some((row) => row.type.endsWith('action.retried'))).toBe(true)
  })
  it('repairs received-before-queue and terminal-before-delivery crash windows without repeating effects', async () => {
    const f = await opened()
    f.wakeFail(true)
    await f.service().action(request(), actor, signal)
    f.restart()
    f.wakeFail(false)
    await f.service().read({ sessionId: 'session' }, signal)
    expect(f.calls.size).toBe(1)
    f.deliveryFail(true)
    await expect(f.outcome('succeeded')).rejects.toThrow('delivery interrupted')
    f.restart()
    f.deliveryFail(false)
    await f.service().read({ sessionId: 'session' }, signal)
    expect(f.deliveries.size).toBe(1)
    expect(f.calls.size).toBe(1)
  })
  it('records safe failure when queue admission fails and does not replay it on read', async () => {
    const f = await opened()
    f.admissionFail(true)
    expect(await f.service().action(request(), actor, signal)).toMatchObject({
      status: 'failed',
      failure: { retryable: true, outcomeUnknown: false },
    })
    f.restart()
    f.admissionFail(false)
    await f.service().read({ sessionId: 'session' }, signal)
    expect(f.calls.size).toBe(0)
  })
  it('folds once for a read that repairs nothing and returns the repaired state after recovery', async () => {
    const f = await opened()
    const scans = f.scans()
    const quiet = await f.service().read({ sessionId: 'session' }, signal)
    expect(f.scans() - scans).toBe(1)
    expect(quiet).toMatchObject({ lastSeq: f.rows.length, surfaces: [{ status: 'open' }], actions: [] })
    // An action that crashed between admission and its refusal is settled by the next read.
    f.row('action.received', {
      record: {
        request: request('crashed'),
        actor,
        receivedAt: 100000,
        receivedSeq: 0,
        receipt: {
          sessionId: 'session',
          surfaceId: 'reconcile',
          revision: 1,
          actionId: 'confirm',
          commandId: 'crashed',
          status: 'received',
          seq: 1,
          duplicate: false,
        },
      },
    })
    const repaired = await f.service().read({ sessionId: 'session' }, signal)
    const rejected = f.rows.find((row) => row.type === 'x/agnes/intelligent-ui/action.rejected')
    expect(repaired.lastSeq).toBe(f.rows.length)
    expect(repaired.actions).toEqual([
      expect.objectContaining({
        commandId: 'crashed',
        status: 'rejected',
        seq: rejected?.seq,
        refusal: expect.any(Object),
      }),
    ])
    expect(f.deliveries.size).toBe(1)
  })
  it('enforces data-only schemas, depth, malformed params, row identity and the durable rolling rate', async () => {
    const f = await opened()
    await expect(
      f.service().action({ ...request(), tool: 'bypass' } as UiActionParams, actor, signal),
    ).rejects.toBeDefined()
    const foreign = surface()
    foreign.id = 'other'
    foreign.actions[0]!.paramsSchema = { $ref: 'https://bad.invalid/schema' }
    await expect(f.service().render({ surface: foreign }, signal)).rejects.toBeDefined()
    const badSurfaces = [surface(), surface(), surface(), surface()]
    badSurfaces[0]!.data.rows = [{ id: 'a' }]
    badSurfaces[1]!.data.chart = [{ label: 1, amount: 12 }]
    for (const [index, candidate] of badSurfaces.entries()) {
      candidate.id = 'invalid' + index
      const chart = candidate.components.find((item) => item.kind === 'chart')!
      if ('fallback' in chart || chart.kind !== 'chart') throw new Error('missing chart')
      if (index >= 2) chart.chartType = 'pie'
      if (index === 2) chart.series.push({ key: 'second', label: 'second' })
      if (index === 3) candidate.data.chart = [{ label: 'a', amount: -1 }]
      expect(validIntelligentSurface(candidate)).toBe(false)
      await expect(f.service().render({ surface: candidate }, signal)).rejects.toBeDefined()
    }
    expect(
      (await f.service().read({ sessionId: 'session' }, signal)).surfaces.map((item) => item.surface.id),
    ).toEqual(['reconcile'])
    for (let i = 0; i < 30; i++)
      await f.service().action({ ...request('bad' + i), revision: 99 }, actor, signal)
    await expect(f.service().action(request('limit'), actor, signal)).rejects.toMatchObject({
      data: { code: 'UI_RATE_LIMIT' },
    })
    f.clock(161000)
    expect(await f.service().action(request('limit'), actor, signal)).toMatchObject({ status: 'received' })
  })
  it('binds cursor pages to a snapshot, filters and expiry without repeating receipts', async () => {
    const f = await opened()
    const second = surface()
    second.id = 'second'
    await f.service().render({ surface: second }, signal)
    await f.service().action(request(), actor, signal)
    const first = await f.service().read({ sessionId: 'session', limit: 1 }, signal)
    expect(first.nextCursor).toBeDefined()
    if (!first.nextCursor) throw new Error('Expected a next-page cursor')
    expect(first.actions).toHaveLength(1)
    const updated = surface()
    updated.id = 'second'
    updated.revision = 2
    await f.service().update({ surfaceId: 'second', expectedRevision: 1, surface: updated }, signal)
    const next = await f.service().read({ sessionId: 'session', limit: 1, cursor: first.nextCursor }, signal)
    expect(next.lastSeq).toBe(first.lastSeq)
    expect(next.surfaces[0]?.surface.revision).toBe(1)
    expect(next.actions).toEqual([])
    for (const params of [{ surfaceId: 'second' }, { limit: 2 }, { cursor: first.nextCursor + 'x' }])
      await expect(
        f.service().read({ sessionId: 'session', limit: 1, cursor: first.nextCursor, ...params }, signal),
      ).rejects.toMatchObject({ data: { code: 'INVALID_PARAMS' } })
    f.clock(161000)
    await expect(
      f.service().read({ sessionId: 'session', limit: 1, cursor: first.nextCursor }, signal),
    ).rejects.toMatchObject({ data: { code: 'INVALID_PARAMS' } })
  })
  it('releases closed view capacity while preserving historical identity after restart', async () => {
    const f = fixture()
    for (let i = 0; i < 20; i++) {
      const view = surface()
      view.id = 'view' + i
      view.data.status = 'x'.repeat(28000)
      await f.service().render({ surface: view }, signal)
      await f.service().close({ surfaceId: view.id, expectedRevision: 1 }, signal)
    }
    f.restart()
    let projected = uiProjection.init()
    for (const row of f.rows) projected = uiProjection.apply(projected, row)
    expect(projected).toMatchObject({ surfaces: {} })
    expect((await f.service().read({ sessionId: 'session' }, signal)).surfaces).toEqual([])
    expect(
      (await f.service().read({ sessionId: 'session', surfaceId: 'view0' }, signal)).surfaces[0]?.status,
    ).toBe('closed')
    const duplicate = surface()
    duplicate.id = 'view0'
    await expect(f.service().render({ surface: duplicate }, signal)).rejects.toMatchObject({
      data: { code: 'UI_STALE' },
    })
    await f.service().render({ surface: surface() }, signal)
    expect((await f.service().read({ sessionId: 'session' }, signal)).surfaces).toHaveLength(1)
  })
  it('projection uses ledger provenance and sequence stamps rather than caller facts', async () => {
    const f = await opened()
    await f.service().action(request(), actor, signal)
    await f.outcome('succeeded')
    let projected = uiProjection.init()
    for (const row of f.rows) projected = uiProjection.apply(projected, row)
    expect(projected).toMatchObject({
      surfaces: { reconcile: { status: 'open' } },
      actions: { one: { receipt: { status: 'succeeded' } } },
    })
    const forged = { ...f.rows[0]!, origin: 'principal' }
    expect(uiProjection.apply(uiProjection.init(), forged)).toEqual(uiProjection.init())
  })
})

describe('pinned custom component declarations', () => {
  const declaration = {
    kind: 'finance/reconcile/diff@1',
    propsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['amount'],
      properties: { amount: { type: 'integer' } },
    },
    maxPropsBytes: 256,
    fallback: 'Review the preset table.',
    accessibility: { label: 'Reconciliation differences', keyboard: true as const },
  }
  const customSurface = (): UiSurface => ({
    ...surface(),
    components: [
      ...surface().components,
      {
        id: 'custom',
        kind: declaration.kind,
        dataKey: 'custom',
        fallback: declaration.fallback,
        actionIds: ['confirm'],
      },
    ],
    data: { ...surface().data, custom: { amount: 12 } },
  })
  it('refuses undeclared kinds and invalid props before writing any surface fact', async () => {
    const undeclared = fixture()
    await expect(undeclared.service().render({ surface: customSurface() }, signal)).rejects.toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })
    const declared = fixture([declaration])
    const bad = customSurface()
    bad.data.custom = { amount: '12' }
    await expect(declared.service().render({ surface: bad }, signal)).rejects.toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })
    expect((await declared.service().read({ sessionId: 'session' }, signal)).surfaces).toEqual([])
    bad.data.custom = { amount: 12 }
    const component = bad.components.at(-1)!
    if ('fallback' in component) component.fallback = 'Undeclared fallback'
    await expect(declared.service().render({ surface: bad }, signal)).rejects.toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })
    await declared.service().render({ surface: customSurface() }, signal)
    const invalidUpdate = customSurface()
    invalidUpdate.revision = 2
    invalidUpdate.data.custom = { amount: '12' }
    await expect(
      declared
        .service()
        .update({ surfaceId: invalidUpdate.id, expectedRevision: 1, surface: invalidUpdate }, signal),
    ).rejects.toMatchObject({ data: { code: 'INVALID_PARAMS' } })
    expect((await declared.service().read({ sessionId: 'session' }, signal)).surfaces[0]?.surface).toEqual(
      customSurface(),
    )
  })
  it('keeps a custom action on the ordinary deferred tool and approval path', async () => {
    const f = fixture([declaration])
    await f.service().render({ surface: customSurface() }, signal)
    expect(surfaceText(customSurface())).toContain(declaration.fallback)
    const receipt = await f.service().action(request(), actor, signal)
    expect(receipt.status).toBe('received')
    const invocation = await f.queue.next(signal)
    expect(invocation?.invocation.tool).toBe('adjust')
    expect(invocation?.invocation.args).toEqual({
      amount: 12,
      reason: 'reviewed',
      rows: [{ id: 'a', amount: 12 }],
    })
    await f.outcome('pending-approval')
    expect((await f.service().read({ sessionId: 'session' }, signal)).actions[0]?.status).toBe(
      'pending-approval',
    )
  })
})

describe('question collector on the ordinary surface path', () => {
  const questions = [
    { id: 'single', question: 'One', options: ['A', 'B'] },
    { id: 'multi', question: 'Many', options: ['A', 'B'], multiple: true },
    { id: 'text', question: 'Explain' },
  ]
  const submit = (
    commandId: string,
    answers: Record<string, string | string[]>,
    revision = 1,
  ): UiActionParams => ({
    sessionId: 'session',
    surfaceId: 'questions',
    revision,
    actionId: 'submit',
    commandId,
    input: { answers },
    selection: {},
  })
  it('refuses model calls, validates every answer, and recovers a late successful answer without truncation', async () => {
    const f = fixture([], true)
    const contact = questionSurface('contact_form', [{ id: 'name', question: 'Name' }])
    contact.components[0]!.id = 'fields'
    contact.actions[0]!.argsTemplate.answers = { from: 'input', key: 'draft' }
    expect(() =>
      bindArguments(
        contact,
        {
          sessionId: 'session',
          surfaceId: contact.id,
          revision: 1,
          actionId: 'submit',
          commandId: 'old-surface',
          input: { fields: { name: 'Ada' } },
          selection: {},
        },
        { tools: () => [] },
        contact,
      ),
    ).toThrow(/input.draft.*argument "answers".*fields/)
    await expect(f.service().render({ surface: contact }, signal)).rejects.toMatchObject({
      data: {
        effect: 'none',
        issues: [
          {
            path: '/surface/actions/0/argsTemplate/answers/key',
            expected: expect.stringContaining('fields'),
          },
        ],
      },
    })
    contact.actions[0]!.argsTemplate = {
      surfaceId: { literal: 'contact_form' },
      values: { from: 'input', key: 'fields' },
    }
    await expect(f.service().render({ surface: contact }, signal)).rejects.toMatchObject({
      data: {
        effect: 'none',
        issues: expect.arrayContaining([
          { path: '/surface/actions/0/argsTemplate/values', expected: expect.stringContaining('answers') },
        ]),
      },
    })
    contact.actions[0]!.argsTemplate = {
      surfaceId: { literal: 'contact_form' },
      answers: { from: 'input', key: 'fields' },
    }
    await f.service().render({ surface: contact }, signal)
    const contactRequest = {
      sessionId: 'session',
      surfaceId: 'contact_form',
      revision: 1,
      actionId: 'submit',
      commandId: 'contact-missing',
      input: {},
      selection: {},
    }
    expect(await f.service().action(contactRequest, actor, signal)).toMatchObject({
      status: 'rejected',
      refusal: { code: 'UI_INVALID', message: expect.stringContaining('input.fields') },
    })
    const accepted = await f
      .service()
      .action(
        { ...contactRequest, commandId: 'contact-ok', input: { fields: { name: 'Ada' } } },
        actor,
        signal,
      )
    expect(accepted.status).toBe('received')
    expect((await f.queue.next(signal))?.invocation.args).toEqual({
      surfaceId: 'contact_form',
      answers: { name: 'Ada' },
    })
    await f.outcome('succeeded')
    await f.service().render({ surface: questionSurface('questions', questions) }, signal)
    const answers = { single: 'B', multi: ['A', 'B'], text: 'Long human answer '.repeat(300) }
    await expect(
      f.service().submittedInput('model-call', { surfaceId: 'questions', answers }, signal),
    ).rejects.toMatchObject({ code: expect.any(Number) })
    expect(
      await f.service().action(submit('invalid', { ...answers, multi: ['C'] }), actor, signal),
    ).toMatchObject({ status: 'rejected' })
    f.clock(200000) // Optional question deadline is not an action expiry.
    const admitted = await f.service().action(submit('late', answers), actor, signal)
    expect(admitted).toMatchObject({ status: 'received' })
    f.restart()
    expect((await f.service().read({ sessionId: 'session' }, signal)).actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ commandId: 'late', status: 'received' })]),
    )
    f.bindInvocation(admitted.invocationId!)
    await f.outcome('executing')
    await expect(
      f
        .service()
        .submittedInput(
          'collector-call',
          { surfaceId: 'questions', answers: { ...answers, single: 'A' } },
          signal,
        ),
    ).rejects.toMatchObject({ code: expect.any(Number) })
    expect(
      await f.service().submittedInput('collector-call', { surfaceId: 'questions', answers }, signal),
    ).toEqual({ surfaceId: 'questions', answers })
    await f.outcome('succeeded')
    f.restart()
    const recovered = await f.service().read({ sessionId: 'session', surfaceId: 'questions' }, signal)
    expect(recovered.surfaces[0]?.status).toBe('closed')
    const delivered = f.rows
      .filter((row) => row.type.endsWith('/inbox'))
      .find((row) => (row.data as { key: string }).key === 'ui-result:late')!
    const payload = delivered.data as { system: import('@agnes/protocol').SystemInput; actor: Actor }
    expect((payload.system.data as { submitted?: unknown }).submitted).toEqual({
      surfaceId: 'questions',
      answers,
    })
    expect(delivered.data).toMatchObject({
      system: {
        source: 'agnes/intelligent-ui',
        type: 'action-result',
        presentation: {
          kind: 'ui-action',
          operation: 'submit',
          status: 'succeeded',
          fields: expect.arrayContaining(['single', 'multi', 'text']),
        },
      },
    })
    expect(payload.actor).toEqual(actor)
    expect(f.deliveries.size).toBe(4) // Contact and question refusal/success, once each.
  })
  it('rejects stale answers and preserves an open form when ordinary policy refuses collection', async () => {
    const f = fixture([], true),
      form = questionSurface('questions', questions)
    await f.service().render({ surface: form }, signal)
    const replacement = { ...form, revision: 2 }
    await f.service().update({ surfaceId: form.id, expectedRevision: 1, surface: replacement }, signal)
    const answers = { single: 'A', multi: ['B'], text: 'Review' }
    expect(await f.service().action(submit('stale', answers), actor, signal)).toMatchObject({
      status: 'rejected',
      refusal: { code: 'UI_STALE' },
    })
    await f.service().action(submit('refused', answers, 2), actor, signal)
    await f.outcome('failed', {
      code: 'CAPABILITY_DENIED',
      message: 'Ordinary policy denied',
      retryable: false,
      outcomeUnknown: false,
    })
    f.restart()
    const recovered = await f.service().read({ sessionId: 'session', surfaceId: form.id }, signal)
    expect(recovered.surfaces[0]?.status).toBe('open')
    expect(recovered.actions).toEqual(
      expect.arrayContaining([expect.objectContaining({ commandId: 'refused', status: 'rejected' })]),
    )
  })
  it('delivers one result when a later instance completes an approval admitted earlier', async () => {
    const f = await opened()
    expect(await f.service().action(request('late'), actor, signal)).toMatchObject({ status: 'received' })
    await f.outcome('pending-approval')
    expect(f.deliveries.size).toBe(0)
    f.restart()
    await f.outcome('succeeded')
    expect(f.deliveries.size).toBe(1)
    expect([...f.deliveries.keys()]).toEqual(['ui-result:late'])
    f.restart()
    await f.service().read({ sessionId: 'session' }, signal)
    expect(f.deliveries.size).toBe(1)
  })
  it('fails closed when the admitted actor is missing or different', async () => {
    const f = await opened()
    const before = f.rows.length
    f.admit(undefined)
    await expect(f.service().action(request('missing'), actor, signal)).rejects.toMatchObject({
      code: expect.any(Number),
    })
    for (const changed of [
      { ...actor, id: 'other' },
      { ...actor, org: 'other' },
      { ...actor, role: 'admin' },
      { ...actor, deptPath: ['restricted'] },
      { ...actor, attrs: { scope: 'admin' } },
    ]) {
      f.admit(changed)
      await expect(f.service().action(request('forged'), actor, signal)).rejects.toMatchObject({
        data: { code: 'CAPABILITY_DENIED' },
      })
    }
    expect(f.rows).toHaveLength(before)
  })
})

const HASH = 'ab'.repeat(32)
const bound = (): UiSurface => {
  const value = surface()
  value.data.rows = { $source: 'finance/differences', params: {} }
  const action = value.actions[0]
  if (!action) throw new Error('missing confirm action')
  action.argsTemplate = {
    ...action.argsTemplate,
    rows: { from: 'selection', key: 'differences', pointer: '/0/id' },
  }
  action.paramsSchema = {
    type: 'object',
    required: ['amount', 'reason', 'rows'],
    properties: { amount: { type: 'number' }, reason: { type: 'string' }, rows: { type: 'string' } },
    additionalProperties: false,
  }
  return value
}
const resolved = (input: UiSourceResolveInput, ok = true): UiSourceResolveResult =>
  ok
    ? {
        ok: true,
        surface: {
          ...input.surface,
          data: { ...input.surface.data, rows: [{ id: 'a', amount: 12 }] },
        },
        sources: { rows: { status: 'ready', resultHash: HASH } },
        audits: [
          {
            name: input.purpose === 'refresh' ? 'source.refreshed' : 'source.resolved',
            data: {
              sourceId: 'finance/differences',
              paramsHash: HASH,
              resultHash: HASH,
              bytes: 2,
              rows: 1,
              durationMs: 1,
              generationId: 'generation',
              actorId: 'agnes/intelligent-ui',
            },
          },
        ],
      }
    : {
        ok: false,
        code: 'UI_SOURCE_DENIED',
        dataKey: 'rows',
        audits: [
          {
            name: 'source.refused',
            data: {
              sourceId: 'finance/differences',
              paramsHash: HASH,
              durationMs: 1,
              generationId: 'generation',
              actorId: 'agnes/intelligent-ui',
              code: 'UI_SOURCE_DENIED',
            },
          },
        ],
      }

/**
 * Type.Module infers a record of an object schema as `{}`, so a source id is not a typed key.
 * The value is still a UiSourceStatus; this reads that field without widening the assertion.
 */
function sourceAt(sources: object | undefined, key: string): UiSourceStatus | undefined {
  if (sources === undefined || !Object.hasOwn(sources, key)) return undefined
  return (sources as Record<string, UiSourceStatus>)[key]
}

describe('bound UI data sources', () => {
  it('stores the binding and audits the write without keeping rows', async () => {
    const f = fixture()
    f.source(async (input) => resolved(input))
    const record = await f.service().render({ surface: bound() }, signal)
    expect(record.surface.data.rows).toEqual({ $source: 'finance/differences', params: {} })
    expect(record.sources).toBeUndefined()
    const audits = f.rows.filter((item) => item.type.includes('/source.'))
    expect(audits.map((item) => item.type)).toEqual(['x/agnes/intelligent-ui/source.resolved'])
    expect(JSON.stringify(audits)).not.toContain('amount')
    expect(JSON.stringify(audits)).not.toContain('$source')
  })
  it.each(['UI_SOURCE_UNKNOWN', 'UI_SOURCE_DENIED'] as const)(
    'returns %s from surface tools without publishing or swallowing resolver errors',
    async (code) => {
      const f = fixture()
      const tools: ToolDef[] = []
      extensionFactoryOf(intelligentUi)({
        providers: { register: () => () => {}, bindOwn: async () => f.service() },
        registerProjection: () => () => {},
        registerTool: (tool: ToolDef) => {
          tools.push(tool)
          return () => {}
        },
      } as unknown as ExtensionAPI)
      f.source(async (input) => ({ ...resolved(input, false), ok: false, code }))
      await expect(f.service().render({ surface: bound() }, signal)).rejects.toMatchObject({
        data: { code },
      })
      const ctx = fakeToolContext()
      const render = tools.find((tool) => tool.name === 'ui_render')!
      const update = tools.find((tool) => tool.name === 'ui_update')!
      expect(await render.execute({ surface: bound() }, ctx)).toMatchObject({
        isError: true,
        structured: { code, published: false },
      })
      expect(f.rows.some((item) => item.type.endsWith('/surface.opened'))).toBe(false)
      expect(f.rows.some((item) => item.type.endsWith('/source.refused'))).toBe(true)
      // A refused replacement keeps the original surface revision.
      f.source(async (input) => resolved(input))
      await f.service().render({ surface: bound() }, signal)
      f.source(async (input) => ({ ...resolved(input, false), ok: false, code }))
      expect(
        await update.execute(
          {
            surfaceId: 'reconcile',
            expectedRevision: 1,
            surface: { ...bound(), revision: 2 },
          },
          ctx,
        ),
      ).toMatchObject({ isError: true, structured: { code, published: false } })
      expect(f.rows.some((item) => item.type.endsWith('/surface.updated'))).toBe(false)
      f.source(async (input) => resolved(input))
      expect((await f.service().read({ sessionId: 'session' }, signal)).surfaces[0]?.surface.revision).toBe(1)
      // Matching public error fields are not proof of a known publication refusal.
      const unknown = rpcError('SEMANTIC_REJECTED', { code })
      f.source(async () => {
        throw unknown
      })
      await expect(render.execute({ surface: { ...bound(), id: 'other' } }, ctx)).rejects.toBe(unknown)
    },
  )
  it('fails closed when a binding has no resolver', async () => {
    const f = fixture()
    await expect(f.service().render({ surface: bound() }, signal)).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    expect(f.rows).toEqual([])
  })
  it('degrades one component on a later read and does not replay an earlier result', async () => {
    const f = fixture()
    let fail = false
    f.source(async (input) =>
      fail
        ? {
            ok: true,
            surface: input.surface,
            sources: { rows: { status: 'error', code: 'UI_SOURCE_UNAVAILABLE' } },
            audits: [],
          }
        : resolved(input),
    )
    await f.service().render({ surface: bound() }, signal)
    const first = (await f.service().read({ sessionId: 'session' }, signal)).surfaces[0]!
    expect(first.surface.data.rows).toEqual([{ id: 'a', amount: 12 }])
    expect(sourceAt(first.sources, 'rows')).toEqual({ status: 'ready', resultHash: HASH })
    fail = true
    const second = (await f.service().read({ sessionId: 'session' }, signal)).surfaces[0]!
    expect(second.surface.data.rows).toEqual({ $source: 'finance/differences', params: {} })
    expect(sourceAt(second.sources, 'rows')).toEqual({ status: 'error', code: 'UI_SOURCE_UNAVAILABLE' })
  })
  it('refuses a stale bound action and rejects a denied one before action.received', async () => {
    const f = fixture()
    let mode: 'ok' | 'stale' | 'denied' = 'ok'
    f.source(async (input) =>
      mode === 'ok'
        ? resolved(input)
        : { ...resolved(input, false), code: mode === 'stale' ? 'UI_STALE' : 'UI_SOURCE_DENIED' },
    )
    await f.service().render({ surface: bound() }, signal)
    mode = 'stale'
    expect(await f.service().action(request(), actor, signal)).toMatchObject({
      status: 'rejected',
      refusal: { code: 'UI_STALE' },
    })
    expect(f.rows.some((item) => item.type.endsWith('/action.received'))).toBe(true)
    mode = 'denied'
    const before = f.rows.filter((item) => item.type.endsWith('/action.received')).length
    await expect(f.service().action(request('two'), actor, signal)).rejects.toMatchObject({
      data: { code: 'UI_SOURCE_DENIED' },
    })
    expect(f.rows.filter((item) => item.type.endsWith('/action.received'))).toHaveLength(before)
  })
  it('rejects an empty source pointer before storing a surface', async () => {
    const f = fixture()
    const value = bound()
    const action = value.actions[0]
    if (!action) throw new Error('missing confirm action')
    action.argsTemplate = {
      ...action.argsTemplate,
      rows: { from: 'selection', key: 'differences' },
    }
    await expect(f.service().render({ surface: value }, signal)).rejects.toMatchObject({
      data: { code: 'UI_INVALID' },
    })
    expect(f.rows).toEqual([])
  })
  it('rejects a source binding that resolves to a row object', async () => {
    const f = fixture()
    f.source(async (input) => resolved(input))
    const value = bound()
    const action = value.actions[0]
    if (!action) throw new Error('missing confirm action')
    action.argsTemplate = {
      ...action.argsTemplate,
      rows: { from: 'selection', key: 'differences', pointer: '/0' },
    }
    action.paramsSchema = {
      type: 'object',
      required: ['amount', 'reason', 'rows'],
      properties: {
        amount: { type: 'number' },
        reason: { type: 'string' },
        rows: { type: 'object' },
      },
      additionalProperties: false,
    }
    await f.service().render({ surface: value }, signal)
    const receipt = await f.service().action(request(), actor, signal)
    expect(receipt).toMatchObject({ status: 'rejected', refusal: { code: 'UI_INVALID' } })
    expect(f.rows.some((item) => item.type.endsWith('/queue'))).toBe(false)
    expect(JSON.stringify(f.rows)).not.toContain('"id":"a"')
  })
  it('refuses refresh while an action is unfinished and does not resolve again', async () => {
    const f = fixture()
    let calls = 0
    f.source(async (input) => {
      calls += 1
      return resolved(input)
    })
    await f.service().render({ surface: bound() }, signal)
    expect(await f.service().action(request(), actor, signal)).toMatchObject({ status: 'received' })
    const before = calls
    await expect(
      f.service().refresh({ sessionId: 'session', surfaceId: 'reconcile' }, signal),
    ).rejects.toMatchObject({ data: { code: 'UI_BUSY' } })
    expect(calls).toBe(before)
  })
})

it('refuses an unregistered artifact before publishing render or update', async () => {
  const f = fixture()
  const file = {
    ...surface(),
    components: [{ id: 'file', kind: 'artifact-file' as const, dataKey: 'file' }],
    actions: [],
    data: {
      file: {
        name: 'demo.html',
        description: '',
        artifact: { sha256: 'f'.repeat(64), size: 20990, mime: 'text/html' },
      },
    },
  }
  await expect(f.service().render({ surface: file }, signal)).rejects.toMatchObject({
    data: { code: 'UI_ARTIFACT_NOT_FOUND' },
  })
  expect(f.rows.some((row) => row.type.endsWith('/surface.opened'))).toBe(false)
  await f.service().render({ surface: surface() }, signal)
  const before = f.rows.length
  await expect(
    f
      .service()
      .update({ surfaceId: file.id, expectedRevision: 1, surface: { ...file, revision: 2 } }, signal),
  ).rejects.toMatchObject({ data: { code: 'UI_ARTIFACT_NOT_FOUND' } })
  expect(f.rows.slice(before).some((row) => row.type.endsWith('/surface.updated'))).toBe(false)
})

it('validates file metadata after source resolution and isolates historical file failures on read', async () => {
  const f = fixture()
  const ref = { sha256: 'a'.repeat(64), size: 22579, mime: 'text/html' }
  const file = (): UiSurface => ({
    ...surface(),
    components: [{ id: 'file', kind: 'artifact-file', dataKey: 'file' }],
    actions: [],
    data: { file: { name: 'demo.html', description: '', artifact: ref } },
  })
  f.checkArtifact(async (value) =>
    value.sha256 !== ref.sha256
      ? 'not_found'
      : value.size !== ref.size || value.mime !== ref.mime
        ? 'identity_mismatch'
        : 'available',
  )
  const good = await f.service().render({ surface: file() }, signal)
  expect(good.artifacts).toEqual({ file: 'available' })
  for (const changed of [{ sha256: 'b'.repeat(64) }, { size: 20990 }, { mime: 'text/plain' }]) {
    const next = file()
    next.revision = 2
    next.data.file = { name: 'demo.html', description: '', artifact: { ...ref, ...changed } }
    const before = f.rows.length
    await expect(
      f.service().update({ surfaceId: next.id, expectedRevision: 1, surface: next }, signal),
    ).rejects.toMatchObject({
      data: { code: changed.sha256 ? 'UI_ARTIFACT_NOT_FOUND' : 'UI_ARTIFACT_IDENTITY_MISMATCH' },
    })
    expect(f.rows.slice(before).some((row) => row.type.endsWith('/surface.updated'))).toBe(false)
    next.id = `other-${f.rows.length}-${Object.keys(changed)[0]}`
    next.revision = 1
    await expect(f.service().render({ surface: next }, signal)).rejects.toMatchObject({
      data: { code: changed.sha256 ? 'UI_ARTIFACT_NOT_FOUND' : 'UI_ARTIFACT_IDENTITY_MISMATCH' },
    })
    expect(f.rows.slice(before).some((row) => row.type.endsWith('/surface.opened'))).toBe(false)
  }
  // Synthetic old bad row remains intact and cannot fail the page or refresh.
  const old = file()
  old.id = 'old-invalid'
  old.data.file = { name: 'demo.html', description: '', artifact: { ...ref, sha256: 'f'.repeat(64) } }
  f.row('surface.opened', { record: { ...good, surface: old } })
  f.checkArtifact(async (value) => (value.sha256 === ref.sha256 ? 'available' : 'not_found'))
  f.restart()
  expect(
    (await f.service().read({ sessionId: 'session' }, signal)).surfaces.map((row) => row.surface.id),
  ).toEqual([good.surface.id, old.id])
  expect((await f.service().refresh({ sessionId: 'session', surfaceId: old.id }, signal)).surface.id).toBe(
    old.id,
  )
  const bound = file()
  bound.id = 'source-file'
  bound.components.push({ id: 'status', kind: 'status', dataKey: 'status' })
  bound.data.status = { $source: 'fixture/files', params: {} }
  f.source(async (request) => ({
    ok: true,
    surface: { ...request.surface, data: { ...file().data, status: 'resolved' } },
    sources: {},
    audits: [],
  }))
  f.checkArtifact(async () => 'identity_mismatch')
  await expect(f.service().render({ surface: bound }, signal)).rejects.toMatchObject({
    data: { code: 'UI_ARTIFACT_IDENTITY_MISMATCH' },
  })
  f.checkArtifact(async (_ref, checking) => {
    checking.throwIfAborted()
    return 'available'
  })
  const cancelled = new AbortController()
  cancelled.abort()
  const before = f.rows.length
  await expect(f.service().render({ surface: bound }, cancelled.signal)).rejects.toThrow()
  expect(f.rows).toHaveLength(before)
  const during = new AbortController()
  f.checkArtifact(async () => {
    during.abort()
    return 'available'
  })
  await expect(f.service().render({ surface: bound }, during.signal)).rejects.toThrow()
  expect(f.rows).toHaveLength(before)
})

it('publishes the checked input snapshot when a caller changes its object during an asynchronous check', async () => {
  const f = fixture()
  const original: UiSurface = {
    ...surface(),
    id: 'snapshot-file',
    components: [{ id: 'file', kind: 'artifact-file', dataKey: 'file' }],
    actions: [],
    data: {
      file: {
        name: 'demo.html',
        description: '',
        artifact: { sha256: 'a'.repeat(64), size: 3, mime: 'text/html' },
      },
    },
  }
  f.checkArtifact(async () => {
    original.data.file = {
      name: 'demo.html',
      description: '',
      artifact: { sha256: 'f'.repeat(64), size: 99, mime: 'text/html' },
    }
    return 'available'
  })
  const stored = await f.service().render({ surface: original }, signal)
  expect(stored.surface.data.file).toMatchObject({ artifact: { sha256: 'a'.repeat(64), size: 3 } })
  f.restart()
  expect(
    (await f.service().read({ sessionId: 'session' }, signal)).surfaces[0]?.surface.data.file,
  ).toMatchObject({ artifact: { sha256: 'a'.repeat(64), size: 3 } })
})

it('admits the public component-library surface and delivers one successful authenticated action for duplicate command ids', async () => {
  const { readFile } = await import('node:fs/promises')
  const { pathToFileURL } = await import('node:url')
  const root = `${process.cwd()}/examples/ui/component-library`
  const descriptor = JSON.parse(await readFile(`${root}/src/agnes.client.json`, 'utf8'))
  const example = await import(pathToFileURL(`${root}/surface.mjs`).href)
  const f = fixture(descriptor.client.intelligentComponents, false, [
    {
      name: 'ui_example_ack',
      parameters: Type.Object({ message: Type.String({ maxLength: 64 }) }, { additionalProperties: false }),
    },
  ])
  await f.service().render({ surface: example.reviewSurface() }, signal)
  const request: UiActionParams = {
    sessionId: 'session',
    surfaceId: 'component-review',
    revision: 1,
    actionId: 'confirm',
    commandId: 'example-confirm',
    confirmed: true,
    input: {},
    selection: {},
  }
  expect(await f.service().action(request, actor, signal)).toMatchObject({ status: 'received' })
  await f.outcome('succeeded')
  expect(await f.service().action(request, actor, signal)).toMatchObject({
    status: 'succeeded',
    duplicate: true,
  })
  expect(f.calls.size).toBe(1)
  expect(f.deliveries.size).toBe(1)
  const input = f.rows.find((row) => row.type.endsWith('/inbox'))!.data as {
    system: { source: string; type: string; data: { status: string } }
  }
  expect(input.system).toMatchObject({
    source: 'agnes/intelligent-ui',
    type: 'action-result',
    data: { status: 'succeeded' },
  })
})

it.each(['undeclared-action', 'illegal-params', 'missing-confirmation', 'no-deferred', 'disabled'] as const)(
  'refuses an Intelligent UI action with %s before dispatch',
  async (reason) => {
    const f = await opened()
    const value = request()
    if (reason === 'undeclared-action') value.actionId = 'not-declared'
    if (reason === 'illegal-params') value.input = { adjustment: { amount: 'wrong', reason: 'reviewed' } }
    if (reason === 'missing-confirmation') value.confirmed = false
    if (reason === 'no-deferred') f.deferredSupported(false)
    if (reason === 'disabled') f.tool(false)
    const receipt = await f.service().action(value, actor, signal)
    expect(receipt.status).toBe('rejected')
    expect(f.calls.size).toBe(0)
  },
)
