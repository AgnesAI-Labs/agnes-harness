import type { CallContext, Outcome, ServiceProvider } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, RuntimeServiceCatalog } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  supervisorConfig,
  supervisorDescriptor,
} from '../../../extension-api/testkit/runtime/contracts/supervisor.js'
import { createDefaultSupervisorFactory } from '../../src/runtime/providers/supervisor.js'
import type { SessionControlPort, SupervisorDeployment } from '../../src/runtime/supervisor/ports.js'

const catalog = RuntimeServiceCatalog['agh.supervisor'].methods
const refs = RuntimeMethodSchemaRefs['agh.supervisor']
type Name = keyof typeof catalog
const NAMES = Object.keys(catalog) as Name[]
/** The default test deployment installs only the session-control port. */
const INSTALLED: readonly Name[] = ['readSessionControl', 'submitSessionControl', 'sessionControlStatus']

const descriptor = () => supervisorDescriptor('agh.default/supervisor')
const emptyConfig = supervisorConfig
const binding: W.BindingRef = {
  contract: 'agh.supervisor',
  logicalName: 'default',
  providerId: 'agh.default/supervisor',
  bindingId: 'supervisor-binding',
}
function context(sessionId: string | null = 'session-1', signal = new AbortController().signal): CallContext {
  const scope = sessionId
    ? { kind: 'session', installationId: 'i', runtimeId: 'r', tenantId: 't', workspaceId: 'w', sessionId }
    : { kind: 'runtime', installationId: 'i', runtimeId: 'r' }
  return {
    principalRef: 'principal',
    scope,
    bindingId: binding.bindingId,
    invocationId: 'inv',
    deadline: '2100-01-01T00:00:00.000Z',
    traceRef: 'trace',
    authorizationRef: 'auth',
    signal,
  } as unknown as CallContext
}
function inline(schema: W.SchemaRef, value: unknown): W.DataRef {
  const text = JSON.stringify(value)
  return {
    kind: 'inline',
    schema,
    value: value as W.JsonValue,
    bytes: Buffer.byteLength(text),
    digest: canonicalJsonDigest(value as W.JsonValue),
  }
}
const op = (method: Name, value: unknown, target = binding): W.ServiceOperation => ({
  target,
  method,
  input: inline(refs[method].input, value),
})
const ok = <T>(value: T): Outcome<T> => ({ ok: true, value })
const state = (sessionId: string): W.SessionControlState =>
  ({
    sessionId,
    revision: 3,
    parameters: {},
    activeRunId: null,
    activeTurnId: null,
  }) as unknown as W.SessionControlState

function peers(overrides: Partial<SessionControlPort> = {}) {
  const calls: { method: string; context: CallContext; request: unknown }[] = []
  const port: SessionControlPort = {
    async readSessionControl(request, ctx) {
      calls.push({ method: 'read', context: ctx, request })
      return ok(state(request.sessionId))
    },
    async submitSessionControl(request, ctx) {
      calls.push({ method: 'submit', context: ctx, request })
      return ok({
        sessionId: request.sessionId,
        requestId: request.requestId,
        status: 'accepted',
      } as unknown as W.SessionControlResult)
    },
    async sessionControlStatus(request, ctx) {
      calls.push({ method: 'status', context: ctx, request })
      return ok({
        sessionId: request.sessionId,
        requestId: request.requestId,
        status: 'applied',
      } as unknown as W.SessionControlResult)
    },
    ...overrides,
  }
  return { port, calls }
}
type DeploymentOverrides = {
  -readonly [K in keyof SupervisorDeployment]?: SupervisorDeployment[K] | undefined
}
async function open(overrides: DeploymentOverrides = {}, ready = true) {
  const { port, calls } = peers()
  // An explicit undefined removes the port, so the deployment really lacks it.
  const deployment: DeploymentOverrides = { clock: () => Date.now(), sessionControl: port, ...overrides }
  for (const key of Object.keys(deployment) as (keyof DeploymentOverrides)[]) {
    if (deployment[key] === undefined) delete deployment[key]
  }
  const factory = createDefaultSupervisorFactory(descriptor(), deployment as SupervisorDeployment)
  const provider: ServiceProvider = await factory.create(emptyConfig(), {} as never, {
    instanceId: 'instance',
    scope: { kind: 'runtime', installationId: 'i', runtimeId: 'r' } as never,
    bindingId: binding.bindingId,
    signal: new AbortController().signal,
  })
  if (ready) await provider.ready(context())
  const control = provider.control
  const query = provider.query
  if (!control || !query) throw new Error('missing handlers')
  return { provider, calls, control, query }
}
const fail = (result: Outcome<unknown>) => {
  if (result.ok) throw new Error('expected refusal')
  return `${result.error.code}/${result.error.detailCode}`
}

