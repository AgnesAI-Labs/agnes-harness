import type { WorkspaceInvocationView } from '@agnes/core'
import type { ExtensionManifest, ServiceContext, ServiceDef } from '@agnes/extension-api'
import { serviceFixture } from '@agnes/extension-api/testkit'
import type { Actor, ExtensionCallParams, JsonValue } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { compileExtensionSchema } from '../../src/ext-host/json-schema.js'
import { leaseFor } from '../../src/ext-host/lease.js'
import {
  isServicePreDispatchFailure,
  type ServiceInvocationDeps,
  serviceInvoker,
} from '../../src/ext-host/service-invocation.js'
import { ServiceRegistry } from '../../src/ext-host/services.js'

const actor: Actor = { id: 'subject', org: 'org', role: 'user', deptPath: [], attrs: {} }
const log = { debug() {}, info() {}, warn() {}, error() {} }
const workspace = {
  root: '/workspace',
  fs: () => ({}),
  ready: async () => ({ confine: async (argv: readonly string[]) => argv }),
  hookSnapshot: async () => ({ workspaceDigest: 'workspace', policyRevision: 1, hooks: [] }),
  approvalContext: () => ({}),
  checkpointContext: () => ({}),
} as unknown as WorkspaceInvocationView
type SessionServiceDef = Extract<ServiceDef, { scope?: 'session' }>
function setup(over: Partial<SessionServiceDef> = {}, budget = Infinity, version = '1.0.0') {
  const def: SessionServiceDef = { ...serviceFixture(), ...over }
  const { handler: _, ...cap } = def
  const manifest: ExtensionManifest = {
    id: 'fixture/service',
    version,
    apiRange: '^5.0.0',
    entry: './index.ts',
    capabilities: { services: [cap] },
    ...(budget === Infinity ? {} : { lease: { budget } }),
  }
  const lease = leaseFor(manifest, { now: Date.now(), ttlMs: 60000 })
  const registry = new ServiceRegistry(),
    ac = new AbortController(),
    audit = vi.fn()
  const dispose = registry.register(def, { manifest, lease, signal: ac.signal })
  let saved: ServiceContext | undefined
  const deps: ServiceInvocationDeps = {
    registry,
    authority: {
      resolve: vi.fn(async () => ({
        source: 'reports',
        subjectCredential: 'verified-subject',
        grants: [{ extension: manifest.id, name: def.name, range: '^1.0' }],
      })),
    },
    principals: {
      resolve: vi.fn(async () => structuredClone(actor)),
      authorize: vi.fn(async () => ({ decisionId: 'allow', effect: 'allow' as const, reason: '' })),
    },
    audit: { write: audit },
    signal: ac.signal,
    context(_entry, identity, alive, invocationWorkspace) {
      expect(invocationWorkspace).toBe(workspace)
      const unavailable = () => {
        alive()
        throw new Error('unavailable')
      }
      saved = Object.freeze({
        ...identity,
        cwd: '/workspace',
        log,
        // Fixed facts: these service tests are never about the platform, so the fake reports a
        // stable posix/full-capability view rather than probing the real host.
        platform: {
          shell: 'posix' as const,
          fs: { caseSensitive: true, pathSep: '/' },
          terminal: { color: false },
          capability: () => ({ level: 'full' as const, scope: [] }),
        },
        exec: unavailable,
        fs: {
          read: async () => {
            alive()
            return new Uint8Array([1])
          },
          write: unavailable,
          list: unavailable,
          stat: unavailable,
        },
        net: { fetch: unavailable },
        artifacts: {
          put: unavailable,
          get: unavailable,
          submitJob: unavailable,
          poll: unavailable,
          cancel: unavailable,
        },
        authorize: unavailable,
      })
      return saved
    },
  }
  const invoker = serviceInvoker(deps)
  const call = (
    input: JsonValue = { value: 1 },
    extra: Partial<ExtensionCallParams> = {},
    signal?: AbortSignal,
    effectAdmission?: { commandId: string },
  ) =>
    invoker.call(
      {
        sessionId: 'session-1',
        extension: manifest.id,
        service: def.name,
        input: input as ExtensionCallParams['input'],
        ...extra,
      },
      'opaque',
      workspace,
      signal,
      effectAdmission,
    )
  const inspect = (extra: Partial<ExtensionCallParams> = {}, signal?: AbortSignal) =>
    invoker.inspect(
      { sessionId: 'session-1', extension: manifest.id, service: def.name, input: { value: 1 }, ...extra },
      'opaque',
      workspace,
      signal,
    )
  return {
    def,
    manifest,
    registry,
    lease,
    deps,
    ac,
    audit,
    dispose,
    call,
    inspect,
    invoker,
    saved: () => saved,
  }
}

