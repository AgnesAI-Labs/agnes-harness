import { readFileSync } from 'node:fs'
import type {
  ArtifactAccessPort,
  CallContext,
  ScopedDependencies,
  ScopeRef,
  ServiceRequirement,
} from '@agnes/extension-api/runtime'
import {
  type AssertionInput,
  type AssertionRecord,
  type BuildIdentity,
  createConformanceHarness,
  createRuntimeInboxFixture,
  createTestServiceContainer,
  discoverContracts,
  judgeReport,
  type ReportDraft,
  SCENARIOS,
  serializeReport,
} from '@agnes/extension-api/testkit'
import { RuntimeServiceCatalog } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'

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

function requirement(
  scope: ServiceRequirement['scope'],
  features: readonly string[],
  logicalName = 'loop',
): ServiceRequirement {
  return {
    contract: 'agh.loop',
    major: 1,
    logicalName,
    features: [...features],
    scope,
    optional: false,
  }
}

const workspaceScope: ScopeRef = {
  kind: 'workspace',
  installationId: 'install-1',
  runtimeId: 'runtime-1',
  workspaceId: 'workspace-1',
}

function contextFor(scope: ScopeRef): CallContext {
  return {
    principalRef: 'principal-1',
    scope,
    bindingId: 'binding-1',
    invocationId: 'invocation-1',
    deadline: '2026-10-01T00:00:00.000Z',
    traceRef: 'trace-1',
    authorizationRef: 'auth-1',
    signal: new AbortController().signal,
  }
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => reverseKeys(item))
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const reversed: Record<string, unknown> = {}
    for (const key of Object.keys(record).reverse()) reversed[key] = reverseKeys(record[key])
    return reversed
  }
  return value
}

