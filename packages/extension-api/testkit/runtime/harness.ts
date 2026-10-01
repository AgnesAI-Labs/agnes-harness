import type {
  BindingRef,
  BoundService,
  Outcome,
  RuntimeError,
  ScopedDependencies,
  ScopeRef,
  ServiceRequirement,
} from '@agnes/extension-api/runtime'
import { RuntimeServiceCatalog } from '@agnes/protocol/runtime'
import {
  type AssertionRecord,
  type AssertionStatus,
  type BuildIdentity,
  type ConformanceReport,
  type FailureCode,
  FIXTURE_MARKS,
  type FixtureMark,
  type GateKind,
  judgeReport,
  PROVIDER_ABSENT,
  QUALIFICATIONS,
  type Qualification,
  type ReportDraft,
  SCENARIOS,
  type ScenarioName,
} from './evidence.js'
import { createRuntimeInboxFixture, type RuntimeInboxFixture } from './fixtures.js'

type CatalogName = keyof typeof RuntimeServiceCatalog

export interface DiscoveredContract {
  readonly contract: string
  readonly major: number
  readonly methods: readonly string[]
}

export function providerFileForContract(contract: string): string {
  const suffix = contract.startsWith('agh.') ? contract.slice('agh.'.length) : contract
  return `examples/runtime-reference/src/providers/${suffix}.ts`
}

export function discoverContracts(): readonly DiscoveredContract[] {
  return Object.keys(RuntimeServiceCatalog)
    .sort()
    .map((contract) => {
      const entry = RuntimeServiceCatalog[contract as CatalogName]
      return {
        contract,
        major: entry.major,
        methods: Object.keys(entry.methods).sort(),
      }
    })
}

export interface InjectedClock {
  readonly startedAt: string
  readonly finishedAt: string
}

export interface AssertionInput {
  readonly id: string
  readonly providerDigest: string
  readonly recipe: string
  readonly features: readonly string[]
  readonly build: AssertionRecord['build']
  readonly consumer: string
  readonly command: string
  readonly status: AssertionStatus
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly attachmentDigest: string | null
  readonly fixture: FixtureMark | null
  readonly sharedEvidenceId: string | null
  readonly reuse: AssertionRecord['reuse']
  readonly perImplementation: boolean
  readonly gate: AssertionRecord['gate']
}

export interface CaseContext {
  readonly contract: string
  readonly scenario: ScenarioName
  readonly qualification: Qualification
  readonly providerId: string
  readonly clock: InjectedClock
  readonly container: TestServiceContainer
  readonly inbox: RuntimeInboxFixture
}

export interface CaseRegistration {
  readonly contract: string
  readonly scenario: ScenarioName
  readonly qualification: Qualification
  readonly providerId: string
  run(context: CaseContext): AssertionInput | Promise<AssertionInput>
}

export interface ConformanceRunRequest {
  readonly contracts: readonly string[] | 'all'
  readonly providers: readonly string[]
  readonly command: string
  readonly clock: InjectedClock
}

export interface TestServiceBinding {
  readonly requirement: ServiceRequirement
  readonly binding: BindingRef
  readonly query?: BoundService['query']
  readonly compute?: BoundService['compute']
  readonly artifactAccess?: NonNullable<BoundService['artifactAccess']>
  readonly blobRead?: NonNullable<BoundService['blobRead']>
  readonly clientIngress?: NonNullable<BoundService['clientIngress']>
  readonly clientCommand?: NonNullable<BoundService['clientCommand']>
}

/** Test assembly. Code under test receives `dependencies`, a ScopedDependencies view. */
export interface TestServiceContainer {
  readonly kind: 'test-service-container'
  readonly dependencies: ScopedDependencies
  register(binding: TestServiceBinding): void
  list(): readonly ServiceRequirement[]
}

const DIAGNOSTIC_ID = 'test-service-container'

function failure(code: RuntimeError['code'], detailCode: string, message: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message,
      retryAdvice: { kind: 'never' },
      diagnosticId: DIAGNOSTIC_ID,
    },
  }
}

function featureKey(features: readonly string[]): string {
  return [...features].sort().join('\0')
}

function sameIdentity(left: ServiceRequirement, right: ServiceRequirement): boolean {
  return (
    left.contract === right.contract &&
    left.major === right.major &&
    left.logicalName === right.logicalName &&
    left.scope === right.scope &&
    featureKey(left.features) === featureKey(right.features)
  )
}

