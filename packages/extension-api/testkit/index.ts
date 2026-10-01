import type { JsonValue } from '@agnes/protocol'
import type { ExtensionErrorCode } from '../src/errors.js'
import type { HookEvent } from '../src/hooks.js'
import type { SlotContext, SlotName } from '../src/slots.js'
export const NEGATIVE_ACTIONS = Object.freeze([
  'undeclared-api',
  'bad-slot-payload',
  'bad-event-name',
  'infinite-loop',
  'lease-exhausted',
] as const)
export type NegativeAction = (typeof NEGATIVE_ACTIONS)[number]
export type ToolCase = {
  kind: 'tool'
  id: string
  tool: string
  args: JsonValue
  expect: { isError?: boolean; contentIncludes?: string; detailsEquals?: JsonValue; leaseDelta?: number }
}
export type HookCase = {
  kind: 'hook'
  id: string
  event: HookEvent
  payload: JsonValue
  expect: { returnEquals?: JsonValue; timeoutMs?: number }
}
export type SlotCase = {
  kind: 'slot'
  id: string
  slot: SlotName
  trigger: SlotContext['trigger']
  surface: SlotContext['surface']
  expect: { payloadEquals?: JsonValue; empty?: boolean }
}
export type NegativeCase = {
  kind: 'negative'
  id: string
  action: NegativeAction
  expect: { errorCode: ExtensionErrorCode }
}
export type FixtureCase = ToolCase | HookCase | SlotCase | NegativeCase
export interface ExtensionFixture {
  name: string
  /** Runner resolves an omitted path as ./agnes.extension.json relative to the fixture. */
  manifest?: string
  cases: FixtureCase[]
}
/** Authoring helper only; case execution and path defaults belong to the runner. */
export function defineFixture(fixture: ExtensionFixture): ExtensionFixture {
  return fixture
}
export { projectionFixture } from './fixtures/projections.js'
export { serviceFixture } from './fixtures/services.js'
export type {
  AssertionInput,
  AssertionRecord,
  AssertionStatus,
  BuildIdentity,
  CaseContext,
  CaseRegistration,
  ConformanceHarness,
  ConformanceReport,
  ConformanceRunRequest,
  DiscoveredContract,
  EvidenceReuse,
  FailureCode,
  FixtureMark,
  GateKind,
  GateObservation,
  InjectedClock,
  Qualification,
  ReportDraft,
  ReportFailure,
  RestrictedFixture,
  ReuseLifecycle,
  RuntimeInboxAcceptance,
  RuntimeInboxFixture,
  RuntimeInboxNotice,
  ScenarioName,
  TestServiceBinding,
  TestServiceContainer,
} from './runtime/index.js'
export {
  ASSERTION_STATUSES,
  CATALOG_GATES,
  createConformanceHarness,
  createRuntimeInboxFixture,
  createTestServiceContainer,
  discoverContracts,
  FAILURE_CODES,
  FIXTURE_MARKS,
  faultPoint,
  GATE_KINDS,
  judgeReport,
  LEGACY_FIXTURES,
  PROVIDER_ABSENT,
  providerFileForContract,
  QUALIFICATIONS,
  RUNTIME_INBOX_FIXTURE,
  SCENARIOS,
  serializeReport,
} from './runtime/index.js'
export {
  TRANSPORT_CONTRACT_CASES,
  type TransportContractCase,
  type TransportFixture,
} from './transport-contract.js'