describe('conformance evidence', () => {
  it('passes one complete assertion without filling the discovered catalog', () => {
    const report = judgeReport(draft([assertion()], { contracts: ['agh.context', 'agh.loop'] }))
    expect(report.status).toBe('passed')
    expect(report.failures).toEqual([])
    expect(report.contracts).toEqual(['agh.context', 'agh.loop'])
    expect(report.assertions).toHaveLength(1)
    expect(report.assertions[0]?.contract).toBe('agh.loop')
    expect(SCENARIOS).toEqual(['select', 'normal', 'deny', 'cancel', 'recover', 'dispose'])
  })

  it('rejects a required pass that is missing identity and still counts the attempt', () => {
    const report = judgeReport(draft([{ ...assertion(), providerDigest: '' }]))
    expect(report.status).toBe('failed')
    expect(report.assertions).toEqual([])
    expect(report.failures).toEqual([
      { code: 'missing-evidence', detail: 'assertion 0 missing providerDigest' },
    ])
  })

  it('rejects a skipped required row and an ordinary failed row', () => {
    const skipped = judgeReport(draft([assertion({ qualification: 'required', status: 'skipped' })]))
    expect(skipped.failures).toEqual([
      { code: 'empty-run', detail: 'all skipped' },
      { code: 'missing-evidence', detail: 'required agh.loop normal loop-normal skipped' },
    ])
    const failed = judgeReport(draft([assertion({ status: 'failed' })]))
    expect(failed.status).toBe('failed')
    expect(failed.failures).toEqual([])
  })

  it('rejects mixed build identity and accepts a matching shared citation', () => {
    const mixed = judgeReport(
      draft([assertion({ id: 'one' }), assertion({ id: 'two', build: { ...build, specVersion: 'spec-2' } })]),
    )
    expect(mixed.failures).toEqual([
      { code: 'mixed-version', detail: 'mixed sdkDigest, lockDigest, buildDigest or specVersion' },
    ])
    const sameSdk = judgeReport(
      draft([
        assertion({ id: 'one', build: { ...build, sdkVersion: 'sdk-a', codeSha: 'left' } }),
        assertion({ id: 'two', build: { ...build, sdkVersion: 'sdk-b', codeSha: 'right' } }),
      ]),
    )
    expect(sameSdk.status).toBe('passed')
    const shared = judgeReport(
      draft([
        assertion({ id: 'base' }),
        assertion({ id: 'cited', qualification: 'advertised', sharedEvidenceId: 'base' }),
      ]),
    )
    expect(shared.status).toBe('passed')
    const mismatch = judgeReport(
      draft([
        assertion({ id: 'base', build: { ...build, sdkDigest: 'other-sdk' } }),
        assertion({ id: 'cited', sharedEvidenceId: 'base' }),
      ]),
    )
    expect(mismatch.failures).toContainEqual({
      code: 'missing-evidence',
      detail: 'shared evidence cited missing base',
    })
    const uncited = judgeReport(
      draft([
        assertion({ id: 'base', qualification: 'not-advertised' }),
        assertion({ id: 'cited', qualification: 'advertised', sharedEvidenceId: 'base' }),
      ]),
    )
    expect(uncited.failures).toContainEqual({
      code: 'missing-evidence',
      detail: 'shared evidence cited missing base',
    })
  })

  it('rejects an empty run for zero rows, skips, not-advertised rows, and a mix', () => {
    expect(judgeReport(draft([])).failures).toEqual([{ code: 'empty-run', detail: 'zero assertions' }])
    expect(judgeReport(draft([], { command: '' })).failures).toEqual([
      { code: 'missing-evidence', detail: 'report missing command' },
    ])
    expect(
      judgeReport(draft([assertion({ qualification: 'advertised', status: 'skipped' })])).failures,
    ).toEqual([{ code: 'empty-run', detail: 'all skipped' }])
    expect(
      judgeReport(draft([assertion({ qualification: 'not-advertised', status: 'skipped' })])).failures,
    ).toEqual([{ code: 'empty-run', detail: 'all skipped' }])
    expect(judgeReport(draft([assertion({ qualification: 'not-advertised' })])).failures).toEqual([
      { code: 'empty-run', detail: 'all not-advertised' },
    ])
    expect(
      judgeReport(
        draft([
          assertion({ id: 'skip', qualification: 'advertised', status: 'skipped' }),
          assertion({ id: 'absent', qualification: 'not-advertised', status: 'passed' }),
        ]),
      ).failures,
    ).toEqual([{ code: 'empty-run', detail: 'no executed assertion' }])
  })

  it('rejects an unknown contract and serializes the same bytes for the same input', () => {
    const report = judgeReport(
      draft([], { contracts: ['missing.contract'], unknownContracts: ['missing.contract'] }),
    )
    expect(report.failures).toEqual([
      { code: 'empty-run', detail: 'zero assertions' },
      { code: 'missing-evidence', detail: 'unknown contract missing.contract' },
    ])
    const passed = judgeReport(draft([assertion({ features: ['write', 'read'] })]))
    const scrambled = reverseKeys(passed) as typeof passed
    const text = serializeReport(passed)
    expect(serializeReport(scrambled)).toBe(text)
    expect(serializeReport(judgeReport(draft([assertion({ features: ['write', 'read'] })])))).toBe(text)
    expect(text.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(text) as {
      assertions: { build: Record<string, unknown>; features: string[] }[]
    }
    expect(JSON.parse(serializeReport(passed))).toEqual(parsed)
    expect(Object.keys(parsed)).toEqual([
      'assertions',
      'command',
      'contracts',
      'failures',
      'finishedAt',
      'providers',
      'startedAt',
      'status',
      'unknownContracts',
    ])
    const row = parsed.assertions[0]
    expect(row).toBeDefined()
    if (row === undefined) return
    expect(Object.keys(row)).toEqual([
      'attachmentDigest',
      'build',
      'command',
      'configDigest',
      'consumer',
      'contract',
      'features',
      'finishedAt',
      'fixture',
      'id',
      'providerDigest',
      'providerId',
      'qualification',
      'recipe',
      'releaseSetDigest',
      'scenario',
      'sharedEvidenceId',
      'startedAt',
      'status',
    ])
    expect(Object.keys(row.build)).toEqual([
      'buildDigest',
      'codeSha',
      'lockDigest',
      'platform',
      'sdkDigest',
      'sdkVersion',
      'specVersion',
    ])
    expect(row.features).toEqual(['write', 'read'])
    const moved = judgeReport(
      draft([assertion({ startedAt: '2026-10-01T00:00:02.000Z' })], {
        startedAt: '2026-10-01T00:00:02.000Z',
      }),
    )
    expect(serializeReport(moved)).not.toBe(text)
    expect(() => serializeReport({ ...passed, note: undefined } as typeof passed)).toThrow(/undefined/)
    expect(() => serializeReport({ ...passed, note: Number.NaN } as typeof passed)).toThrow(/not finite/)
    expect(() => serializeReport({ ...passed, note: 1n } as typeof passed)).toThrow(/not json/)
  })
})

describe('contract discovery', () => {
  it('reads the generated catalog keys and methods', () => {
    const found = discoverContracts()
    const names = Object.keys(RuntimeServiceCatalog).sort()
    expect(found.map((item) => item.contract)).toEqual(names)
    for (const item of found) {
      const entry = RuntimeServiceCatalog[item.contract as keyof typeof RuntimeServiceCatalog]
      expect(item.major).toBe(entry.major)
      expect(item.methods).toEqual(Object.keys(entry.methods).sort())
    }
    expect(found.some((item) => item.contract === 'agh.loop')).toBe(true)
  })
})

describe('test service container', () => {
  it('gives code under test a scoped dependency view', async () => {
    const container = createTestServiceContainer()
    const dependencies: ScopedDependencies = container.dependencies
    expect(container.kind).toBe('test-service-container')
    expect('register' in dependencies).toBe(false)
    expect('list' in dependencies).toBe(false)
    const binding = {
      bindingId: 'binding-1',
      contract: 'agh.loop',
      logicalName: 'loop',
      providerId: 'reference',
    }
    const artifactAccess: ArtifactAccessPort = {
      async describe() {
        throw new Error('not called')
      },
      async openDownload() {
        throw new Error('not called')
      },
      async redeemDownload() {
        throw new Error('not called')
      },
      async readRange() {
        throw new Error('not called')
      },
      async openStream() {
        throw new Error('not called')
      },
    }
    container.register({
      requirement: requirement('workspace', ['read', 'write']),
      binding,
      artifactAccess,
    })
    expect(container.list()).toEqual([requirement('workspace', ['read', 'write'])])
    const got = dependencies.get(requirement('workspace', ['read']))
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.value.binding).toEqual(binding)
    expect(got.value.artifactAccess).toBe(artifactAccess)
    expect(got.value.blobRead).toBeUndefined()
    const unavailable = await got.value.query(undefined as never, contextFor(workspaceScope))
    expect(unavailable.ok).toBe(false)
    if (unavailable.ok) return
    expect(unavailable.error).toMatchObject({
      code: 'internal',
      detailCode: 'method_unavailable',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'test-service-container',
    })
    container.register({
      requirement: requirement('workspace', ['read'], 'other'),
      binding: { ...binding, bindingId: 'binding-2', logicalName: 'other' },
      query: async () => ({
        ok: false,
        error: {
          code: 'internal',
          detailCode: 'from-test',
          message: 'from test',
          retryAdvice: { kind: 'never' },
          diagnosticId: 'from-test',
        },
      }),
    })
    const supplied = dependencies.get(requirement('workspace', ['read'], 'other'))
    expect(supplied.ok).toBe(true)
    if (!supplied.ok) return
    const fromTest = await supplied.value.query(undefined as never, contextFor(workspaceScope))
    expect(fromTest.ok).toBe(false)
    if (fromTest.ok) return
    expect(fromTest.error.detailCode).toBe('from-test')
  })

  it('fails closed for a missing, optional, ambiguous, duplicate, or mismatched service', () => {
    const container = createTestServiceContainer()
    const binding = {
      bindingId: 'binding-1',
      contract: 'agh.loop',
      logicalName: 'loop',
      providerId: 'reference',
    }
    const missing = container.dependencies.get({ ...requirement('workspace', ['read']), optional: true })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.detailCode).toBe('service_not_registered')
    container.register({ requirement: requirement('workspace', ['read', 'write']), binding })
    container.register({
      requirement: requirement('workspace', ['read', 'extra']),
      binding: { ...binding, bindingId: 'binding-2' },
    })
    const ambiguous = container.dependencies.get(requirement('workspace', ['read']))
    expect(ambiguous.ok).toBe(false)
    if (!ambiguous.ok)
      expect(ambiguous.error).toMatchObject({ code: 'conflict', detailCode: 'service_ambiguous' })
    expect(() =>
      container.register({ requirement: requirement('workspace', ['write', 'read']), binding }),
    ).toThrow(/service already registered/)
    expect(() =>
      container.register({
        requirement: requirement('session', ['read'], 'session-loop'),
        binding: { ...binding, logicalName: 'other' },
      }),
    ).toThrow(/binding does not match requirement/)
  })

  it('narrows an opened scope and closes the root with the parent', async () => {
    const container = createTestServiceContainer()
    const binding = {
      bindingId: 'binding-1',
      contract: 'agh.loop',
      logicalName: 'loop',
      providerId: 'reference',
    }
    container.register({ requirement: requirement('workspace', ['read']), binding })
    const opened = await container.dependencies.openScope(workspaceScope, contextFor(workspaceScope))
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const child = opened.value
    const mismatch = child.get(requirement('session', ['read']))
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.error.detailCode).toBe('service_scope_mismatch')
    expect(child.get(requirement('workspace', ['read'])).ok).toBe(true)
    await child.close()
    expect(container.dependencies.get(requirement('workspace', ['read'])).ok).toBe(true)
    const childClosed = child.get(requirement('workspace', ['read']))
    expect(childClosed.ok).toBe(false)
    if (!childClosed.ok) expect(childClosed.error.detailCode).toBe('service_container_closed')
    const reopened = await container.dependencies.openScope(workspaceScope, contextFor(workspaceScope))
    expect(reopened.ok).toBe(true)
    if (!reopened.ok) return
    await container.dependencies.close()
    const rooted = reopened.value.get(requirement('workspace', ['read']))
    expect(rooted.ok).toBe(false)
    if (!rooted.ok)
      expect(rooted.error).toMatchObject({ code: 'denied', detailCode: 'service_container_closed' })
  })
})

