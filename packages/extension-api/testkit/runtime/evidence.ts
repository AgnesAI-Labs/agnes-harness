export const SCENARIOS = ['select', 'normal', 'deny', 'cancel', 'recover', 'dispose'] as const
export type ScenarioName = (typeof SCENARIOS)[number]
export const QUALIFICATIONS = ['required', 'advertised', 'not-advertised'] as const
export type Qualification = (typeof QUALIFICATIONS)[number]
export const ASSERTION_STATUSES = ['passed', 'failed', 'skipped'] as const
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number]
export const FIXTURE_MARKS = ['runtime-inbox', 'test-service-container'] as const
export type FixtureMark = (typeof FIXTURE_MARKS)[number]

export interface BuildIdentity {
  readonly codeSha: string
  readonly buildDigest: string
  readonly lockDigest: string
  readonly specVersion: string
  readonly sdkVersion: string
  readonly sdkDigest: string
  readonly platform: string
}

export interface AssertionRecord {
  readonly id: string
  readonly contract: string
  readonly scenario: ScenarioName
  readonly qualification: Qualification
  readonly providerId: string
  readonly providerDigest: string
  readonly recipe: string
  readonly features: readonly string[]
  readonly build: BuildIdentity
  readonly consumer: string
  readonly command: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly status: AssertionStatus
  readonly configDigest: string
  readonly releaseSetDigest: string
  readonly attachmentDigest: string | null
  readonly fixture: FixtureMark | null
  readonly sharedEvidenceId: string | null
}

export const FAILURE_CODES = ['missing-evidence', 'mixed-version', 'empty-run'] as const
export type FailureCode = (typeof FAILURE_CODES)[number]

export interface ReportFailure {
  readonly code: FailureCode
  readonly detail: string
}

export interface ReportDraft {
  readonly contracts: readonly string[]
  readonly providers: readonly string[]
  readonly unknownContracts: readonly string[]
  readonly command: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly assertions: readonly AssertionRecord[]
}

export interface ConformanceReport extends ReportDraft {
  readonly status: 'passed' | 'failed'
  readonly failures: readonly ReportFailure[]
}

const TEXT_FIELDS = [
  'id',
  'contract',
  'providerId',
  'providerDigest',
  'recipe',
  'consumer',
  'command',
  'configDigest',
  'releaseSetDigest',
  'startedAt',
  'finishedAt',
] as const

const BUILD_FIELDS = [
  'codeSha',
  'buildDigest',
  'lockDigest',
  'specVersion',
  'sdkVersion',
  'sdkDigest',
  'platform',
] as const

const VERSION_FIELDS = ['sdkDigest', 'lockDigest', 'buildDigest', 'specVersion'] as const

function compare(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.some((item) => item === value)
}

interface ReadAssertion {
  readonly assertion: AssertionRecord | null
  readonly missing: readonly string[]
}

function readAssertion(value: unknown): ReadAssertion {
  if (!isRecord(value)) return { assertion: null, missing: ['assertion'] }
  const missing: string[] = []
  for (const field of TEXT_FIELDS) {
    if (text(value[field]) === null) missing.push(field)
  }
  if (!member(SCENARIOS, value.scenario)) missing.push('scenario')
  if (!member(QUALIFICATIONS, value.qualification)) missing.push('qualification')
  if (!member(ASSERTION_STATUSES, value.status)) missing.push('status')
  if (!Array.isArray(value.features) || value.features.some((feature) => text(feature) === null)) {
    missing.push('features')
  }
  const build = isRecord(value.build) ? value.build : null
  if (build === null) missing.push('build')
  else {
    for (const field of BUILD_FIELDS) {
      if (text(build[field]) === null) missing.push(`build.${field}`)
    }
  }
  if (value.attachmentDigest !== null && text(value.attachmentDigest) === null)
    missing.push('attachmentDigest')
  if (value.fixture !== null && !member(FIXTURE_MARKS, value.fixture)) missing.push('fixture')
  if (value.sharedEvidenceId !== null && text(value.sharedEvidenceId) === null)
    missing.push('sharedEvidenceId')
  if (missing.length > 0 || build === null) return { assertion: null, missing }
  const assertion: AssertionRecord = {
    id: text(value.id) as string,
    contract: text(value.contract) as string,
    scenario: value.scenario as ScenarioName,
    qualification: value.qualification as Qualification,
    providerId: text(value.providerId) as string,
    providerDigest: text(value.providerDigest) as string,
    recipe: text(value.recipe) as string,
    features: (value.features as string[]).slice(),
    build: {
      codeSha: text(build.codeSha) as string,
      buildDigest: text(build.buildDigest) as string,
      lockDigest: text(build.lockDigest) as string,
      specVersion: text(build.specVersion) as string,
      sdkVersion: text(build.sdkVersion) as string,
      sdkDigest: text(build.sdkDigest) as string,
      platform: text(build.platform) as string,
    },
    consumer: text(value.consumer) as string,
    command: text(value.command) as string,
    startedAt: text(value.startedAt) as string,
    finishedAt: text(value.finishedAt) as string,
    status: value.status as AssertionStatus,
    configDigest: text(value.configDigest) as string,
    releaseSetDigest: text(value.releaseSetDigest) as string,
    attachmentDigest: value.attachmentDigest === null ? null : (text(value.attachmentDigest) as string),
    fixture: value.fixture === null ? null : (value.fixture as FixtureMark),
    sharedEvidenceId: value.sharedEvidenceId === null ? null : (text(value.sharedEvidenceId) as string),
  }
  return { assertion, missing: [] }
}

