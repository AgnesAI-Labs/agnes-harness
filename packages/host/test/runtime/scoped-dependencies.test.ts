import { readFileSync } from 'node:fs'
import type {
  ArtifactAccessPort,
  CallContext,
  EventsOutboxControl,
  Outcome,
  ScopeRef,
  ServiceRequirement,
} from '@agnes/extension-api/runtime'
import {
  type AssertionInput,
  type AssertionRecord,
  type BuildIdentity,
  createConformanceHarness,
  createTestServiceContainer,
  discoverContracts,
  judgeReport,
  type ReportDraft,
} from '@agnes/extension-api/testkit'
import {
  AssemblyRefusal,
  type ServiceRequirement as AssemblyRequirement,
  FixedCordisAssembly,
  HOOKS_RUNNER_EVENTS,
  HOOKS_RUNNER_ROW_ID,
  type HookDeclaration,
  normalizeHookSnapshots,
  type ObserverResult,
} from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import {
  createHostScopedDependencies,
  type HostPermissionGrant,
  type HostSelectedProvider,
} from '../../src/runtime/scoped-dependencies.js'

const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)
const CODE_DIGEST = 'c'.repeat(64)

const build: BuildIdentity = {
  codeSha: 'code-sha',
  buildDigest: 'build-digest',
  lockDigest: 'lock-digest',
  specVersion: 'spec-1',
  sdkVersion: 'sdk-1',
  sdkDigest: 'sdk-digest',
  platform: 'darwin-arm64',
}

const clock = {
  startedAt: '2026-10-01T00:00:00.000Z',
  finishedAt: '2026-10-01T00:00:01.000Z',
} as const

function scopeRef(kind: ScopeRef['kind']): ScopeRef {
  if (kind === 'installation') return { kind, installationId: 'install-1' }
  if (kind === 'runtime') return { kind, installationId: 'install-1', runtimeId: 'runtime-1' }
  if (kind === 'workspace') {
    return { kind, installationId: 'install-1', runtimeId: 'runtime-1', workspaceId: 'workspace-1' }
  }
  if (kind === 'session') {
    return {
      kind,
      installationId: 'install-1',
      runtimeId: 'runtime-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
    }
  }
  if (kind === 'run') {
    return {
      kind,
      installationId: 'install-1',
      runtimeId: 'runtime-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      runId: 'run-1',
    }
  }
  return {
    kind: 'action',
    installationId: 'install-1',
    runtimeId: 'runtime-1',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    runId: 'run-1',
    actionId: 'action-1',
  }
}

function contextFor(kind: ScopeRef['kind'], authorizationRef = 'auth-1'): CallContext {
  return {
    principalRef: 'principal-1',
    scope: scopeRef(kind),
    bindingId: 'binding-1',
    invocationId: 'invocation-1',
    deadline: '2026-10-01T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef,
    signal: new AbortController().signal,
  }
}

function wire(
  scope: ServiceRequirement['scope'],
  features: readonly string[] = [],
  logicalName = 'loop',
  contract = 'agh.loop',
): ServiceRequirement {
  return { contract, major: 1, logicalName, features: [...features], scope, optional: false }
}

function grant(overrides: Partial<HostPermissionGrant> = {}): HostPermissionGrant {
  return {
    authorizationRef: 'auth-1',
    ownerId: 'owner-1',
    permissions: ['use'],
    scope: 'runtime',
    ...overrides,
  }
}

function selected(overrides: Partial<HostSelectedProvider> = {}): HostSelectedProvider {
  return {
    binding: {
      bindingId: 'binding-loop',
      contract: 'agh.loop',
      logicalName: 'loop',
      providerId: 'owner-1',
    },
    major: 1,
    scope: 'runtime',
    features: ['read'],
    packageDigest: DIGEST_A,
    ownerId: 'owner-1',
    permissions: ['use'],
    ...overrides,
  }
}

function providerFailure(detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code: 'internal',
      detailCode,
      message: detailCode,
      retryAdvice: { kind: 'never' },
      diagnosticId: 'from-provider',
    },
  }
}

function artifactPort(label: string, calls: string[]): ArtifactAccessPort {
  const fail = async () => {
    calls.push(label)
    return providerFailure('from-port')
  }
  return { describe: fail, openDownload: fail, readRange: fail, redeemDownload: fail, openStream: fail }
}