function covers(registered: ServiceRequirement, requested: ServiceRequirement): boolean {
  return (
    registered.contract === requested.contract &&
    registered.major === requested.major &&
    registered.logicalName === requested.logicalName &&
    registered.scope === requested.scope &&
    requested.features.every((feature) => registered.features.includes(feature))
  )
}

interface Registration {
  readonly binding: TestServiceBinding
}

function project(binding: TestServiceBinding): BoundService {
  const unavailable = (method: string) =>
    failure('internal', 'method_unavailable', `${method} is not registered`)
  return {
    binding: binding.binding,
    query: binding.query ?? (async () => unavailable('query')),
    compute: binding.compute ?? (async () => unavailable('compute')),
    ...(binding.artifactAccess !== undefined ? { artifactAccess: binding.artifactAccess } : {}),
    ...(binding.blobRead !== undefined ? { blobRead: binding.blobRead } : {}),
    ...(binding.clientIngress !== undefined ? { clientIngress: binding.clientIngress } : {}),
    ...(binding.clientCommand !== undefined ? { clientCommand: binding.clientCommand } : {}),
  }
}

interface Gate {
  closed: boolean
}

function createView(
  root: Gate,
  local: Gate,
  limit: ScopeRef['kind'] | null,
  entries: Registration[],
): ScopedDependencies {
  return {
    get(requirement) {
      if (root.closed || local.closed)
        return failure('denied', 'service_container_closed', 'container is closed')
      if (limit !== null && requirement.scope !== limit) {
        return failure(
          'incompatible',
          'service_scope_mismatch',
          'requirement scope is outside the open scope',
        )
      }
      const matches = entries.filter((entry) => covers(entry.binding.requirement, requirement))
      const match = matches[0]
      if (match === undefined)
        return failure('incompatible', 'service_not_registered', 'service is not registered')
      if (matches.length > 1) return failure('conflict', 'service_ambiguous', 'more than one service matches')
      return { ok: true, value: project(match.binding) }
    },
    async openScope(scope, _context) {
      if (root.closed || local.closed)
        return failure('denied', 'service_container_closed', 'container is closed')
      return { ok: true, value: createView(root, { closed: false }, scope.kind, entries) }
    },
    async close() {
      local.closed = true
    },
  }
}

export function createTestServiceContainer(): TestServiceContainer {
  const root: Gate = { closed: false }
  const entries: Registration[] = []
  const dependencies = createView(root, root, null, entries)
  return {
    kind: 'test-service-container',
    dependencies,
    register(binding) {
      if (
        binding.binding.contract !== binding.requirement.contract ||
        binding.binding.logicalName !== binding.requirement.logicalName
      ) {
        throw new Error('binding does not match requirement')
      }
      if (entries.some((entry) => sameIdentity(entry.binding.requirement, binding.requirement))) {
        throw new Error('service already registered')
      }
      entries.push({ binding })
    },
    list() {
      return entries.map((entry) => entry.binding.requirement)
    },
  }
}

export interface ConformanceHarness {
  readonly kind: 'conformance-harness'
  readonly container: TestServiceContainer
  readonly inbox: RuntimeInboxFixture
  registerCase(registration: CaseRegistration): void
  run(request: ConformanceRunRequest): Promise<ConformanceReport>
}

function knownScenario(value: string): value is ScenarioName {
  return (SCENARIOS as readonly string[]).includes(value)
}

function knownQualification(value: string): value is Qualification {
  return (QUALIFICATIONS as readonly string[]).includes(value)
}

const ABSENT_BUILD: BuildIdentity = {
  codeSha: 'absent',
  buildDigest: 'absent',
  lockDigest: 'absent',
  specVersion: 'absent',
  sdkVersion: 'absent',
  sdkDigest: 'absent',
  platform: 'absent',
}

const ABSENT_REUSE: AssertionRecord['reuse'] = {
  scope: 'unregistered',
  methodKind: 'unregistered',
  lifecycle: 'call',
  undeclaredConnection: false,
}