describe('descriptor', () => {
  it('must match the official catalog operation by operation', () => {
    const bad = descriptor() as { operations: { method: string; kind: string }[] }
    const target = bad.operations.find((entry) => entry.method === 'admit')
    if (target) target.kind = 'query'
    expect(() =>
      createDefaultSupervisorFactory(bad as unknown as W.ProviderDescriptor, { clock: Date.now }),
    ).toThrow(/descriptor/)
    expect(() =>
      createDefaultSupervisorFactory({ ...descriptor(), scope: 'run' } as W.ProviderDescriptor, {
        clock: Date.now,
      }),
    ).toThrow(/descriptor/)
    // The catalog also lists eight authority-transfer methods this provider does not serve; they refuse by name.
    expect(NAMES.filter((name) => !name.startsWith('authority'))).toHaveLength(15)
    expect(NAMES.filter((name) => name.startsWith('authority'))).toHaveLength(8)
    expect(NAMES).toHaveLength(23)
  })
})

describe('lifecycle and serving table', () => {
  it('refuses before ready and reports every unavailable method when degraded', async () => {
    const f = await open({}, false)
    expect(fail(await f.query(op('readSessionControl', 'session-1') as never, context()))).toBe(
      'incompatible/supervisor_not_ready',
    )
    await f.provider.ready(context())
    const health = await f.provider.health(context())
    expect(health.ok && health.value.status).toBe('degraded')
    expect(health.ok && health.value.diagnosticIds).toHaveLength(NAMES.length - INSTALLED.length)
    expect(health.ok && health.value.diagnosticIds.includes('supervisor-unavailable:signal')).toBe(true)
    expect(
      health.ok && health.value.diagnosticIds.includes('supervisor-unavailable:readSessionControl'),
    ).toBe(false)
  })
  it('names an unimplemented method and an absent port instead of returning an empty success', async () => {
    const f = await open()
    const runRef = {
      runId: 'run-1',
      session: { sessionId: 'session-1', authority: { authorityId: 'a', tenantId: 't', authorityEpoch: 1 } },
    }
    expect(
      fail(
        await f.control(
          op('signal', {
            runRef,
            signalId: 's',
            type: refs.signal.input,
            payloadRef: inline(refs.signal.input, {}),
          }),
          context(),
        ),
      ),
    ).toBe('incompatible/supervisor_method_unsupported')
    expect(
      fail(
        await f.query(
          op('serviceCommandStatus', {
            commandId: 'c',
            sessionId: 'session-1',
            extensionId: 'e',
            serviceName: 'n',
          }) as never,
          context(),
        ),
      ),
    ).toBe('incompatible/supervisor_method_unsupported')
    const bare = await open({ sessionControl: undefined })
    expect(fail(await bare.query(op('readSessionControl', 'session-1') as never, context()))).toBe(
      'incompatible/supervisor_port_unavailable',
    )
  })
  it('refuses sessionParameters by name even when a read port is installed', async () => {
    const read = { run: async () => ok(null) } as unknown as SupervisorDeployment['read']
    const f = await open({ read })
    const runRef = {
      runId: 'run-1',
      session: { sessionId: 'session-1', authority: { authorityId: 'a', tenantId: 't', authorityEpoch: 1 } },
    }
    expect(fail(await f.query(op('sessionParameters', { runRef }) as never, context()))).toBe(
      'incompatible/supervisor_method_unsupported',
    )
    const health = await f.provider.health(context())
    expect(health.ok && health.value.diagnosticIds.includes('supervisor-unavailable:sessionParameters')).toBe(
      true,
    )
    expect(health.ok && health.value.diagnosticIds.includes('supervisor-unavailable:inspect')).toBe(false)
  })
  it('refuses a wrong target, a wrong kind and a paged query', async () => {
    const f = await open()
    expect(
      fail(
        await f.query(
          op('readSessionControl', 'session-1', { ...binding, bindingId: 'other' }) as never,
          context(),
        ),
      ),
    ).toBe('denied/supervisor_binding_mismatch')
    expect(fail(await f.control(op('readSessionControl', 'session-1'), context()))).toBe(
      'incompatible/supervisor_method_unsupported',
    )
    expect(
      fail(
        await f.query({ ...op('readSessionControl', 'session-1'), page: { limit: 1 } } as never, context()),
      ),
    ).toBe('invalid_input/supervisor_input_invalid')
  })
  it('drain closes control but not queries, blocks while a call hangs, and close cannot be revived', async () => {
    let release: (value: Outcome<W.SessionControlState>) => void = () => {}
    const hung = new Promise<Outcome<W.SessionControlState>>((resolve) => (release = resolve))
    const { port } = peers({ readSessionControl: () => hung })
    const f = await open({ sessionControl: port })
    const pending = f.query(op('readSessionControl', 'session-1') as never, context())
    const draining = await f.provider.drain(new Date(Date.now() + 20).toISOString(), context())
    expect(draining.ok && draining.value.state).toBe('blocked')
    expect(
      fail(
        await f.control(
          op('submitSessionControl', {
            sessionId: 's',
            requestId: 'r',
            expectedRevision: null,
            command: { kind: 'set-yolo', enabled: true },
          }),
          context(),
        ),
      ),
    ).toBe('cancelled/supervisor_draining')
    release(ok(state('session-1')))
    expect((await pending).ok).toBe(true)
    const again = await f.provider.drain(new Date(Date.now() + 20).toISOString(), context())
    expect(again.ok && again.value.state).toBe('drained')
    await f.provider.close('shutdown')
    expect(fail(await f.query(op('readSessionControl', 'session-1') as never, context()))).toBe(
      'cancelled/supervisor_disposed',
    )
    expect((await f.provider.ready(context())).ok).toBe(false)
  })
})