function outbox(label: string, calls: string[]): EventsOutboxControl {
  const fail = async () => {
    calls.push(label)
    return providerFailure('from-port')
  }
  return { deadLetters: fail, redriveOutbox: fail }
}

function declaration(
  overrides: Partial<HookDeclaration> & Pick<HookDeclaration, 'id' | 'event'>,
): HookDeclaration {
  return {
    source: 'interceptor',
    sourceKey: `src:${overrides.id}`,
    provider: {
      bindingId: 'binding-1',
      contract: 'agh.hooks',
      logicalName: 'default',
      providerId: 'provider-1',
    },
    codeDigest: CODE_DIGEST,
    execution: 'opaque',
    ...overrides,
  }
}

function assertion(overrides: Partial<AssertionRecord> = {}): AssertionRecord {
  return {
    id: 'loop-normal',
    contract: 'agh.loop',
    scenario: 'normal',
    qualification: 'required',
    providerId: 'reference',
    providerDigest: 'provider-digest',
    recipe: 'sample',
    features: ['read'],
    build,
    consumer: 'consumer',
    command: 'conformance',
    startedAt: clock.startedAt,
    finishedAt: clock.finishedAt,
    status: 'passed',
    configDigest: 'config-digest',
    releaseSetDigest: 'release-digest',
    attachmentDigest: null,
    fixture: null,
    sharedEvidenceId: null,
    ...overrides,
  }
}

function draft(assertions: readonly AssertionRecord[], overrides: Partial<ReportDraft> = {}): ReportDraft {
  return {
    contracts: ['agh.loop'],
    providers: ['reference'],
    unknownContracts: [],
    command: 'conformance',
    startedAt: clock.startedAt,
    finishedAt: clock.finishedAt,
    assertions,
    ...overrides,
  }
}

function input(overrides: Partial<AssertionInput> = {}): AssertionInput {
  return {
    id: 'loop-normal',
    providerDigest: 'provider-digest',
    recipe: 'sample',
    features: ['read'],
    build,
    consumer: 'consumer',
    command: 'conformance',
    status: 'passed',
    configDigest: 'config-digest',
    releaseSetDigest: 'release-digest',
    attachmentDigest: null,
    fixture: null,
    sharedEvidenceId: null,
    ...overrides,
  }
}