function absentAssertion(
  contract: string,
  providerId: string,
  request: ConformanceRunRequest,
  build: BuildIdentity,
): AssertionRecord {
  return {
    id: `absent:${providerId}:${contract}`,
    contract,
    scenario: 'select',
    qualification: 'required',
    providerId,
    providerDigest: PROVIDER_ABSENT,
    recipe: providerFileForContract(contract),
    features: [],
    build,
    consumer: 'unregistered',
    command: request.command,
    startedAt: request.clock.startedAt,
    finishedAt: request.clock.finishedAt,
    status: 'failed',
    configDigest: 'absent',
    releaseSetDigest: 'absent',
    attachmentDigest: null,
    fixture: null,
    sharedEvidenceId: null,
    reuse: ABSENT_REUSE,
    perImplementation: true,
    gate: null,
  }
}

function refusalAssertion(
  kind: Extract<GateKind, 'shared-authority' | 'remote-call'>,
  providerId: string,
  request: ConformanceRunRequest,
  build: BuildIdentity,
): AssertionRecord {
  return {
    id: `gate:${kind}`,
    contract: kind,
    scenario: 'deny',
    qualification: 'not-advertised',
    providerId,
    providerDigest: 'gate-observation',
    recipe: `gate:${kind}`,
    features: [],
    build,
    consumer: 'unregistered',
    command: request.command,
    startedAt: request.clock.startedAt,
    finishedAt: request.clock.finishedAt,
    status: 'passed',
    configDigest: 'absent',
    releaseSetDigest: 'absent',
    attachmentDigest: null,
    fixture: null,
    sharedEvidenceId: null,
    reuse: { ...ABSENT_REUSE, scope: 'deployment', methodKind: kind },
    perImplementation: true,
    gate: { kind, declared: false, observed: 'refused' },
  }
}

export function createConformanceHarness(): ConformanceHarness {
  const container = createTestServiceContainer()
  const inbox = createRuntimeInboxFixture()
  const cases: CaseRegistration[] = []
  return {
    kind: 'conformance-harness',
    container,
    inbox,
    registerCase(registration) {
      if (!knownScenario(registration.scenario) || !knownQualification(registration.qualification)) {
        throw new Error('case scenario or qualification is not recognized')
      }
      if (registration.providerId === '') throw new Error('case provider is empty')
      cases.push(registration)
    },
    async run(request) {
      const discovered = discoverContracts()
      const known = new Set(discovered.map((item) => item.contract))
      const requested =
        request.contracts === 'all' ? discovered.map((item) => item.contract) : [...request.contracts]
      const selected = new Set(requested)
      const unknownContracts = requested.filter((contract) => !known.has(contract))
      const assertions: AssertionRecord[] = []
      for (const registration of cases) {
        if (!selected.has(registration.contract)) continue
        if (!request.providers.includes(registration.providerId)) continue
        const input = await registration.run({
          contract: registration.contract,
          scenario: registration.scenario,
          qualification: registration.qualification,
          providerId: registration.providerId,
          clock: request.clock,
          container,
          inbox,
        })
        if (input.fixture !== null && !(FIXTURE_MARKS as readonly string[]).includes(input.fixture)) {
          throw new Error('case fixture mark is not recognized')
        }
        assertions.push({
          ...input,
          contract: registration.contract,
          scenario: registration.scenario,
          qualification: registration.qualification,
          providerId: registration.providerId,
          startedAt: request.clock.startedAt,
          finishedAt: request.clock.finishedAt,
        })
      }
      const build = assertions[0]?.build ?? ABSENT_BUILD
      for (const contract of requested) {
        if (!known.has(contract)) continue
        for (const providerId of request.providers) {
          const covered = assertions.some(
            (item) => item.contract === contract && item.providerId === providerId,
          )
          if (!covered) assertions.push(absentAssertion(contract, providerId, request, build))
        }
      }
      if (request.contracts === 'all') {
        const providerId = request.providers[0] ?? 'unregistered'
        assertions.push(refusalAssertion('shared-authority', providerId, request, build))
        assertions.push(refusalAssertion('remote-call', providerId, request, build))
      }
      const draft: ReportDraft = {
        contracts: requested,
        providers: [...request.providers],
        unknownContracts,
        command: request.command,
        startedAt: request.clock.startedAt,
        finishedAt: request.clock.finishedAt,
        assertions,
        ...(request.contracts === 'all' ? { enforceCatalogGates: true } : {}),
      }
      return judgeReport(draft)
    },
  }
}

export type { FailureCode }