function versionKey(assertion: AssertionRecord): string {
  return VERSION_FIELDS.map((field) => assertion.build[field]).join('\0')
}

function countsAsRun(assertion: AssertionRecord): boolean {
  return assertion.qualification !== 'not-advertised' && assertion.status !== 'skipped'
}

function emptyDetail(assertions: readonly AssertionRecord[]): string | null {
  if (assertions.length === 0) return 'zero assertions'
  if (assertions.every((assertion) => assertion.status === 'skipped')) return 'all skipped'
  if (assertions.every((assertion) => assertion.qualification === 'not-advertised')) {
    return 'all not-advertised'
  }
  if (assertions.every((assertion) => !countsAsRun(assertion))) return 'no executed assertion'
  return null
}

function push(failures: ReportFailure[], code: FailureCode, detail: string) {
  failures.push({ code, detail })
}

export function judgeReport(draft: ReportDraft): ConformanceReport {
  const failures: ReportFailure[] = []
  if (text(draft.command) === null) push(failures, 'missing-evidence', 'report missing command')
  if (text(draft.startedAt) === null) push(failures, 'missing-evidence', 'report missing startedAt')
  if (text(draft.finishedAt) === null) push(failures, 'missing-evidence', 'report missing finishedAt')
  const assertions: AssertionRecord[] = []
  let unparsed = 0
  for (let index = 0; index < draft.assertions.length; index += 1) {
    const read = readAssertion(draft.assertions[index])
    if (read.assertion === null) {
      unparsed += 1
      push(failures, 'missing-evidence', `assertion ${index} missing ${read.missing.join(',')}`)
      continue
    }
    assertions.push(read.assertion)
  }
  for (const contract of uniqueSorted(draft.unknownContracts)) {
    push(failures, 'missing-evidence', `unknown contract ${contract}`)
  }
  const shellReady =
    text(draft.command) !== null && text(draft.startedAt) !== null && text(draft.finishedAt) !== null
  const empty = unparsed > 0 ? null : emptyDetail(assertions)
  if (empty !== null && (empty !== 'zero assertions' || shellReady)) push(failures, 'empty-run', empty)
  const versions = new Set(assertions.map(versionKey))
  if (versions.size > 1)
    push(failures, 'mixed-version', 'mixed sdkDigest, lockDigest, buildDigest or specVersion')
  for (const assertion of assertions) {
    if (assertion.qualification === 'required' && assertion.status === 'skipped') {
      push(
        failures,
        'missing-evidence',
        `required ${assertion.contract} ${assertion.scenario} ${assertion.id} skipped`,
      )
    }
    if (assertion.sharedEvidenceId === null) continue
    const shared = assertions.find((item) => item.id === assertion.sharedEvidenceId)
    const sameSdk =
      shared !== undefined &&
      shared.build.sdkDigest === assertion.build.sdkDigest &&
      shared.build.sdkVersion === assertion.build.sdkVersion &&
      shared.status === 'passed' &&
      shared.qualification !== 'not-advertised'
    if (!sameSdk) {
      push(
        failures,
        'missing-evidence',
        `shared evidence ${assertion.id} missing ${assertion.sharedEvidenceId}`,
      )
    }
  }
  failures.sort((left, right) => compare(left.code, right.code) || compare(left.detail, right.detail))
  const assertionFailed = assertions.some((assertion) => assertion.status === 'failed')
  return {
    contracts: uniqueSorted(draft.contracts),
    providers: uniqueSorted(draft.providers),
    unknownContracts: uniqueSorted(draft.unknownContracts),
    command: draft.command,
    startedAt: draft.startedAt,
    finishedAt: draft.finishedAt,
    assertions,
    status: failures.length === 0 && !assertionFailed ? 'passed' : 'failed',
    failures,
  }
}

function sortValue(value: unknown): unknown {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('report number is not finite')
    return value
  }
  if (Array.isArray(value)) return value.map(sortValue)
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort(compare)) {
      if (record[key] === undefined) throw new Error(`report field ${key} is undefined`)
      sorted[key] = sortValue(record[key])
    }
    return sorted
  }
  throw new Error('report value is not json')
}

export function serializeReport(report: ConformanceReport): string {
  return `${JSON.stringify(sortValue(report))}\n`
}