describe('S3 Service registration and invocation', () => {
  it('issues renewable, target-bound control only after native effect admission and audit', async () => {
    let now = 100_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const h = setup({ kind: 'effect', controlLeaseMs: 30_000, controlSessionMs: 300_000 })
      const params = {
        sessionId: 'session-1',
        extension: h.manifest.id,
        service: h.def.name,
        input: { value: 1 },
      }
      const authorize = (extra: Partial<ExtensionCallParams> = {}) =>
        h.invoker.authorizeControl({ ...params, ...extra }, 'control-one', 'opaque', workspace)
      await expect(authorize()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
      await expect(h.call({ value: 1 }, { commandId: 'control-one' })).rejects.toBeDefined()
      await expect(
        h.call({ value: 1 }, { commandId: 'control-one' }, undefined, { commandId: 'control-one' }),
      ).resolves.toEqual({ output: { value: 1 } })
      const grant = await authorize().catch((error) => {
        throw new Error('authorize after admission failed', { cause: error })
      })
      expect(grant.grantId).toBe(h.saved()?.controlGrant?.grantId)
      expect(grant.expiresAt).toBe(now + 30_000)
      await expect(authorize({ sessionId: 'session-2' })).rejects.toBeDefined()
      await expect(authorize({ input: { value: 2 } })).rejects.toBeDefined()
      now += 29_000
      expect((await authorize()).expiresAt).toBe(now + 30_000)
      vi.mocked(h.deps.principals.resolve).mockResolvedValueOnce({ ...actor, id: 'other-user' })
      await expect(authorize()).rejects.toBeDefined()
      now += 300_000
      await expect(authorize()).rejects.toBeDefined()
    } finally {
      clock.mockRestore()
    }
  })

  it.each(['handler', 'audit', 'revocation'])('refuses control after %s failure', async (kind) => {
    const h = setup({
      kind: 'effect',
      controlLeaseMs: 30_000,
      ...(kind === 'handler'
        ? {
            handler: async () => {
              throw new Error('failed')
            },
          }
        : {}),
    })
    if (kind === 'audit')
      h.deps.audit.write = () => {
        throw new Error('audit failed')
      }
    const call = h.call({ value: 1 }, { commandId: 'control-one' }, undefined, { commandId: 'control-one' })
    if (kind === 'revocation') {
      await expect(call).resolves.toEqual({ output: { value: 1 } })
      h.dispose()
    } else await expect(call).rejects.toBeDefined()
    await expect(
      h.invoker.authorizeControl(
        {
          sessionId: 'session-1',
          extension: h.manifest.id,
          service: h.def.name,
          input: { value: 1 },
        },
        'control-one',
        'opaque',
        workspace,
      ),
    ).rejects.toBeDefined()
  })

  it.each([
    { version: '1.0.0', range: '^1.0' },
    { version: '0.1.0-alpha.0', range: '*' },
    { version: '1.2.3+build.4', range: '*' },
  ])('invokes row $version under $range and rejects retirement', async ({ version, range }) => {
    const h = setup()
    const owner = 'plugin/0123456789abcdef'
    const ac = new AbortController()
    let active = true
    const registry = new ServiceRegistry()
    const dispose = registry.registerRow(h.def, {
      owner,
      version,
      signal: ac.signal,
      assertAlive() {
        if (!active) throw new Error('row retired')
      },
      assertRunning() {
        if (!active) throw new Error('row retired')
      },
      consume() {},
    })
    expect(registry.resolve(owner, h.def.name)?.capability.maxResultBytes).toBe(h.def.maxResultBytes)
    expect(registry.registrations(owner)).toEqual([`service:${owner}/${h.def.name}`])
    expect(registry.binding([h.def.name])).toEqual({ extension: owner, packageId: owner })
    expect(registry.binding([h.def.name, 'missing.contract.part'])).toBeUndefined()
    const releaseAlternative = registry.registerRow(h.def, {
      owner: 'plugin/fedcba9876543210',
      packageId: '@community/jobs',
      version,
      signal: ac.signal,
      assertAlive() {},
      assertRunning() {},
      consume() {},
    })
    expect(() => registry.binding([h.def.name])).toThrow('ambiguous service binding')
    releaseAlternative()
    expect(registry.binding([h.def.name])).toMatchObject({ extension: owner })

    const invoker = serviceInvoker({
      ...h.deps,
      registry,
      authority: {
        resolve: async () => ({
          source: 'reports',
          subjectCredential: 'verified-subject',
          grants: [{ extension: owner, name: h.def.name, range }],
        }),
      },
    })
    const request: ExtensionCallParams = {
      sessionId: 'session-1',
      extension: owner,
      service: h.def.name,
      input: { value: 1 },
    }
    expect(await invoker.call(request, 'opaque', workspace)).toEqual({ output: { value: 1 } })
    await expect(
      invoker.call({ ...request, extension: h.manifest.id }, 'opaque', workspace),
    ).rejects.toThrow()
    expect(() =>
      registry.registerRow(h.def, {
        owner: 'fixture/spoof',
        version: '1.0.0',
        signal: ac.signal,
        assertAlive() {},
        assertRunning() {},
        consume() {},
      }),
    ).toThrow(/identity/)
    active = false
    expect(() => registry.resolve(owner, h.def.name)?.assertAlive()).toThrow(/row retired/)
    await expect(invoker.call(request, 'opaque', workspace)).rejects.toThrow()
    dispose()
    expect(registry.resolve(owner, h.def.name)).toBeUndefined()
  })

  it('uses exact manifest metadata, fails duplicates and preserves newer identities on stale dispose', () => {
    const h = setup(),
      authority = { manifest: h.manifest, lease: h.lease, signal: h.ac.signal }
    expect(() => h.registry.register(h.def, authority)).toThrow(/already registered/)
    expect(() => h.registry.register({ ...h.def, kind: 'effect' }, authority)).toThrow(/differs/)
    expect(() => h.registry.register({ ...h.def, name: 'undeclared' }, authority)).toThrow(/differs/)
    h.registry.purgeOwner(h.manifest.id)
    h.registry.register(h.def, authority)
    h.dispose()
    expect(h.registry.registrations(h.manifest.id)).toEqual(['service:fixture/service/fixture.echo'])
    h.registry.purgeOwner(h.manifest.id)
    expect(h.registry.registrations(h.manifest.id)).toEqual([])
  })

  it('checks every schema against the meta-schema on one shared instance', () => {
    const original = Ajv2020.prototype.validateSchema
    const checkedOn = new Set<unknown>()
    const spy = vi
      .spyOn(Ajv2020.prototype, 'validateSchema')
      .mockImplementation(function (this: Ajv2020, ...args: Parameters<typeof original>) {
        checkedOn.add(this)
        return original.apply(this, args)
      })
    try {
      for (const n of [1, 2, 3])
        compileExtensionSchema(
          { type: 'object', properties: { [`shared-meta-${n}`]: { type: 'string' } } },
          'E_SERVICE_DEF',
        )
    } finally {
      spy.mockRestore()
    }
    expect(checkedOn.size).toBe(1)
  })

  it('rejects invalid, remote and async schemas without publishing', () => {
    for (const outputSchema of [
      { type: 'invalid' },
      // Only the meta-schema rejects this: it compiles to a check that every string passes.
      { type: 'string', minLength: -1 },
      { $ref: 'https://example.com/remote' },
      { $async: true, type: 'number' },
    ]) {
      expect(() => setup({ outputSchema })).toThrow(/schema/)
    }
    const schema = { $id: 'urn:test:isolated-validator', type: 'string' }
    const first = compileExtensionSchema(schema, 'E_SERVICE_DEF')
    const same = compileExtensionSchema(structuredClone(schema), 'E_PROJECTION_DEF')
    expect(first('valid')).toBe(true)
    expect(same(1)).toBe(false)
    schema.type = 'number'
    const changed = compileExtensionSchema(schema, 'E_SERVICE_DEF')
    expect(changed(1)).toBe(true)
    expect(changed('invalid')).toBe(false)
    expect(first(1)).toBe(false)
    expect(same('valid')).toBe(true)
    expect(() => compileExtensionSchema({ $ref: schema.$id }, 'E_PROJECTION_DEF')).toThrow(
      expect.objectContaining({ code: 'E_PROJECTION_DEF' }),
    )
    Object.defineProperty(schema, 'type', { get: () => 'number' })
    expect(() => compileExtensionSchema(schema, 'E_SERVICE_DEF')).toThrow(
      expect.objectContaining({ code: 'E_SERVICE_DEF' }),
    )
  })

  it('injects authenticated identity, authorizes first and returns a copied result', async () => {
    const order: string[] = [],
      output = { value: 3 }
    const h = setup({
      handler: async (_input, ctx) => {
        order.push('handler')
        expect(ctx.actor).toEqual(actor)
        expect(Object.isFrozen(ctx.actor.attrs)).toBe(true)
        expect(ctx.source).toBe('reports')
        expect(ctx.requestId).toMatch(/^[0-9a-f-]{36}$/)
        expect(ctx.session).toEqual({
          key: 'session-1',
          lane: 'main',
          workspaceRoot: '/workspace',
          turn: 0,
          step: 0,
        })
        expect(ctx).not.toHaveProperty('sandbox')
        return output
      },
    })
    h.deps.principals.authorize = vi.fn(async (a, action, target) => {
      order.push('authorize')
      expect(a).toEqual(actor)
      expect(action).toBe('execute')
      expect(target).toEqual({ kind: 'datasource', id: 'fixture/service/fixture.echo' })
      return { decisionId: 'yes', effect: 'allow' as const, reason: '' }
    })
    const result = await h.call()
    output.value = 99
    expect(result).toEqual({ output: { value: 3 } })
    expect(order).toEqual(['authorize', 'handler'])
    expect(h.deps.principals.resolve).toHaveBeenCalledWith('verified-subject', 'service')
    expect(h.audit).toHaveBeenCalledWith({
      kind: 'extension.service-call',
      detail: {
        extension: h.manifest.id,
        service: h.def.name,
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        kind: h.def.kind,
        mode: 'call',
        outcome: 'ok',
        source: 'reports',
        actorId: actor.id,
      },
    })
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain('verified-subject')
    await expect(h.saved()?.fs.read('x')).rejects.toMatchObject({ data: { code: 'REQUEST_TIMEOUT' } })
  })

  it('allows the last invocation credit and refuses the next', async () => {
    const h = setup({ handler: async (_input, ctx) => ({ value: (await ctx.fs.read('x'))[0] ?? 0 }) }, 1)
    await expect(h.call()).resolves.toEqual({ output: { value: 1 } })
    await expect(h.call()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  })

  it.each([
    'missing',
    'extension',
    'name',
    'range',
    'prerelease-range',
    'invalid-version',
    'deny',
    'approval',
    'lease',
  ])('refuses %s authority before handler', async (kind) => {
    const handler = vi.fn(async () => ({ value: 1 }))
    if (kind === 'invalid-version') {
      expect(() => setup({ handler }, Infinity, '1.0.0-01')).toThrow(/invalid lease configuration/)
      expect(handler).not.toHaveBeenCalled()
      return
    }
    const h = setup({ handler }, Infinity, kind === 'prerelease-range' ? '1.2.3-alpha.1' : '1.0.0')
    if (kind === 'missing') delete h.deps.authority
    else if (kind === 'lease') h.lease.revoke('test')
    else if (kind === 'deny' || kind === 'approval')
      h.deps.principals.authorize = async () => ({
        decisionId: 'no',
        effect: kind === 'deny' ? 'deny' : 'require_approval',
        reason: '',
      })
    else
      h.deps.authority = {
        resolve: async () => ({
          source: 'other',
          subjectCredential: 'subject',
          grants: [
            {
              extension: kind === 'extension' ? 'fixture/other' : h.manifest.id,
              name: kind === 'name' ? '*' : h.def.name,
              range: kind === 'range' ? '^2.0' : '^1.0',
            },
          ],
        }),
      }
    await expect(h.call()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects forged envelope identity and invalid input without author execution', async () => {
    const handler = vi.fn(async () => ({ value: 1 })),
      h = setup({ handler })
    await expect(h.call({ value: 'bad' })).rejects.toMatchObject({ data: { code: 'INVALID_PARAMS' } })
    await expect(h.call({}, { actor } as Partial<ExtensionCallParams>)).rejects.toMatchObject({
      data: { code: 'INVALID_PARAMS' },
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('requires a commandId and a matching daemon journal admission before executing an effect', async () => {
    const handler = vi.fn(async () => ({ value: 1 })),
      h = setup({ kind: 'effect', handler })
    await expect(h.call()).rejects.toMatchObject({ data: { code: 'INVALID_PARAMS' } })
    await expect(h.call({ value: 1 }, { commandId: 'command' })).rejects.toMatchObject({
      data: { code: 'CAPABILITY_DENIED' },
    })
    await expect(
      h.call({ value: 1 }, { commandId: 'command' }, undefined, { commandId: 'other' }),
    ).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(handler).not.toHaveBeenCalled()
    await expect(
      h.call({ value: 1 }, { commandId: 'command' }, undefined, { commandId: 'command' }),
    ).resolves.toEqual({ output: { value: 1 } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('classifies from trusted manifest metadata after auth and schema checks without dispatch', async () => {
    const queryHandler = vi.fn(async () => ({ value: 1 }))
    const query = setup({ kind: 'query', handler: queryHandler })
    await expect(query.inspect({ commandId: 'ignored-for-query' })).resolves.toEqual({ kind: 'query' })
    expect(queryHandler).not.toHaveBeenCalled()
    expect(query.audit).toHaveBeenCalledWith({
      kind: 'extension.service-call',
      detail: {
        extension: query.manifest.id,
        service: query.def.name,
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        kind: 'query',
        mode: 'inspect',
        outcome: 'inspected',
        source: 'reports',
        actorId: actor.id,
      },
    })

    const effectHandler = vi.fn(async () => ({ value: 1 }))
    const effect = setup({ kind: 'effect', handler: effectHandler })
    await expect(effect.inspect()).resolves.toEqual({ kind: 'effect' })
    expect(effectHandler).not.toHaveBeenCalled()
    expect(effect.audit).toHaveBeenCalledWith({
      kind: 'extension.service-call',
      detail: {
        extension: effect.manifest.id,
        service: effect.def.name,
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        kind: 'effect',
        mode: 'inspect',
        outcome: 'inspected',
        source: 'reports',
        actorId: actor.id,
      },
    })
    effect.deps.principals.authorize = async () => ({
      decisionId: 'denied',
      effect: 'deny',
      reason: '',
    })
    await expect(effect.inspect()).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  })

  it('marks only failures known to precede effect handler dispatch', async () => {
    const pre = setup({ kind: 'effect' })
    pre.deps.principals.authorize = async () => ({
      decisionId: 'denied',
      effect: 'deny',
      reason: '',
    })
    const preError = await pre
      .call({ value: 1 }, { commandId: 'pre' }, undefined, { commandId: 'pre' })
      .catch((error: unknown) => error)
    expect(isServicePreDispatchFailure(preError)).toBe(true)

    const auditRefusal = setup({ kind: 'effect' })
    auditRefusal.deps.principals.authorize = async () => ({
      decisionId: 'denied',
      effect: 'deny',
      reason: '',
    })
    auditRefusal.deps.audit.write = () => {
      throw new Error('audit unavailable')
    }
    const auditError = await auditRefusal
      .call({ value: 1 }, { commandId: 'audit' }, undefined, { commandId: 'audit' })
      .catch((error: unknown) => error)
    expect(auditError).toMatchObject({ data: { code: 'INTERNAL_ERROR' } })
    expect(isServicePreDispatchFailure(auditError)).toBe(true)

    let revoke!: () => void
    const after = setup({
      kind: 'effect',
      handler: async () => {
        revoke()
        return { value: 1 }
      },
    })
    revoke = () => after.lease.revoke('after-dispatch')
    const afterError = await after
      .call({ value: 1 }, { commandId: 'after' }, undefined, { commandId: 'after' })
      .catch((error: unknown) => error)
    expect(afterError).toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
    expect(isServicePreDispatchFailure(afterError)).toBe(false)
  })

  it.each(['schema', 'size', 'cycle', 'throw', 'hostile-error'])(
    'sanitizes %s failures and never audits author data',
    async (kind) => {
      const h = setup({
        maxResultBytes: 24,
        ...(kind === 'size' ? { outputSchema: { type: 'object' } } : {}),
        handler: async () => {
          if (kind === 'throw') throw new Error('private author payload')
          if (kind === 'hostile-error')
            throw Object.defineProperty({}, 'data', {
              get() {
                throw new Error('private accessor')
              },
            })
          if (kind === 'cycle') {
            const value: Record<string, unknown> = {}
            value.self = value
            return value as JsonValue
          }
          return kind === 'size' ? { value: 1, extra: 'x'.repeat(40) } : { wrong: 1 }
        },
      })
      await expect(h.call()).rejects.toEqual({
        code: -32603,
        message: 'INTERNAL_ERROR',
        data: { code: 'INTERNAL_ERROR' },
      })
      expect(JSON.stringify(h.audit.mock.calls)).not.toMatch(/private|wrong|extra/)
    },
  )

  it.each(['cancel', 'revoke', 'timeout'])(
    'bounds %s during authorization and never starts a late handler',
    async (kind) => {
      const handler = vi.fn(async () => ({ value: 1 })),
        h = setup({ handler, timeoutMs: 20 })
      let release!: () => void
      h.deps.principals.authorize = () =>
        new Promise((resolve) => {
          release = () => resolve({ decisionId: 'yes', effect: 'allow', reason: '' })
        })
      const cancel = new AbortController(),
        result = h.call({ value: 1 }, {}, cancel.signal)
      const assertion = expect(result).rejects.toMatchObject({
        data: { code: kind === 'revoke' ? 'CAPABILITY_DENIED' : 'REQUEST_TIMEOUT' },
      })
      await vi.waitFor(() => expect(release).toBeTypeOf('function'), { interval: 1 })
      if (kind === 'cancel') cancel.abort()
      if (kind === 'revoke') h.lease.revoke('test')
      if (kind !== 'timeout') release()
      await assertion
      release()
      await Promise.resolve()
      expect(handler).not.toHaveBeenCalled()
    },
  )

  it('consumes late handler rejection and aborts borrowed I/O on timeout', async () => {
    let reject!: (error: unknown) => void
    const h = setup({
      timeoutMs: 10,
      handler: () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    })
    await expect(h.call()).rejects.toMatchObject({ data: { code: 'REQUEST_TIMEOUT' } })
    expect(h.saved()?.signal.aborted).toBe(true)
    reject(new Error('late private error'))
    await Promise.resolve()
    expect(h.audit).toHaveBeenCalledTimes(1)
  })

  it('rejects lease revocation while the handler waits', async () => {
    let finish!: () => void
    const h = setup({
      handler: () =>
        new Promise((resolve) => {
          finish = () => resolve({ value: 1 })
        }),
    })
    const result = h.call()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'), { interval: 1 })
    h.lease.revoke('test')
    finish()
    await expect(result).rejects.toMatchObject({ data: { code: 'CAPABILITY_DENIED' } })
  })

  it('never leaks a failed audit sink exception', async () => {
    const h = setup()
    h.deps.audit.write = () => {
      throw new Error('private audit path')
    }
    await expect(h.call()).rejects.toEqual({
      code: -32603,
      message: 'INTERNAL_ERROR',
      data: { code: 'INTERNAL_ERROR' },
    })
  })
})