describe('runtime inbox fixture', () => {
  it('wakes registered waiters once and keeps the delivery id on this instance', () => {
    const inbox = createRuntimeInboxFixture()
    const seen: string[] = []
    inbox.registerWaiter('alpha', (acceptance) => {
      seen.push(acceptance.deliveryId)
      expect(inbox.notify('alpha')).toEqual({ deliveryId: 'fixture-delivery-1', woken: 0 })
      inbox.registerWaiter('alpha', () => {
        seen.push('late')
      })
    })
    expect(inbox.kind).toBe('fixture')
    expect(inbox.persistent).toBe(false)
    expect(inbox.notify('alpha')).toEqual({ deliveryId: 'fixture-delivery-1', woken: 1 })
    expect(inbox.notify('beta')).toEqual({ deliveryId: 'fixture-delivery-2', woken: 0 })
    expect(inbox.notify('alpha')).toEqual({ deliveryId: 'fixture-delivery-1', woken: 0 })
    expect(seen).toEqual(['fixture-delivery-1'])
    expect(inbox.read('fixture-delivery-1', 'done')).toBe('done')
    expect(inbox.read('fixture-delivery-1', 'other')).toBe('other')
    const other = createRuntimeInboxFixture()
    expect(() => other.read('fixture-delivery-1', 'done')).toThrow(/unknown delivery/)
    expect(() => inbox.read('fixture-delivery-9', 'done')).toThrow(/unknown delivery/)
  })
})