describe('session control forwards', () => {
  it('reads through State with the original context object', async () => {
    const f = await open()
    const ctx = context()
    const reply = await f.query(op('readSessionControl', 'session-1') as never, ctx)
    expect(reply.ok && reply.value.kind).toBe('value')
    expect(f.calls[0]?.context === ctx).toBe(true)
  })
  it('refuses another session before State is called', async () => {
    const f = await open()
    expect(fail(await f.query(op('readSessionControl', 'session-2') as never, context('session-1')))).toBe(
      'denied/supervisor_scope_session',
    )
    expect(f.calls).toHaveLength(0)
    expect((await f.query(op('readSessionControl', 'session-2') as never, context(null))).ok).toBe(true)
  })
  it('captures the request before the await so later mutation cannot change what State sees', async () => {
    const f = await open()
    const request = {
      sessionId: 'session-1',
      requestId: 'req-1',
      expectedRevision: null,
      command: { kind: 'set-yolo', enabled: true },
    }
    const operation = op('submitSessionControl', request)
    const pending = f.control(operation, context())
    ;(operation.input as unknown as { value: { requestId: string } }).value.requestId = 'tampered'
    await pending
    expect((f.calls.at(0)?.request as { requestId: string } | undefined)?.requestId).toBe('req-1')
  })
  it('refuses a State answer for a different request and a null status', async () => {
    const wrong = peers({
      submitSessionControl: async () =>
        ok({
          sessionId: 'session-1',
          requestId: 'other',
          status: 'accepted',
        } as unknown as W.SessionControlResult),
      sessionControlStatus: async () => ok(null as never),
    })
    const f = await open({ sessionControl: wrong.port })
    const request = {
      sessionId: 'session-1',
      requestId: 'req-1',
      expectedRevision: null,
      command: { kind: 'set-yolo', enabled: true },
    }
    expect(fail(await f.control(op('submitSessionControl', request), context()))).toBe(
      'internal/supervisor_peer_mismatch',
    )
    expect(
      fail(
        await f.query(
          op('sessionControlStatus', { sessionId: 'session-1', requestId: 'req-1' }) as never,
          context(),
        ),
      ),
    ).toBe('invalid_input/not_found')
  })
  it('stops waiting when the caller aborts and never calls State for an already aborted caller', async () => {
    const never = peers({ readSessionControl: () => new Promise(() => {}) })
    const f = await open({ sessionControl: never.port })
    const controller = new AbortController()
    const pending = f.query(
      op('readSessionControl', 'session-1') as never,
      context('session-1', controller.signal),
    )
    controller.abort()
    expect(fail(await pending)).toBe('cancelled/cancelled')
    const aborted = new AbortController()
    aborted.abort()
    const g = await open()
    expect(
      fail(
        await g.query(op('readSessionControl', 'session-1') as never, context('session-1', aborted.signal)),
      ),
    ).toBe('cancelled/cancelled')
    expect(g.calls).toHaveLength(0)
  })
  it('turns a State exception into a named internal refusal instead of rejecting', async () => {
    const throwing = peers({ readSessionControl: () => Promise.reject(new Error('boom')) })
    const f = await open({ sessionControl: throwing.port })
    expect(fail(await f.query(op('readSessionControl', 'session-1') as never, context()))).toBe(
      'internal/supervisor_provider_exception',
    )
  })
  it('refuses a payload whose digest or schema does not match', async () => {
    const f = await open()
    const input = inline(refs.readSessionControl.input, 'session-1') as W.DataRef & { digest: string }
    expect(
      fail(
        await f.query(
          {
            target: binding,
            method: 'readSessionControl',
            input: { ...input, digest: '0'.repeat(64) },
          } as never,
          context(),
        ),
      ),
    ).toBe('invalid_input/supervisor_input_invalid')
    expect(
      fail(
        await f.query(
          {
            target: binding,
            method: 'readSessionControl',
            input: inline(refs.inspect.input, 'session-1'),
          } as never,
          context(),
        ),
      ),
    ).toBe('invalid_input/supervisor_input_invalid')
  })
})