describe('host scoped dependencies', () => {
  it('projects a locked binding and refuses feature, owner, permission, and untrusted context', async () => {
    const features = ['read']
    const binding = {
      bindingId: 'binding-loop',
      contract: 'agh.loop',
      logicalName: 'loop',
      providerId: 'owner-1',
    }
    let queries = 0
    const grants = [grant(), grant({ authorizationRef: 'auth-2', ownerId: 'other-owner' })]
    const host = createHostScopedDependencies(grants)
    grants.push(grant({ authorizationRef: 'later', ownerId: 'owner-1' }))
    const absent = host.dependencies.get(wire('runtime', ['read']))
    expect(absent).toMatchObject({
      ok: false,
      error: { code: 'incompatible', detailCode: 'service_not_registered' },
    })

    const provider = selected({
      binding,
      features,
      query: async () => {
        queries += 1
        return providerFailure('from-provider')
      },
    })
    const view = await host.publish({ generationId: 'g1', providers: [provider] })
    expect(view).toMatchObject({ state: 'ready', published: true, disabled: false })
    expect(view.bindings).toEqual([{ providerId: 'owner-1', packageDigest: DIGEST_A, contract: 'agh.loop' }])
    features.push('write')
    binding.providerId = 'mutated'
    ;(provider as { packageDigest: string }).packageDigest = DIGEST_B

    const testContainer = createTestServiceContainer()
    expect(testContainer.kind).toBe('test-service-container')
    expect(testContainer.dependencies.get(wire('runtime', ['read']))).toMatchObject({
      ok: false,
      error: { detailCode: 'service_not_registered', diagnosticId: 'test-service-container' },
    })
    expect(host.dependencies).not.toHaveProperty('register')
    expect(host.dependencies).not.toHaveProperty('list')
    expect(host.dependencies).not.toHaveProperty('kind')

    const got = host.dependencies.get(wire('runtime', ['read']))
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.value.binding).toEqual({
      bindingId: 'binding-loop',
      contract: 'agh.loop',
      logicalName: 'loop',
      providerId: 'owner-1',
    })
    expect(host.view('g1').bindings[0]?.packageDigest).toBe(DIGEST_A)
    expect(got.value.eventsOutbox).toBeUndefined()
    const called = await got.value.query({} as never, contextFor('runtime'))
    expect(called).toMatchObject({
      ok: false,
      error: { detailCode: 'from-provider', diagnosticId: 'from-provider' },
    })
    expect(queries).toBe(1)

    const missing = host.dependencies.get(wire('runtime', ['read', 'write']))
    expect(missing).toMatchObject({
      ok: false,
      error: {
        code: 'incompatible',
        detailCode: 'feature_missing',
        diagnosticId: 'host-scoped-dependencies',
      },
    })
    expect(features).toEqual(['read', 'write'])

    const optional = host.dependencies.get({ ...wire('runtime', ['read'], 'missing'), optional: true })
    expect(optional).toMatchObject({ ok: false, error: { detailCode: 'service_not_registered' } })

    const untrusted = await got.value.query({} as never, 'authorization: bearer secret' as never)
    expect(untrusted).toMatchObject({ ok: false, error: { code: 'denied', detailCode: 'permission_absent' } })
    const header = await got.value.query(
      {} as never,
      {
        header: 'authorization: bearer secret',
        authorizationRef: 'auth-1',
      } as never,
    )
    expect(header).toMatchObject({ ok: false, error: { detailCode: 'permission_absent' } })
    expect(queries).toBe(1)

    const stranger = await got.value.query({} as never, contextFor('runtime', 'nobody'))
    expect(stranger).toMatchObject({ ok: false, error: { detailCode: 'permission_absent' } })
    const otherOwner = await got.value.query({} as never, contextFor('runtime', 'auth-2'))
    expect(otherOwner).toMatchObject({ ok: false, error: { detailCode: 'owner_absent' } })
    const lateGrant = await got.value.query({} as never, contextFor('runtime', 'later'))
    expect(lateGrant).toMatchObject({ ok: false, error: { detailCode: 'permission_absent' } })
    expect(queries).toBe(1)
  })

  it('keeps accompanying ports on the selected provider and refuses a narrower or wider caller', async () => {
    const calls: string[] = []
    const loopArtifact = artifactPort('loop', calls)
    const otherArtifact = artifactPort('other', calls)
    const loopOutbox = outbox('loop-outbox', calls)
    const host = createHostScopedDependencies([
      grant(),
      grant({ authorizationRef: 'auth-2', ownerId: 'owner-2', scope: 'action' }),
    ])
    await host.publish({
      generationId: 'g1',
      providers: [
        selected({
          features: ['read'],
          artifactAccess: loopArtifact,
          eventsOutbox: loopOutbox,
          permissions: ['use', 'admin'],
        }),
        selected({
          binding: {
            bindingId: 'binding-blob',
            contract: 'agh.blob',
            logicalName: 'blob',
            providerId: 'owner-2',
          },
          ownerId: 'owner-2',
          scope: 'action',
          features: [],
          permissions: [],
          artifactAccess: otherArtifact,
          blobRead: {
            readRange: async () => providerFailure('blob'),
            openRead: async () => providerFailure('blob'),
          },
        }),
      ],
    })

    const loop = host.dependencies.get(wire('runtime', ['read']))
    expect(loop.ok).toBe(true)
    if (!loop.ok) return
    expect(loop.value.artifactAccess).toBe(loopArtifact)
    expect(loop.value.eventsOutbox).toBe(loopOutbox)
    expect(loop.value.blobRead).toBeUndefined()
    expect(loop.value.clientIngress).toBeUndefined()
    expect(loop.value.clientCommand).toBeUndefined()
    await loop.value.artifactAccess?.describe({} as never, contextFor('runtime'))
    expect(calls).toEqual(['loop'])

    const blob = host.dependencies.get(wire('action', [], 'blob', 'agh.blob'))
    expect(blob.ok).toBe(true)
    if (!blob.ok) return
    expect(blob.value.artifactAccess).toBe(otherArtifact)
    expect(blob.value.blobRead).toBeDefined()
    expect(blob.value.eventsOutbox).toBeUndefined()

    const short = await loop.value.query({} as never, contextFor('action'))
    expect(short).toMatchObject({ ok: false, error: { detailCode: 'permission_absent' } })
    const wide = await blob.value.compute?.({} as never, contextFor('runtime', 'auth-2'))
    expect(wide).toMatchObject({ ok: false, error: { detailCode: 'permission_absent' } })
    const underprivileged = await loop.value.query({} as never, contextFor('runtime'))
    expect(underprivileged).toMatchObject({ ok: false, error: { detailCode: 'permission_absent' } })
    expect(calls).toEqual(['loop'])

    const opened = await host.dependencies.openScope(scopeRef('action'), contextFor('runtime'))
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.value.get(wire('action', [], 'blob', 'agh.blob')).ok).toBe(true)
    expect(opened.value.get(wire('runtime', ['read']))).toMatchObject({
      ok: false,
      error: { detailCode: 'service_scope_mismatch' },
    })
    const escalated = await host.dependencies.openScope(scopeRef('runtime'), contextFor('action', 'auth-2'))
    expect(escalated).toMatchObject({ ok: false, error: { detailCode: 'permission_absent' } })

    await opened.value.close()
    expect(opened.value.get(wire('action', [], 'blob', 'agh.blob'))).toMatchObject({
      ok: false,
      error: { detailCode: 'service_container_closed' },
    })
    expect(host.dependencies.get(wire('runtime', ['read'])).ok).toBe(true)
    await host.dependencies.close()
    expect(host.dependencies.get(wire('runtime', ['read']))).toMatchObject({
      ok: false,
      error: { detailCode: 'service_container_closed' },
    })
    expect(host.view('g1').state).toBe('ready')
  })

  it('refuses a missing owner, a container contract, and illegal instance capture before create', async () => {
    const host = createHostScopedDependencies([grant()])
    let created = 0
    const create = () => {
      created += 1
    }
    await expect(
      host.publish({
        generationId: 'owner',
        providers: [selected({ ownerId: '', create })],
      }),
    ).rejects.toMatchObject({ code: 'owner_missing' })
    await expect(
      host.publish({
        generationId: 'owner-mismatch',
        providers: [selected({ ownerId: 'other', create })],
      }),
    ).rejects.toMatchObject({ code: 'owner_missing' })
    await expect(
      host.publish({
        generationId: 'container',
        providers: [
          selected({
            binding: {
              bindingId: 'binding-container',
              contract: 'agh.container',
              logicalName: 'container',
              providerId: 'owner-1',
            },
            create,
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'container_forbidden' })
    const captured: AssemblyRequirement = {
      contract: 'agh.captured',
      major: 1,
      logicalName: 'captured',
      scope: 'action',
      features: [],
      optional: false,
      capture: 'instance',
    }
    await expect(
      host.publish({
        generationId: 'capture',
        providers: [
          selected({
            binding: {
              bindingId: 'binding-holder',
              contract: 'agh.holder',
              logicalName: 'holder',
              providerId: 'owner-1',
            },
            scope: 'installation',
            requires: [captured],
            create,
          }),
          selected({
            binding: {
              bindingId: 'binding-captured',
              contract: 'agh.captured',
              logicalName: 'captured',
              providerId: 'captured',
            },
            ownerId: 'captured',
            scope: 'action',
            permissions: [],
            create,
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'scope_capture' })
    await expect(
      host.publish({
        generationId: 'ambiguous',
        providers: [selected({ create }), selected({ create })],
      }),
    ).rejects.toMatchObject({ code: 'duplicate_cell' })
    expect(created).toBe(0)
    expect(() => host.view('capture')).toThrow(expect.objectContaining({ code: 'unknown_generation' }))
    expect(() => host.view('ambiguous')).toThrow(expect.objectContaining({ code: 'unknown_generation' }))
    expect(host.dependencies.get(wire('runtime', ['read']))).toMatchObject({
      ok: false,
      error: { detailCode: 'service_not_registered' },
    })
    expect(captured.features).toEqual([])

    const smuggled = {
      generationId: 'smuggled',
      providers: [selected()],
      container: 'cordis',
    }
    const published = await host.publish(smuggled)
    expect(published.state).toBe('ready')
    expect(host.dependencies.get(wire('runtime', ['read'])).ok).toBe(true)

    await host.publish({
      generationId: 'factory',
      providers: [
        selected({
          binding: {
            bindingId: 'binding-holder',
            contract: 'agh.holder',
            logicalName: 'holder',
            providerId: 'owner-1',
          },
          scope: 'installation',
          requires: [{ ...captured, capture: 'factory' }],
          create,
        }),
        selected({
          binding: {
            bindingId: 'binding-captured',
            contract: 'agh.captured',
            logicalName: 'captured',
            providerId: 'captured',
          },
          ownerId: 'captured',
          scope: 'action',
          permissions: [],
        }),
      ],
    })
    expect(created).toBe(1)
    expect(host.dependencies.get(wire('installation', ['read'], 'holder', 'agh.holder')).ok).toBe(true)
  })

  it('rolls back a failed ready, drains, and closes one shared broker holder at a time', async () => {
    let starts = 0
    let stops = 0
    let released = 0
    const host = createHostScopedDependencies(
      [grant({ permissions: [] })],
      [
        {
          key: 'bus',
          start() {
            starts += 1
            return () => {
              stops += 1
            }
          },
        },
      ],
    )
    let queries = 0
    await host.publish({
      generationId: 'g1',
      brokerKeys: ['bus'],
      providers: [
        selected({
          permissions: [],
          query: async () => {
            queries += 1
            return providerFailure('from-provider')
          },
        }),
      ],
    })
    await expect(
      host.publish({
        generationId: 'g2',
        brokerKeys: ['bus'],
        providers: [
          selected({
            permissions: [],
            owners: [
              {
                id: 'owner-g2',
                release: () => {
                  released += 1
                },
              },
            ],
            ready() {
              throw new Error('ready-failed')
            },
          }),
        ],
      }),
    ).rejects.toThrow('ready-failed')
    expect(released).toBe(1)
    expect(starts).toBe(1)
    expect(stops).toBe(0)
    expect(host.view('g1').published).toBe(true)
    expect(host.view('g2').state).toBe('closed')
    const kept = host.dependencies.get(wire('runtime', ['read']))
    expect(kept.ok).toBe(true)
    if (!kept.ok) return
    expect((await kept.value.query({} as never, contextFor('runtime'))).ok).toBe(false)
    expect(queries).toBe(1)

    await host.publish({
      generationId: 'g3',
      brokerKeys: ['bus'],
      providers: [selected({ permissions: [], ownerId: 'owner-1' })],
    })
    expect(starts).toBe(1)
    expect(await kept.value.query({} as never, contextFor('runtime'))).toMatchObject({
      ok: false,
      error: { detailCode: 'service_container_closed' },
    })
    expect(queries).toBe(1)
    await host.close('g1')
    expect(stops).toBe(0)
    const current = host.dependencies.get(wire('runtime', ['read']))
    expect(current.ok).toBe(true)
    if (!current.ok) return
    const drained = await host.drain('g3', Date.now() + 20)
    expect(drained.state).toBe('drained')
    expect(host.dependencies.get(wire('runtime', ['read']))).toMatchObject({
      ok: false,
      error: { detailCode: 'closed' },
    })
    expect(await current.value.query({} as never, contextFor('runtime'))).toMatchObject({
      ok: false,
      error: { detailCode: 'closed' },
    })
    await host.close('g3')
    expect(stops).toBe(1)
    expect(await current.value.query({} as never, contextFor('runtime'))).toMatchObject({
      ok: false,
      error: { detailCode: 'service_container_closed' },
    })

    await host.publish({ generationId: 'g4', providers: [selected({ permissions: [] })] })
    expect(host.dependencies.get(wire('runtime', ['read'])).ok).toBe(true)
    host.disable('g4')
    expect(host.view('g4').disabled).toBe(true)
    expect(host.dependencies.get(wire('runtime', ['read']))).toMatchObject({
      ok: false,
      error: { code: 'denied', detailCode: 'closed' },
    })

    let closed = 0
    await host.publish({
      generationId: 'g5',
      providers: [
        selected({
          permissions: [],
          owners: [
            {
              id: 'owner-g5',
              release: () => {
                closed += 1
              },
            },
          ],
        }),
      ],
    })
    const first = await host.close('g5')
    const second = await host.close('g5')
    expect(first.repeated).toBe(false)
    expect(second.repeated).toBe(true)
    expect(second.resentActionIds).toEqual([])
    expect(closed).toBe(1)
    expect(stops).toBe(1)
    expect(host.dependencies.get(wire('runtime', ['read']))).toMatchObject({
      ok: false,
      error: { detailCode: 'service_container_closed' },
    })
    const bare = createHostScopedDependencies([grant()])
    const unavailable = await bare.publish({ generationId: 'bare', providers: [selected()] })
    expect(unavailable.published).toBe(true)
    const service = bare.dependencies.get(wire('runtime', ['read']))
    expect(service.ok).toBe(true)
    if (!service.ok) return
    expect(await service.value.query({} as never, contextFor('runtime'))).toMatchObject({
      ok: false,
      error: { code: 'internal', detailCode: 'method_unavailable', diagnosticId: 'host-scoped-dependencies' },
    })
    expect(await service.value.compute({} as never, 'not-a-context' as never)).toMatchObject({
      ok: false,
      error: { detailCode: 'permission_absent' },
    })
  })

  it('leaves host process startup unwired and grades the harness separately from production', async () => {
    const hostSource = readFileSync(new URL('../../src/host.ts', import.meta.url), 'utf8')
    const assembleSource = readFileSync(new URL('../../src/assemble.ts', import.meta.url), 'utf8')
    const moduleSource = readFileSync(
      new URL('../../src/runtime/scoped-dependencies.ts', import.meta.url),
      'utf8',
    )
    const indexSource = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
    expect(hostSource.includes('scoped-dependencies')).toBe(false)
    expect(hostSource.includes('createHostScopedDependencies')).toBe(false)
    expect(assembleSource.includes('scoped-dependencies')).toBe(false)
    expect(moduleSource.includes('@agnes/cordis')).toBe(false)
    expect(moduleSource.includes('new Context')).toBe(false)
    expect(moduleSource.includes('child_process')).toBe(false)
    expect(moduleSource.includes('node:http')).toBe(false)
    expect(moduleSource.includes('header')).toBe(false)
    expect(moduleSource.includes('agh.container')).toBe(false)
    expect(indexSource.includes("from './runtime/scoped-dependencies.js'")).toBe(true)

    expect(discoverContracts().some((item) => item.contract === 'agh.loop')).toBe(true)
    const harness = createConformanceHarness()
    expect(harness.kind).toBe('conformance-harness')
    expect(harness.inbox.kind).toBe('fixture')
    expect(harness.inbox.persistent).toBe(false)

    harness.registerCase({
      contract: 'agh.loop',
      scenario: 'normal',
      qualification: 'required',
      providerId: 'reference',
      async run(context) {
        const host = createHostScopedDependencies([grant({ permissions: [] })])
        await host.publish({ generationId: 'harness', providers: [selected({ permissions: [] })] })
        const production = host.dependencies.get(wire('runtime', ['read']))
        const fixture = context.container.dependencies.get(wire('runtime', ['read']))
        if (!production.ok || fixture.ok || fixture.error.detailCode !== 'service_not_registered') {
          throw new Error('production projection did not stay distinct from the test container')
        }
        return input({ id: 'scoped-normal', recipe: 'locked binding projection' })
      },
    })
    harness.registerCase({
      contract: 'agh.loop',
      scenario: 'select',
      qualification: 'not-advertised',
      providerId: 'reference',
      run() {
        return input({ id: 'scoped-not-advertised', status: 'skipped', recipe: 'not advertised' })
      },
    })
    harness.registerCase({
      contract: 'agh.loop',
      scenario: 'deny',
      qualification: 'required',
      providerId: 'reference',
      run() {
        const assembly = new FixedCordisAssembly([], { hooksRunnerRank: 4 })
        expect(() =>
          assembly.attachHooksRunner({
            rowId: HOOKS_RUNNER_ROW_ID,
            events: [...HOOKS_RUNNER_EVENTS],
            execution: 'subprocess',
          } as never),
        ).toThrow(expect.objectContaining({ code: 'delegated_execution' }))
        expect(assembly.hooksRunnerStatus().mode).toBe('builtin')
        const takeover = assembly.attachHooksRunner({
          rowId: HOOKS_RUNNER_ROW_ID,
          events: [...HOOKS_RUNNER_EVENTS],
        })
        expect(takeover).toMatchObject({ mode: 'takeover', execution: 'delegated', rank: 4 })
        return input({ id: 'hooks-boundary', recipe: 'delegated hook runner boundary', fixture: null })
      },
    })
    harness.registerCase({
      contract: 'agh.loop',
      scenario: 'normal',
      qualification: 'required',
      providerId: 'reference',
      async run(context) {
        const assembly = new FixedCordisAssembly()
        const seen: string[] = []
        await assembly.open({
          generationId: 'inbox',
          providers: [
            {
              providerId: 'owner-1',
              contract: 'agh.loop',
              major: 1,
              logicalName: 'loop',
              scope: 'runtime',
              features: [],
              packageDigest: DIGEST_A,
              capabilities: [],
              requires: [],
            },
          ],
          observers: [
            {
              id: 'observer-1',
              scope: 'runtime',
              event: { typeId: 'agh.notice', schemaTypeId: 'agh.notice' },
              handle(notification) {
                seen.push(notification.eventId)
              },
            },
          ],
        })
        let pending: Promise<ObserverResult> | undefined
        context.inbox.registerWaiter('peer', (acceptance) => {
          pending = assembly.deliver('inbox', {
            typeId: 'agh.notice',
            scope: 'action',
            eventId: acceptance.deliveryId,
            data: { ok: true },
          })
        })
        const notice = context.inbox.notify('peer')
        const delivered = await pending
        expect(notice.woken).toBe(1)
        expect(seen).toEqual([notice.deliveryId])
        expect(delivered?.status).toBe('completed')
        expect(delivered?.acceptedEffects).toEqual([])
        expect(context.inbox.read(notice.deliveryId, 'terminal')).toBe('terminal')

        const calls: string[] = []
        const host = createHostScopedDependencies([grant({ permissions: [] })])
        await host.publish({
          generationId: 'port',
          providers: [selected({ permissions: [], artifactAccess: artifactPort('inbox', calls) })],
        })
        context.inbox.registerWaiter('port', () => {
          const bound = host.dependencies.get(wire('runtime', ['read']))
          if (!bound.ok) throw new Error('missing port')
          void bound.value.artifactAccess?.describe({} as never, contextFor('runtime'))
        })
        expect(context.inbox.notify('port').woken).toBe(1)
        expect(calls).toEqual(['inbox'])
        return input({
          id: 'inbox-peer',
          recipe: 'inbox wakes an observer and a narrow port',
          fixture: 'runtime-inbox',
        })
      },
    })
    harness.registerCase({
      contract: 'agh.loop',
      scenario: 'deny',
      qualification: 'required',
      providerId: 'reference',
      run() {
        const executed: string[] = []
        let snapshots: unknown
        try {
          snapshots = normalizeHookSnapshots({
            workspaceId: 'workspace-1',
            configRevision: 1,
            registrations: [
              declaration({ id: 'a', event: 'context', before: ['b'] }),
              declaration({ id: 'b', event: 'context', before: ['a'] }),
            ],
          })
          executed.push('stage')
        } catch (error) {
          expect(error).toMatchObject({ code: 'dependency_cycle' })
        }
        expect(snapshots).toBeUndefined()
        expect(executed).toEqual([])
        return input({ id: 'hook-cycle', recipe: 'cycle refusal produces no snapshot' })
      },
    })

    const report = await harness.run({
      contracts: ['agh.loop'],
      providers: ['reference'],
      command: 'conformance',
      clock,
    })
    expect(report.status).toBe('passed')
    expect(report.failures).toEqual([])
    expect(
      report.assertions.filter((item) => item.qualification === 'required' && item.status === 'passed'),
    ).toHaveLength(4)
    expect(
      report.assertions.some((item) => item.qualification === 'not-advertised' && item.status === 'skipped'),
    ).toBe(true)
    expect(report.assertions.some((item) => item.fixture === 'runtime-inbox')).toBe(true)

    const empty = judgeReport(draft([assertion({ qualification: 'not-advertised', status: 'skipped' })]))
    expect(empty.status).toBe('failed')
    expect(empty.failures.map((failure) => failure.code)).toContain('empty-run')
    expect(new AssemblyRefusal('owner_missing', 'selected provider owner is missing').code).toBe(
      'owner_missing',
    )
  })
})