describe('conformance harness', () => {
  it('fails an empty selection and does not synthesize passed rows', async () => {
    const empty = await createConformanceHarness().run({
      contracts: 'all',
      providers: ['reference'],
      command: 'conformance',
      clock,
    })
    expect(empty.status).toBe('failed')
    expect(empty.failures).toEqual([{ code: 'empty-run', detail: 'zero assertions' }])
    expect(empty.assertions).toEqual([])
    expect(empty.contracts).toEqual(discoverContracts().map((item) => item.contract))
    const harness = createConformanceHarness()
    harness.registerCase({
      contract: 'agh.loop',
      scenario: 'normal',
      qualification: 'required',
      providerId: 'reference',
      run: () => input({ fixture: 'runtime-inbox' }),
    })
    const report = await harness.run({
      contracts: ['agh.loop', 'agh.context'],
      providers: ['reference'],
      command: 'conformance',
      clock,
    })
    expect(report.status).toBe('passed')
    expect(report.assertions.map((item) => item.contract)).toEqual(['agh.loop'])
    expect(report.assertions[0]).toMatchObject({
      fixture: 'runtime-inbox',
      startedAt: clock.startedAt,
      finishedAt: clock.finishedAt,
    })
    const unknown = await createConformanceHarness().run({
      contracts: ['missing.contract'],
      providers: ['reference'],
      command: 'conformance',
      clock,
    })
    expect(unknown.failures).toEqual([
      { code: 'empty-run', detail: 'zero assertions' },
      { code: 'missing-evidence', detail: 'unknown contract missing.contract' },
    ])
  })
})

describe('conformance library clock', () => {
  it('does not read a clock or a host implementation', () => {
    for (const name of ['evidence.ts', 'fixtures.ts', 'harness.ts', 'index.ts']) {
      const source = readFileSync(new URL(`../../testkit/runtime/${name}`, import.meta.url), 'utf8')
      expect(source).not.toMatch(/Date\.now|new Date/)
      expect(source).not.toMatch(/@agnes\/(core|host|daemon)|cordis/)
    }
    const harness = readFileSync(new URL('../../testkit/runtime/harness.ts', import.meta.url), 'utf8')
    expect(harness).toMatch(/import type \{[\s\S]*\} from '@agnes\/extension-api\/runtime'/)
    expect(harness).toMatch(/RuntimeServiceCatalog/)
  })
})
