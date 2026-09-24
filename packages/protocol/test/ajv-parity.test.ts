// Permanent ajv ↔ TypeBox differential testing. Every review round of the first eight tasks stood up
// a throwaway ajv comparison script and deleted it once it had served its purpose, so no guard was
// ever left behind — while the generator's semantics-losing failure modes (always-false validators,
// dropped outer constraints) are visible only to differential testing. Neither the unit tests nor the
// type checker can see them. This file turns that comparison into permanent cases that run on every
// `pnpm test`:
//   - Covers every $def of schema/session-v1.json and schema/agnes-v1.json, plus the params and
//     result (where a result exists) of every method in the METHODS table. Coverage itself is pinned
//     by a drift guard comparing `$defs` against the hand-written Record in both directions (see the
//     describe at the end of the file), so adding a $def to a schema and forgetting to register it
//     here goes red immediately.
//   - One valid sample plus **a set of** invalid samples per entry (`Sample.invalid: unknown[]`). The
//     important change: each $def used to have exactly one negative case, nearly always "missing a
//     required field" or "garbage enum value". ajv and TypeBox naturally agree on those two, so they
//     are precisely where a divergence is least likely to show. Real generator defects — a dropped
//     outer maxLength, an always-false validator, a parked const+combinator — all present as "one
//     constraint quietly vanished, everything else behaves" and can only be caught by a negative case
//     sitting **exactly one step outside that constraint's boundary**. So every node carrying
//     maxLength / minLength / pattern / minimum / maximum / minItems / format has at least one "one
//     step over the line" negative case.
//     Acceptance line: re-plant the dropped-maxLength defect in gen/ts/session-v1.ts (make the
//     EventEnvelope.type extension branch lose maxLength:128) and this file's
//     `EventEnvelope: invalid[1]` (a 208-character extension type) and `invalid[2]` (129 characters)
//     must both go red.
//   - Two known library-level differences live in the KNOWN_DIFFS table, consumed by the generic loop
//     as a **lookup**: a hit asserts the specific pair of verdicts registered in the table, and any
//     divergence not in the table is judged red under "both sides must agree". So deleting an entry
//     makes that sample fall back to the generic assertion and go red — removing an entry makes a
//     test fail rather than silently pass.
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { TSchema } from '@sinclair/typebox'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
// ajv and ajv-formats are both CJS packages and this repo's tsconfig does not enable
// esModuleInterop. A static `import Ajv2020 from 'ajv/dist/2020'` — or a namespace import reaching
// for `.default` — is judged by tsc under `module:NodeNext` + `verbatimModuleSyntax` as "the whole
// module namespace is neither constructable nor callable". Both spellings were reproduced; this is
// the known CJS interop trap for ajv-formats' `exports.default = module.exports` self-reference when
// esModuleInterop is off.
// The workaround is to fetch the real CJS value at runtime via `createRequire` and bring the types in
// separately with `import type` (type imports are unaffected by this interop rule under
// erasableSyntaxOnly) — rather than change a repo-wide esModuleInterop setting for one test file.
import type { Ajv2020 as Ajv2020Class } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import * as AcpGen from '../gen/ts/acp.js'
import * as AgnesGen from '../gen/ts/agnes-v1.js'
import * as AuthzGen from '../gen/ts/authz.js'
import * as BridgeGen from '../gen/ts/bridge.js'
import * as ChannelGen from '../gen/ts/channel.js'
import * as DeployManifestGen from '../gen/ts/deploy-manifest.js'
import * as ExtensionManifestGen from '../gen/ts/extension-manifest.js'
import * as ServiceGen from '../gen/ts/extension-service.js'
import * as HooksGen from '../gen/ts/hooks.js'
import * as JobsGen from '../gen/ts/jobs.js'
import * as LockfileGen from '../gen/ts/lockfile.js'
import * as ModelGen from '../gen/ts/model.js'
import * as PackageAdminGen from '../gen/ts/package-admin.js'
import * as PresetGen from '../gen/ts/preset.js'
import * as ProfileGen from '../gen/ts/profile.js'
import * as ProjectionGen from '../gen/ts/projection.js'
import * as ResourceControlGen from '../gen/ts/resource-control.js'
import * as SessionGen from '../gen/ts/session-v1.js'
import * as SlotsGen from '../gen/ts/slots.js'
import * as SurfaceGen from '../gen/ts/surface.js'
import * as ToolDefGen from '../gen/ts/tooldef.js'
import * as WorkerGen from '../gen/ts/worker.js'
import {
  METHODS,
  type MethodName,
  type MethodSpec,
  validateAgainst,
  validateMethod,
  validateRequestMedia,
} from '../src/index.js'

type Json = Record<string, unknown>
type FixtureRow = { id: string; payload: unknown }
type Sample = { valid: unknown; invalid: unknown[]; note: string }

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))

/** Build an n-character string, used to construct "one step over the line" length negatives. */
const rep = (n: number) => 'a'.repeat(n)
/** The canonical valid Sha256 value, used wherever this document requires one. */
const rep64 = 'a'.repeat(64)
/** Deep copy for fixture baselines whose nested fields need changing — fixture objects are shared
 * across several negative cases and must not be mutated in place. */
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

function loadJsonl(path: string): FixtureRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as FixtureRow)
}

function byId(rows: FixtureRow[], id: string): unknown {
  const row = rows.find((r) => r.id === id)
  if (!row) throw new Error(`fixture not found: ${id}`)
  return row.payload
}

const envelopeFixtures = loadJsonl(`${pkgRoot}fixtures/events/envelope.jsonl`)
const i1TypeFixtures = loadJsonl(`${pkgRoot}fixtures/events/i1-types.jsonl`)
const i2TypeFixtures = loadJsonl(`${pkgRoot}fixtures/events/i2-types.jsonl`)
const requestMediaFixtures = loadJsonl(`${pkgRoot}fixtures/events/request-media.jsonl`)
const methodFixtures = loadJsonl(`${pkgRoot}fixtures/methods/i1.jsonl`)

function dataOf(id: string): unknown {
  return (byId(i1TypeFixtures, id) as Json).data
}

function i2DataOf(id: string): unknown {
  return (byId(i2TypeFixtures, id) as Json).data
}

function requestMediaDataOf(id: string): unknown {
  return (byId(requestMediaFixtures, id) as Json).data
}

// ---------------------------------------------------------------------------
// The ajv side: real ajv (2020-12) plus ajv-formats. session-v1.json and agnes-v1.json reference each
// other across files (agnes-v1.json's relative `session-v1.json#/$defs/JsonValue` resolves via $id),
// so adding both to one instance with addSchema is enough. The upstream ACP schema carries no $id and
// is added under the explicit key 'acp'.
// strict:false / allowUnionTypes:true: both schemas use union types like `type:["string","null"]`,
// along with x-* extension keys and `discriminator` (on the ACP side). None of these are shapes ajv's
// strict mode recognises, yet all are either legal 2020-12 keywords or pure annotation keys — without
// relaxing these two options, compilation throws outright.
const sessionSchemaDoc = JSON.parse(readFileSync(`${pkgRoot}schema/session-v1.json`, 'utf8')) as Json
const agnesSchemaDoc = JSON.parse(readFileSync(`${pkgRoot}schema/agnes-v1.json`, 'utf8')) as Json
const modelSchemaDoc = JSON.parse(readFileSync(`${pkgRoot}schema/model.json`, 'utf8')) as Json
const toolDefSchemaDoc = JSON.parse(readFileSync(`${pkgRoot}schema/tooldef.json`, 'utf8')) as Json
const hooksSchemaDoc = JSON.parse(readFileSync(`${pkgRoot}schema/hooks.json`, 'utf8')) as Json
const slotsSchemaDoc = JSON.parse(readFileSync(`${pkgRoot}schema/slots.json`, 'utf8')) as Json
const presetSchemaDoc = JSON.parse(readFileSync(`${pkgRoot}schema/preset.json`, 'utf8')) as Json
const ProfileDoc = JSON.parse(readFileSync(`${pkgRoot}schema/profile.json`, 'utf8')) as Json
const LockfileDoc = JSON.parse(readFileSync(`${pkgRoot}schema/lockfile.json`, 'utf8')) as Json
const ExtensionManifestDoc = JSON.parse(
  readFileSync(`${pkgRoot}schema/extension-manifest.json`, 'utf8'),
) as Json
const DeployManifestDoc = JSON.parse(readFileSync(`${pkgRoot}schema/deploy-manifest.json`, 'utf8')) as Json
const JobsDoc = JSON.parse(readFileSync(`${pkgRoot}schema/jobs.json`, 'utf8')) as Json
const AuthzDoc = JSON.parse(readFileSync(`${pkgRoot}schema/authz.json`, 'utf8')) as Json
const ChannelDoc = JSON.parse(readFileSync(`${pkgRoot}schema/channel.json`, 'utf8')) as Json
const BridgeDoc = JSON.parse(readFileSync(`${pkgRoot}schema/bridge.json`, 'utf8')) as Json
const WorkerDoc = JSON.parse(readFileSync(`${pkgRoot}schema/worker.json`, 'utf8')) as Json
const acpSchemaDoc = JSON.parse(readFileSync(`${pkgRoot}schema/acp/schema.json`, 'utf8')) as Json
const acpUpstreamMd = readFileSync(`${pkgRoot}schema/acp/UPSTREAM.md`, 'utf8')

const nodeRequire = createRequire(import.meta.url)
const AjvCtor = nodeRequire('ajv/dist/2020.js').Ajv2020 as typeof Ajv2020Class
const addFormats = nodeRequire('ajv-formats') as (ajv: InstanceType<typeof Ajv2020Class>) => void

const ajv = new AjvCtor({ strict: false, allowUnionTypes: true })
addFormats(ajv)
// Reference validator uses URL parsing as required by the owned custom format's contract.
ajv.addFormat('agnes-git-source', (ref: string) => {
  if (!ref.startsWith('git:')) return false
  const split = ref.lastIndexOf('#')
  if (split < 4 || !/^[a-f0-9]{40}$/.test(ref.slice(split + 1))) return false
  try {
    const url = new URL(ref.slice(4, split))
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
})
const SurfaceDoc = JSON.parse(readFileSync(`${pkgRoot}schema/surface.json`, 'utf8')) as Json
ajv.addSchema(SurfaceDoc)
const PackageAdminDoc = JSON.parse(readFileSync(`${pkgRoot}schema/package-admin.json`, 'utf8')) as Json
ajv.addSchema(PackageAdminDoc)
const ResourceControlDoc = JSON.parse(readFileSync(`${pkgRoot}schema/resource-control.json`, 'utf8')) as Json
ajv.addSchema(ResourceControlDoc)
const ServiceDoc = JSON.parse(readFileSync(`${pkgRoot}schema/extension-service.json`, 'utf8')) as Json
ajv.addSchema(ServiceDoc)
const ProjectionDoc = JSON.parse(readFileSync(`${pkgRoot}schema/projection.json`, 'utf8')) as Json
ajv.addSchema(ProjectionDoc)
ajv.addSchema(sessionSchemaDoc)
ajv.addSchema(agnesSchemaDoc)
ajv.addSchema(modelSchemaDoc)
ajv.addSchema(toolDefSchemaDoc)
ajv.addSchema(hooksSchemaDoc)
ajv.addSchema(slotsSchemaDoc)
ajv.addSchema(presetSchemaDoc)
ajv.addSchema(ProfileDoc)
ajv.addSchema(LockfileDoc)
ajv.addSchema(ExtensionManifestDoc)
ajv.addSchema(DeployManifestDoc)
ajv.addSchema(JobsDoc)
ajv.addSchema(AuthzDoc)
ajv.addSchema(ChannelDoc)
ajv.addSchema(BridgeDoc)
ajv.addSchema(WorkerDoc)

ajv.addSchema(acpSchemaDoc, 'acp')

const SESSION_ID = 'https://agnes.ai/schema/session-v1.json'
const AGNES_ID = 'https://agnes.ai/schema/agnes-v1.json'
const MODEL_ID = 'https://agnes.ai/schema/model.json'
const TOOLDEF_ID = 'https://agnes.ai/schema/tooldef.json'
const HOOKS_ID = 'https://agnes.ai/schema/hooks.json'
const SLOTS_ID = 'https://agnes.ai/schema/slots.json'
const PRESET_ID = 'https://agnes.ai/schema/preset.json'
const ACP_ID = 'acp'
// Comparison entries that come from no schema file (the format checkers themselves) hang under this
// scope and go through the same generic loop, rather than being free-standing `it`s.
const FORMATS_ID = 'format-checkers'

function ajvDef(fileId: string, name: string): (x: unknown) => boolean {
  const validate = ajv.getSchema(`${fileId}#/$defs/${name}`)
  if (!validate) throw new Error(`ajv: no compiled schema for ${fileId}#/$defs/${name}`)
  return (x: unknown) => validate(x) === true
}

// ---------------------------------------------------------------------------
// The TypeBox side: every $def constant exported by name from the generated module.
// These three tables **must** be name-for-name equal to the `$defs` key set of the corresponding
// schema document — the drift guard at the end of the file compares both directions, so adding a $def
// to a schema without registering it here (or the reverse) goes red.

const SESSION_DEFS: Record<string, TSchema> = {
  JsonValue: SessionGen.JsonValue,
  Actor: SessionGen.Actor,
  ContentBlock: SessionGen.ContentBlock,
  SurfaceOp: SessionGen.SurfaceOp,
  EventEnvelope: SessionGen.EventEnvelope,
  SessionStart: SessionGen.SessionStart,
  SubagentCost: SessionGen.SubagentCost,
  TurnStart: SessionGen.TurnStart,
  TurnEnd: SessionGen.TurnEnd,
  StepStart: SessionGen.StepStart,
  StepEnd: SessionGen.StepEnd,
  UserMessage: SessionGen.UserMessage,
  AssistantMessage: SessionGen.AssistantMessage,
  ResolvedToolCallPolicy: SessionGen.ResolvedToolCallPolicy,
  ExecutionDomain: SessionGen.ExecutionDomain,
  DispatchPhase: SessionGen.DispatchPhase,
  ToolCall: SessionGen.ToolCall,
  ToolResult: SessionGen.ToolResult,
  RequestMediaManifestEntry: SessionGen.RequestMediaManifestEntry,
  RequestMediaManifest: SessionGen.RequestMediaManifest,
  RequestMediaHeader: SessionGen.RequestMediaHeader,
  RequestHeader: SessionGen.RequestHeader,
  RequestSent: SessionGen.RequestSent,
  OpState: SessionGen.OpState,
  ToolCallState: SessionGen.ToolCallState,
  ArtifactRef: SessionGen.ArtifactRef,
  Verdict: SessionGen.Verdict,
  AssistantOutput: SessionGen.AssistantOutput,
  PlanItems: SessionGen.PlanItems,
  BudgetState: SessionGen.BudgetState,
  ArtifactJob: SessionGen.ArtifactJob,
  InboxItem: SessionGen.InboxItem,
  Inbox: SessionGen.Inbox,
  HarnessEntryValue: SessionGen.HarnessEntryValue,
  HarnessEntry: SessionGen.HarnessEntry,
  EffectIntent: SessionGen.EffectIntent,
  EffectSettled: SessionGen.EffectSettled,
  VerifierSignal: SessionGen.VerifierSignal,
  RepairDecision: SessionGen.RepairDecision,
  FormatDeviation: SessionGen.FormatDeviation,
  Billing: SessionGen.Billing,
  CostLedger: SessionGen.CostLedger,
  ApprovalAsked: SessionGen.ApprovalAsked,
  ApprovalDecided: SessionGen.ApprovalDecided,
  ApprovalGrant: SessionGen.ApprovalGrant,
  ApprovalGuardianDecision: SessionGen.ApprovalGuardianDecision,
  FeedbackRating: SessionGen.FeedbackRating,
  FeedbackImplicit: SessionGen.FeedbackImplicit,
  Participant: SessionGen.Participant,
  HarnessRefine: SessionGen.HarnessRefine,
}

const AGNES_DEFS: Record<string, TSchema> = {
  PackageActivationTrust: AgnesGen.PackageActivationTrust,
  PackageActivationRequest: AgnesGen.PackageActivationRequest,
  PackageRollbackTarget: AgnesGen.PackageRollbackTarget,
  PackageAdminContext: AgnesGen.PackageAdminContext,
  PackageCatalogDescriptor: AgnesGen.PackageCatalogDescriptor,
  PackageCatalogGetParams: AgnesGen.PackageCatalogGetParams,
  PackageCatalogListParams: AgnesGen.PackageCatalogListParams,
  PackageCatalogPage: AgnesGen.PackageCatalogPage,
  PackageDisableParams: AgnesGen.PackageDisableParams,
  PackageEnableParams: AgnesGen.PackageEnableParams,
  PackageInspectParams: AgnesGen.PackageInspectParams,
  PackageInstallParams: AgnesGen.PackageInstallParams,
  PackageListParams: AgnesGen.PackageListParams,
  SkinReadParams: AgnesGen.SkinReadParams,
  ClientModuleReadParams: AgnesGen.ClientModuleReadParams,
  PackageListResult: AgnesGen.PackageListResult,
  PackageOperation: AgnesGen.PackageOperation,
  PackageOperationCancelParams: AgnesGen.PackageOperationCancelParams,
  PackageOperationGetParams: AgnesGen.PackageOperationGetParams,
  PackageOperationReceipt: AgnesGen.PackageOperationReceipt,
  PackagePinsInspectParams: AgnesGen.PackagePinsInspectParams,
  PackagePinsInspectResult: AgnesGen.PackagePinsInspectResult,
  PackagePinsReleaseParams: AgnesGen.PackagePinsReleaseParams,
  PackagePinsReleaseResult: AgnesGen.PackagePinsReleaseResult,
  PackageRemoveParams: AgnesGen.PackageRemoveParams,
  PackageRollbackParams: AgnesGen.PackageRollbackParams,
  PackageTrustParams: AgnesGen.PackageTrustParams,
  PackageUntrustParams: AgnesGen.PackageUntrustParams,
  PackageTrustWorkspaceParams: AgnesGen.PackageTrustWorkspaceParams,
  PackageTrustWorkspaceResult: AgnesGen.PackageTrustWorkspaceResult,
  PackageUpdateParams: AgnesGen.PackageUpdateParams,
  PluginTreeApplyParams: AgnesGen.PluginTreeApplyParams,
  PluginTreeRollbackParams: AgnesGen.PluginTreeRollbackParams,
  PluginTreeView: AgnesGen.PluginTreeView,
  PluginTreeApplyResult: AgnesGen.PluginTreeApplyResult,
  PluginTreeRollbackResult: AgnesGen.PluginTreeRollbackResult,

  ExtensionCallParams: AgnesGen.ExtensionCallParams,
  ExtensionCallResult: AgnesGen.ExtensionCallResult,
  ExtensionAckParams: AgnesGen.ExtensionAckParams,
  ExtensionCallError: AgnesGen.ExtensionCallError,
  ConfigAccount: AgnesGen.ConfigAccount,
  ConfigAccountInput: AgnesGen.ConfigAccountInput,
  ConfigOAuthInput: AgnesGen.ConfigOAuthInput,
  ConfigOAuthResult: AgnesGen.ConfigOAuthResult,
  ConfigOAuthPrompt: AgnesGen.ConfigOAuthPrompt,
  ConfigOAuthNotice: AgnesGen.ConfigOAuthNotice,
  ConfigProvider: AgnesGen.ConfigProvider,
  ConfigModel: AgnesGen.ConfigModel,
  ConfigSnapshot: AgnesGen.ConfigSnapshot,
  ConfigTestInput: AgnesGen.ConfigTestInput,
  ConfigTestResult: AgnesGen.ConfigTestResult,
  ConfigSaveInput: AgnesGen.ConfigSaveInput,
  ConfigProvidersResult: AgnesGen.ConfigProvidersResult,
  ConfigEmptyParams: AgnesGen.ConfigEmptyParams,

  JwtCredential: AgnesGen.JwtCredential,
  SourceAuthCredential: AgnesGen.SourceAuthCredential,
  PortalIdentityCredential: AgnesGen.PortalIdentityCredential,
  LocalCredential: AgnesGen.LocalCredential,
  SurfaceAuthCredential: AgnesGen.SurfaceAuthCredential,

  BudgetState: AgnesGen.BudgetState,
  ArtifactRef: AgnesGen.ArtifactRef,
  ArtifactJob: AgnesGen.ArtifactJob,
  ArtifactReadParams: AgnesGen.ArtifactReadParams,
  ArtifactReadResult: AgnesGen.ArtifactReadResult,
  Credential: AgnesGen.Credential,
  DirectoryEntry: AgnesGen.DirectoryEntry,
  JobSpec: AgnesGen.JobSpec,
  JobStatus: AgnesGen.JobStatus,
  SessionBudgetResult: AgnesGen.SessionBudgetResult,
  SessionProjectUIParams: AgnesGen.SessionProjectUIParams,
  SessionProjectUIPatchParams: AgnesGen.SessionProjectUIPatchParams,
  SessionProjectUIOpeningParams: AgnesGen.SessionProjectUIOpeningParams,
  UIHistoryCursor: AgnesGen.UIHistoryCursor,
  SessionProjectUIHistoryParams: AgnesGen.SessionProjectUIHistoryParams,
  SlotFillView: AgnesGen.SlotFillView,
  UINode: AgnesGen.UINode,
  UsageView: AgnesGen.UsageView,
  UITurnCall: AgnesGen.UITurnCall,
  UITurnUsage: AgnesGen.UITurnUsage,
  UISpan: AgnesGen.UISpan,
  UITurn: AgnesGen.UITurn,
  UIOperationState: AgnesGen.UIOperationState,
  UITimeline: AgnesGen.UITimeline,
  UIHistoryInfo: AgnesGen.UIHistoryInfo,
  UIOpeningResult: AgnesGen.UIOpeningResult,
  UIHistoryPage: AgnesGen.UIHistoryPage,
  UIProjectionNodeChange: AgnesGen.UIProjectionNodeChange,
  UIProjectionTurnChange: AgnesGen.UIProjectionTurnChange,
  UITimelinePatch: AgnesGen.UITimelinePatch,
  UIProjectionUpdate: AgnesGen.UIProjectionUpdate,
  WorkspaceEntry: AgnesGen.WorkspaceEntry,
  WorkspaceListParams: AgnesGen.WorkspaceListParams,
  WorkspaceListResult: AgnesGen.WorkspaceListResult,
  WorkspaceAddParams: AgnesGen.WorkspaceAddParams,
  WorkspaceAddResult: AgnesGen.WorkspaceAddResult,
  SurfacesMountsParams: AgnesGen.SurfacesMountsParams,
  SurfacesMountsResult: AgnesGen.SurfacesMountsResult,
  JsonValue: AgnesGen.JsonValue,
  // `ContentBlock` used to be injected into the generated module by tools/gen.ts alone, with no name
  // in agnes-v1.json's $defs, and therefore **escaped this table's two-way coverage guard** — the
  // guard compares against the $defs on disk. agnes-v1.json now spells it as an honest cross-file
  // alias, `{"$ref":"session-v1.json#/$defs/ContentBlock"}`, exactly like JsonValue, so the two agree
  // and this entry has to be registered.
  ContentBlock: AgnesGen.ContentBlock,
  // Three more cross-file aliases, on the same footing and for the same reason: SessionEventParams
  // carries a whole ledger row, so EventEnvelope (and the Actor / SurfaceOp it references) is copied
  // into the generated module by tools/gen.ts. Spelled in agnes-v1.json as $refs so the guard below
  // demands them here rather than letting them ride along unnamed.
  Actor: AgnesGen.Actor,
  SurfaceOp: AgnesGen.SurfaceOp,
  EventEnvelope: AgnesGen.EventEnvelope,
  HarnessMeta: AgnesGen.HarnessMeta,
  Auth: AgnesGen.Auth,
  InitializeMeta: AgnesGen.InitializeMeta,
  NewSessionMeta: AgnesGen.NewSessionMeta,
  Cursor: AgnesGen.Cursor,
  AttachFilter: AgnesGen.AttachFilter,
  SessionAttachParams: AgnesGen.SessionAttachParams,
  SessionAttachResult: AgnesGen.SessionAttachResult,
  SessionCompactParams: AgnesGen.SessionCompactParams,
  SessionSteerParams: AgnesGen.SessionSteerParams,
  SessionSteerResult: AgnesGen.SessionSteerResult,
  ApisListParams: AgnesGen.ApisListParams,
  ApisListResult: AgnesGen.ApisListResult,
  SubmitParams: AgnesGen.SubmitParams,
  CommandAckParams: AgnesGen.CommandAckParams,
  Ack: AgnesGen.Ack,
  CompactOutcome: AgnesGen.CompactOutcome,
  ErrorData: AgnesGen.ErrorData,
  SessionIdParams: AgnesGen.SessionIdParams,
  ApprovalGrantListParams: AgnesGen.ApprovalGrantListParams,
  ApprovalGrantRecord: AgnesGen.ApprovalGrantRecord,
  ApprovalGrantRevokeParams: AgnesGen.ApprovalGrantRevokeParams,
  ApprovalGrantListResult: AgnesGen.ApprovalGrantListResult,
  Empty: AgnesGen.Empty,
  ComputerUseLockedPackageMutationStatus: AgnesGen.ComputerUseLockedPackageMutationStatus,
  ComputerUseStatusResult: AgnesGen.ComputerUseStatusResult,
  ComputerUsePermissionsStatusResult: AgnesGen.ComputerUsePermissionsStatusResult,
  ComputerUseDoctorParams: AgnesGen.ComputerUseDoctorParams,
  ComputerUseDoctorResult: AgnesGen.ComputerUseDoctorResult,
  ComputerUseOperationStartParams: AgnesGen.ComputerUseOperationStartParams,
  ComputerUseOperationStatusParams: AgnesGen.ComputerUseOperationStatusParams,
  ComputerUseOperationIdParams: AgnesGen.ComputerUseOperationIdParams,
  ComputerUseOperationResult: AgnesGen.ComputerUseOperationResult,
  AuthClaimParams: AgnesGen.AuthClaimParams,
  AuthClaimResult: AgnesGen.AuthClaimResult,
  SessionEventParams: AgnesGen.SessionEventParams,
  SessionPreviewParams: AgnesGen.SessionPreviewParams,
  DaemonNotice: AgnesGen.DaemonNotice,
  // SlotName is a cross-file alias of model.json's closed seven-value enum, on the same footing as
  // the JsonValue/ContentBlock/Actor/SurfaceOp/EventEnvelope aliases above: spelled in agnes-v1.json
  // as an honest $ref, so the coverage guard demands it registered here too.
  SlotName: AgnesGen.SlotName,
  SessionForkParams: AgnesGen.SessionForkParams,
  SessionPreferences: AgnesGen.SessionPreferences,
  SessionRenameParams: AgnesGen.SessionRenameParams,
  SessionArchiveParams: AgnesGen.SessionArchiveParams,
  DiagnosticsCollectParams: AgnesGen.DiagnosticsCollectParams,
  DiagnosticsCollectResult: AgnesGen.DiagnosticsCollectResult,
  DiagnosticsEventsParams: AgnesGen.DiagnosticsEventsParams,
  DiagnosticsEventsResult: AgnesGen.DiagnosticsEventsResult,
  SessionMeta: AgnesGen.SessionMeta,
  SessionListParams: AgnesGen.SessionListParams,
  PageSessionMeta: AgnesGen.PageSessionMeta,
  SessionSetPresetParams: AgnesGen.SessionSetPresetParams,
  SessionSetModelParams: AgnesGen.SessionSetModelParams,
  SessionSetYoloParams: AgnesGen.SessionSetYoloParams,
  EffectiveFromResult: AgnesGen.EffectiveFromResult,
  SeqResult: AgnesGen.SeqResult,
  ApprovalDecideParams: AgnesGen.ApprovalDecideParams,
  ParticipantParams: AgnesGen.ParticipantParams,
  ParticipantListResult: AgnesGen.ParticipantListResult,
  DirectoryUpsertParams: AgnesGen.DirectoryUpsertParams,
  DirectoryUpsertResult: AgnesGen.DirectoryUpsertResult,
  JobIdParams: AgnesGen.JobIdParams,
  JobIdResult: AgnesGen.JobIdResult,
  ExtUiResponseParams: AgnesGen.ExtUiResponseParams,
}

// model.json is the third self-owned document. Its `JsonValue` / `ContentBlock` / `ToolCall` entries
// are cross-file aliases of session-v1's definitions (the generator inlines them), so they are
// registered here for the two-way coverage guard exactly as agnes-v1's aliases are.
const MODEL_DEFS: Record<string, TSchema> = {
  JsonValue: ModelGen.JsonValue,
  ContentBlock: ModelGen.ContentBlock,
  ToolCall: ModelGen.ToolCall,
  Billing: ModelGen.Billing,
  SlotName: ModelGen.SlotName,
  ThinkingLevel: ModelGen.ThinkingLevel,
  AiErrorCode: ModelGen.AiErrorCode,
  DecodeRule: ModelGen.DecodeRule,
  Sha256: ModelGen.Sha256,
  ToolSchema: ModelGen.ToolSchema,
  RequestMessage: ModelGen.RequestMessage,
  RequestBody: ModelGen.RequestBody,
  ModelCost: ModelGen.ModelCost,
  ModelRecord: ModelGen.ModelRecord,
  ContractStamp: ModelGen.ContractStamp,
  TokenCounts: ModelGen.TokenCounts,
  Timing: ModelGen.Timing,
  CountResult: ModelGen.CountResult,
  InferenceEvent: ModelGen.InferenceEvent,
  RouteDecl: ModelGen.RouteDecl,
  RouteTarget: ModelGen.RouteTarget,
  RouteTable: ModelGen.RouteTable,
  ProbeReport: ModelGen.ProbeReport,
  ContractManifest: ModelGen.ContractManifest,
}

// tooldef.json, the fourth self-owned document. Its JsonValue entry is a cross-file alias of
// session-v1's definition, registered here for the two-way coverage guard like the others.
const TOOLDEF_DEFS: Record<string, TSchema> = {
  JsonValue: ToolDefGen.JsonValue,
  ToolMeta: ToolDefGen.ToolMeta,
  ParametersSchema: ToolDefGen.ParametersSchema,
  ToolDef: ToolDefGen.ToolDef,
}

// hooks.json, the fifth self-owned document. Seven of its $defs are cross-file aliases (six of
// session-v1's and tooldef's ToolMeta), registered here for the two-way coverage guard like the rest.
const HOOKS_DEFS: Record<string, TSchema> = {
  JsonValue: HooksGen.JsonValue,
  Actor: HooksGen.Actor,
  ContentBlock: HooksGen.ContentBlock,
  ToolResult: HooksGen.ToolResult,
  PlanItems: HooksGen.PlanItems,
  Verdict: HooksGen.Verdict,
  ToolMeta: HooksGen.ToolMeta,
  ResolvedToolCallPolicy: HooksGen.ResolvedToolCallPolicy,
  ExecutionDomain: HooksGen.ExecutionDomain,
  HookEvent: HooksGen.HookEvent,
  PromptSection: HooksGen.PromptSection,
  ResourceEntry: HooksGen.ResourceEntry,
  SurfaceDigest: HooksGen.SurfaceDigest,
  ApprovalRequest: HooksGen.ApprovalRequest,
  CompactionPlan: HooksGen.CompactionPlan,
  SessionStartPayload: HooksGen.SessionStartPayload,
  SessionStartReturn: HooksGen.SessionStartReturn,
  ResourcesDiscoverPayload: HooksGen.ResourcesDiscoverPayload,
  ResourcesDiscoverReturn: HooksGen.ResourcesDiscoverReturn,
  BeforeStepPayload: HooksGen.BeforeStepPayload,
  BeforeStepReturn: HooksGen.BeforeStepReturn,
  ContextPayload: HooksGen.ContextPayload,
  ContextReturn: HooksGen.ContextReturn,
  BeforeRequestPayload: HooksGen.BeforeRequestPayload,
  BeforeRequestReturn: HooksGen.BeforeRequestReturn,
  BeforeProviderHeadersPayload: HooksGen.BeforeProviderHeadersPayload,
  BeforeProviderHeadersReturn: HooksGen.BeforeProviderHeadersReturn,
  RequestErrorPayload: HooksGen.RequestErrorPayload,
  RequestErrorReturn: HooksGen.RequestErrorReturn,
  ToolCallPayload: HooksGen.ToolCallPayload,
  ToolCallReturn: HooksGen.ToolCallReturn,
  ToolResultPayload: HooksGen.ToolResultPayload,
  ToolResultReturn: HooksGen.ToolResultReturn,
  TurnStoppingPayload: HooksGen.TurnStoppingPayload,
  TurnStoppingReturn: HooksGen.TurnStoppingReturn,
  ApprovalRequestPayload: HooksGen.ApprovalRequestPayload,
  ApprovalRequestReturn: HooksGen.ApprovalRequestReturn,
  BeforeCompactPayload: HooksGen.BeforeCompactPayload,
  BeforeCompactReturn: HooksGen.BeforeCompactReturn,
  CompactPayload: HooksGen.CompactPayload,
  CompactReturn: HooksGen.CompactReturn,
  SubagentStartPayload: HooksGen.SubagentStartPayload,
  SubagentStartReturn: HooksGen.SubagentStartReturn,
  SubagentEndPayload: HooksGen.SubagentEndPayload,
  SubagentEndReturn: HooksGen.SubagentEndReturn,
  FormatDeviationPayload: HooksGen.FormatDeviationPayload,
  FormatDeviationReturn: HooksGen.FormatDeviationReturn,
  ShutdownPayload: HooksGen.ShutdownPayload,
  ShutdownReturn: HooksGen.ShutdownReturn,
}

// slots.json, the sixth self-owned document. It borrows nothing, so it has no cross-file aliases.
const SLOTS_DEFS: Record<string, TSchema> = {
  UiSlotName: SlotsGen.UiSlotName,
  ToolCardInlinePayload: SlotsGen.ToolCardInlinePayload,
  SidebarActionPayload: SlotsGen.SidebarActionPayload,
  StatusLinePayload: SlotsGen.StatusLinePayload,
  NotificationPayload: SlotsGen.NotificationPayload,
}

// The 16 ACP method definitions listed on the "definitions used by this repo" line of
// schema/acp/UPSTREAM.md — 10 until Task 6b pulled authenticate / session/load / session/set_mode
// forward from I3, which added their six request and response definitions. This is every ACP $def the
// METHODS table actually references, not all 170 $defs in acp/schema.json. The rest — including the 4 UNSUPPORTED_NODES elicitation nodes — are
// neither referenced nor advertised as a capability by this package and are outside the coverage
// requirement; UPSTREAM.md and DEVIATIONS.md record that with a $ref reachability analysis.
// The drift guard at the end of the file compares this table against both that UPSTREAM.md line and
// the names METHOD_DEF actually references.
const ACP_DEFS: Record<string, TSchema> = {
  InitializeRequest: AcpGen.InitializeRequest,
  InitializeResponse: AcpGen.InitializeResponse,
  NewSessionRequest: AcpGen.NewSessionRequest,
  NewSessionResponse: AcpGen.NewSessionResponse,
  PromptRequest: AcpGen.PromptRequest,
  PromptResponse: AcpGen.PromptResponse,
  CancelNotification: AcpGen.CancelNotification,
  SessionNotification: AcpGen.SessionNotification,
  RequestPermissionRequest: AcpGen.RequestPermissionRequest,
  RequestPermissionResponse: AcpGen.RequestPermissionResponse,
  AuthenticateRequest: AcpGen.AuthenticateRequest,
  AuthenticateResponse: AcpGen.AuthenticateResponse,
  LoadSessionRequest: AcpGen.LoadSessionRequest,
  LoadSessionResponse: AcpGen.LoadSessionResponse,
  SetSessionModeRequest: AcpGen.SetSessionModeRequest,
  SetSessionModeResponse: AcpGen.SetSessionModeResponse,
}

// The format checkers get compared too. They are not a $def, but the library-level difference for
// `uri` (see KNOWN_DIFFS) has to hang off an entry the generic loop genuinely runs, not a
// free-standing `it`.
const FORMAT_DEFS: Record<string, TSchema> = {
  UriFormat: Type.String({ format: 'uri' }),
  DateTimeFormat: Type.String({ format: 'date-time' }),
}
const FORMAT_AJV: Record<string, (x: unknown) => boolean> = {
  UriFormat: (() => {
    const v = ajv.compile({ type: 'string', format: 'uri' })
    return (x: unknown) => v(x) === true
  })(),
  DateTimeFormat: (() => {
    const v = ajv.compile({ type: 'string', format: 'date-time' })
    return (x: unknown) => v(x) === true
  })(),
}

// ---------------------------------------------------------------------------
// Table of known library-level differences. The generic loop looks up every sample here first:
//   - hit → assert the **specific** pair of verdicts registered in the table (what ajv says, what
//     TypeBox says);
//   - miss → fall through to the generic assertion (valid accepted by both / invalid rejected by
//     both).
// So deleting an entry makes that sample fall back to the generic assertion and go red immediately.
// The entries themselves are pinned by a guard requiring each to be hit by some sample (see the end
// of the file), which prevents zombie entries that can never take effect.

type KnownDiff = {
  scope: string
  def: string
  /** The exact input value; matched in two stages, Object.is (so NaN compares) then JSON structural equality. */
  sample: unknown
  /** The verdict on the ajv side. */
  ajv: boolean
  /** The verdict on the TypeBox side. */
  typebox: boolean
  reason: string
}

const KNOWN_DIFFS: KnownDiff[] = [
  {
    scope: 'https://agnes.ai/schema/authz.json',
    def: 'Decision',
    sample: {
      decisionId: 'fixture',
      effect: 'allow',
      reason: 'fixture',
      rowFilter: 'named_regions[region_a,region-b]',
      fieldMask: { visible: [], masked: [] },
      limits: { maxRows: 0, exportRequiresGrant: false },
      expiresAt: '2026-09-09T00:00:00+01',
    },
    ajv: true,
    typebox: false,
    reason:
      'Ajv full date-time accepts hour-only timezone offsets. RFC3339 requires HH:MM; public validator preserves strict syntax. Exact payload exception.',
  },
  {
    scope: 'https://agnes.ai/schema/channel.json',
    def: 'DirectoryEntry',
    sample: {
      kind: 'dept',
      id: 'dept',
      name: 'Fixture',
      syncedAt: '2026-09-09T00:00:00+01',
      attrs: { label: 'untrusted' },
    },
    ajv: true,
    typebox: false,
    reason:
      'Ajv full date-time accepts hour-only timezone offsets. RFC3339 requires HH:MM; public validator preserves strict syntax. Exact payload exception.',
  },
  ...['date-short-offset', 'date-colonless-offset', 'date-newline-separator', 'date-tab-separator'].map(
    (id) => ({
      scope: 'https://agnes.ai/schema/jobs.json',
      def: 'JobStatus',
      sample: byId(loadJsonl(`${pkgRoot}fixtures/configs/task20.jsonl`), id),
      ajv: true,
      typebox: false,
      reason:
        'Ajv full mode tolerates non-colon offsets and whitespace separators. Preserve the existing protocol date-time wire shape: T/t plus Z/z or signed HH:MM. Exception matches this complete fixture only.',
    }),
  ),
  ...['date-hour-overflow-leap', 'date-minute-overflow-leap', 'date-hour-overflow-normal'].map((id) => ({
    scope: 'https://agnes.ai/schema/jobs.json',
    def: 'JobStatus',
    sample: byId(loadJsonl(`${pkgRoot}fixtures/configs/task20.jsonl`), id),
    ajv: true,
    typebox: false,
    reason:
      'Ajv full date-time leap branch admits an out-of-range local hour/minute. Public validation enforces RFC3339 local bounds before considering a leap second. This is an exact payload exception, not a schema-wide exclusion.',
  })),
  {
    scope: 'https://agnes.ai/schema/profile.json',
    def: 'JsonValue',
    sample: Number.NaN,
    ajv: true,
    typebox: false,
    reason: 'Same measured NaN library difference as session-v1 JsonValue; this is its external alias.',
  },
  {
    scope: 'https://agnes.ai/schema/jobs.json',
    def: 'JsonValue',
    sample: Number.NaN,
    ajv: true,
    typebox: false,
    reason: 'Same measured NaN library difference as session-v1 JsonValue; this is its external alias.',
  },

  {
    scope: SESSION_ID,
    def: 'JsonValue',
    sample: Number.NaN,
    ajv: true,
    typebox: false,
    reason:
      'JsonValue number branch: ajv decides by `typeof x === "number"`, and NaN is a number, so it ' +
      "accepts; TypeBox's Number check excludes NaN/Infinity, so it rejects. This is the general " +
      'disagreement between the two libraries over whether `type:"number"` includes NaN, unrelated to ' +
      'this generator (NaN is not a legal JSON literal either, so it never appears on the wire).',
  },
  {
    scope: AGNES_ID,
    def: 'JsonValue',
    sample: Number.NaN,
    ajv: true,
    typebox: false,
    reason: "Same as session-v1's JsonValue — agnes-v1's JsonValue is a cross-file $ref to it.",
  },
  {
    scope: MODEL_ID,
    def: 'JsonValue',
    sample: Number.NaN,
    ajv: true,
    typebox: false,
    reason: "Same as session-v1's JsonValue — model.json's JsonValue is a cross-file $ref to it.",
  },
  {
    scope: TOOLDEF_ID,
    def: 'JsonValue',
    sample: Number.NaN,
    ajv: true,
    typebox: false,
    reason: "Same as session-v1's JsonValue - tooldef.json's JsonValue is a cross-file $ref to it.",
  },
  {
    scope: HOOKS_ID,
    def: 'JsonValue',
    sample: Number.NaN,
    ajv: true,
    typebox: false,
    reason: "Same as session-v1's JsonValue - hooks.json's JsonValue is a cross-file $ref to it.",
  },
  {
    scope: FORMATS_ID,
    def: 'UriFormat',
    sample: 'http://',
    ajv: true,
    typebox: false,
    reason:
      'ajv-formats implements `uri` with an RFC 3986 regex, which `"http://"` (a scheme with an ' +
      'empty host) matches. The FORMAT_CHECKERS entry the generator registers uses `new URL()` and ' +
      'requires a non-empty host, so it rejects — see the FORMAT_CHECKERS comment in ' +
      'tools/gen-core.ts. A library-level difference, not a defect on our side.',
  },
]

function sameSample(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === undefined || b === undefined) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

const usedDiffs = new Set<number>()

/** Resolved at collection time (while describes expand), so usedDiffs is fully populated before any
 * it runs. */
function matchDiff(scope: string, def: string, sample: unknown): KnownDiff | undefined {
  const idx = KNOWN_DIFFS.findIndex((d) => d.scope === scope && d.def === def && sameSample(d.sample, sample))
  if (idx < 0) return undefined
  usedDiffs.add(idx)
  return KNOWN_DIFFS[idx]
}

// ---------------------------------------------------------------------------
// Sample table: one valid plus a set of invalid. Fixtures under fixtures/ are reused wherever
// possible (the `note` records the origin) and hand-written samples record why. Every invalid marked
// "boundary" sits exactly one step over the line — those are the only samples that can touch the
// class of defect this file exists to catch, a constraint being silently dropped.

const envOk = byId(envelopeFixtures, 'env-ok-user-message') as Json
const envMissingTrust = byId(envelopeFixtures, 'env-missing-trust') as Json
const actorOk = envOk.actor as Json
const userMessageOk = dataOf('i1-user-message-ok') as Json
const userMessageContent0 = userMessageOk.content as unknown[]
const sessionStartOk = dataOf('i1-session-start-ok') as Json
const turnStartOk = dataOf('i1-turn-start-ok') as Json
const turnEndOk = dataOf('i1-turn-end-ok') as Json
const assistantMessageOk = dataOf('i1-assistant-message-ok') as Json
const toolCallOk = dataOf('i1-tool-call-ok') as Json
const resolvedToolCallPolicyOk = toolCallOk.resolvedPolicy as Json
const toolResultOk = dataOf('i1-tool-result-ok') as Json
const requestHeaderOk = dataOf('i1-request-header-ok') as Json
const requestMediaHeaderOk = requestMediaDataOf('request-media-header-ok') as Json
const requestMediaOk = requestMediaHeaderOk.media as Json
const requestMediaManifestOk = requestMediaOk.manifest as unknown[]
const requestMediaManifestEntryOk = requestMediaManifestOk[1] as Json
const requestSentOk = requestMediaDataOf('request-sent-ok') as Json
const opStateOk = dataOf('i1-op-state-ok') as Json
const opStateOkBatch = (opStateOk.phase as Json).batch as Json
const toolCallStateOk = (opStateOkBatch.calls as unknown[])[0] as Json

// Two EventEnvelope.type samples that reproduce the dropped-maxLength defect: both match the
// extension namespace pattern and are over the line on length alone. The 208-character one is the
// original instance real ajv caught during review.
const EXT_TYPE_208 = `x/agnes/${rep(200)}`
const EXT_TYPE_129 = `x/agnes/${rep(121)}`

function opStateWithMeta(patch: Json): Json {
  const base = clone(opStateOk)
  return { ...base, meta: { ...(base.meta as Json), ...patch } }
}

const parityActor: Json = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const harnessEntryOk: Json = {
  kind: 'skill',
  id: 'x',
  title: 't',
  content: 'c',
  scope: 'local',
  version: 1,
  source: 'refine',
}
const costLedgerOk: Json = {
  purpose: 'inference',
  effectId: 'e1',
  creditSource: 'estimated',
  model: 'm',
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
}
const harnessRefineOk: Json = {
  trigger: 'auto',
  proposalId: 'p1',
  rationale: 'because',
  edits: [{ op: 'delete', kind: 'skill', id: 'x' }],
  baseline: [{ key: 'skill/x', version: 2 }],
  outcome: 'applied',
}
const SESSION_SAMPLES: Record<string, Sample> = {
  EventEnvelope: {
    valid: envOk,
    invalid: [
      envMissingTrust,
      // ↓ The original defect instance. The generator once dropped `type`'s outer maxLength:128
      //   along with its anyOf, so this 208-character type (which matches the extension pattern) got
      //   through validation. Re-plant that defect in the generated module and this case goes red.
      { ...envOk, type: EXT_TYPE_208 },
      { ...envOk, type: EXT_TYPE_129 }, // boundary: one over maxLength:128
      { ...envOk, type: 'nope/nope' }, // neither in the enum nor matching the extension pattern
      { ...envOk, seq: 0 }, // boundary: one below minimum:1
      { ...envOk, ts: 'not-a-date' }, // format: date-time
      { ...envOk, id: 'not-a-ulid' }, // ULID pattern
      { ...envOk, origin: `tool:${rep(300)}` }, // boundary: matches the pattern but exceeds maxLength:256
      { ...envOk, origin: 'nonsense' }, // pattern
      { ...envOk, lane: '' }, // boundary: one below minLength:1
      { ...envOk, lane: rep(65) }, // boundary: one over maxLength:64
      { ...envOk, v: 0 }, // boundary: one below minimum:1
      { ...envOk, register: rep(129) }, // boundary: one over maxLength:128
      { ...envOk, ignorable: false }, // const: true
      { ...envOk, sourceEventSeqs: [0] }, // boundary: one below items.minimum:1
      { ...envOk, seams: {} }, // additionalProperties:false
    ],
    note: 'valid and the first two invalid reuse fixtures/events/envelope.jsonl; the rest are per-constraint boundary negatives',
  },
  SessionStart: {
    valid: sessionStartOk,
    invalid: [
      dataOf('i1-session-start-missing-agnesversion'),
      { ...sessionStartOk, key: rep(513) }, // boundary: maxLength:512
      { ...sessionStartOk, agnesVersion: rep(65) }, // boundary: maxLength:64
      { ...sessionStartOk, resolvedProfileHash: rep(129) }, // boundary: maxLength:128 on the string branch of the union type
      { ...sessionStartOk, presetId: rep(129) }, // boundary: maxLength:128
      { ...sessionStartOk, resolvedPresetHash: rep(129) }, // boundary: maxLength:128
      { ...sessionStartOk, platform: { os: rep(33) } }, // boundary: maxLength:32
      { ...sessionStartOk, parent: { key: 'k', boundarySeq: 0 } }, // boundary: minimum:1
      { ...sessionStartOk, imported: { source: 'nope', sourceId: 'x', cwd: '/x' } }, // enum
      { ...sessionStartOk, imported: { source: 'codex', sourceId: 'x', cwd: rep(4097) } }, // boundary: maxLength:4096
    ],
    note: 'valid and the first invalid reuse the .data of fixtures/events/i1-types.jsonl; the rest are boundary negatives',
  },
  SubagentCost: {
    valid: i2DataOf('i2-subagent-cost-ok'),
    invalid: [
      i2DataOf('i2-subagent-cost-bad-source'),
      { ...(i2DataOf('i2-subagent-cost-ok') as Record<string, Json>), creditSource: 'free' },
      { ...(i2DataOf('i2-subagent-cost-ok') as Record<string, Json>), originCostSeq: 0 },
      { ...(i2DataOf('i2-subagent-cost-ok') as Record<string, Json>), childKey: '' },
      { ...(i2DataOf('i2-subagent-cost-ok') as Record<string, Json>), extra: true },
      {
        childKey: '',
        originSessionKey: 'parent/child',
        originCostSeq: 12,
        settlementRevision: 1,
      }, // boundary: one below childKey.minLength:1
      {
        childKey: rep(513),
        originSessionKey: 'parent/child',
        originCostSeq: 12,
        settlementRevision: 1,
      }, // boundary: one over childKey.maxLength:512
      {
        childKey: 'parent/child',
        originSessionKey: '',
        originCostSeq: 12,
        settlementRevision: 1,
      }, // boundary: one below originSessionKey.minLength:1
      {
        childKey: 'parent/child',
        originSessionKey: rep(513),
        originCostSeq: 12,
        settlementRevision: 1,
      }, // boundary: one over originSessionKey.maxLength:512
      {
        childKey: 'parent/child',
        originSessionKey: 'parent/child',
        originCostSeq: 0,
        settlementRevision: 1,
      }, // boundary: one below originCostSeq.minimum:1
      {
        childKey: 'parent/child',
        originSessionKey: 'parent/child',
        originCostSeq: 12,
        settlementRevision: 0,
      }, // boundary: one below settlementRevision.minimum:1
      {
        childKey: 'parent/child',
        originSessionKey: 'parent/child',
        originCostSeq: 12,
        settlementRevision: 1,
        credits: -1,
      }, // boundary: one below credits.minimum:0
      {
        childKey: 'parent/child',
        originSessionKey: 'parent/child',
        originCostSeq: 12,
        settlementRevision: 1,
        complete: 'yes',
      }, // type: complete is boolean when present
    ],
    note: 'valid and the enum negative reuse fixtures/events/i2-types.jsonl; the rest cover every bounded scalar in the settlement row',
  },
  TurnStart: {
    valid: turnStartOk,
    invalid: [
      dataOf('i1-turn-start-bad-trigger'),
      { ...turnStartOk, turn: 0 }, // boundary: minimum:1
      { ...turnStartOk, continues: { turn: 1, step: 1, toolUseId: rep(129) } }, // boundary: maxLength:128
      // continues.requestId also carries maxLength:128
      { ...turnStartOk, continues: { turn: 1, step: 1, toolUseId: 't1', requestId: rep(129) } },
    ],
    note: 'valid and the first invalid reuse the .data of fixtures/events/i1-types.jsonl; the rest are boundary negatives',
  },
  TurnEnd: {
    valid: turnEndOk,
    invalid: [
      dataOf('i1-turn-end-bad-reason'),
      { ...turnEndOk, lastAssistantSeq: 0 }, // boundary: minimum:1 on the integer branch of the union type
      { ...turnEndOk, error: { code: rep(65), message: 'x' } }, // boundary: maxLength:64
      { ...turnEndOk, error: { code: 'c', message: rep(4097) } }, // boundary: maxLength:4096
    ],
    note: 'valid and the first invalid reuse the .data of fixtures/events/i1-types.jsonl; the rest are boundary negatives',
  },
  StepStart: {
    valid: dataOf('i1-step-start-ok'),
    invalid: [
      dataOf('i1-step-start-missing-step'),
      { turn: 0, step: 1 }, // boundary: minimum:1
      { turn: 1, step: 0 }, // boundary: minimum:1
    ],
    note: 'valid and the first invalid reuse the .data of fixtures/events/i1-types.jsonl; the rest are boundary negatives',
  },
  StepEnd: {
    valid: dataOf('i1-step-end-ok'),
    invalid: [
      dataOf('i1-step-end-missing-step'),
      { turn: 0, step: 1 }, // boundary: minimum:1
      { turn: 1, step: 0 }, // boundary: minimum:1
    ],
    note: 'valid and the first invalid reuse the .data of fixtures/events/i1-types.jsonl; the rest are boundary negatives',
  },
  UserMessage: {
    valid: userMessageOk,
    invalid: [
      dataOf('i1-user-message-empty-content'), // boundary: one below minItems:1 (empty array)
      { ...userMessageOk, kind: 'nope' }, // enum
      { content: [{ type: 'text', text: rep(1048577) }] }, // boundary: ContentBlock.text maxLength:1048576
    ],
    note: 'valid and the first invalid reuse the .data of fixtures/events/i1-types.jsonl; the rest are boundary negatives',
  },
  AssistantMessage: {
    valid: assistantMessageOk,
    invalid: [
      dataOf('i1-assistant-message-bad-stopreason'),
      { ...assistantMessageOk, requestSeq: 0 }, // boundary: minimum:1
      { content: [{ type: 'bogus', text: 'x' }], stopReason: 'end_turn' }, // no matching branch in the content discriminated union
    ],
    note: 'valid and the first invalid reuse the .data of fixtures/events/i1-types.jsonl; the rest are boundary negatives',
  },
  ResolvedToolCallPolicy: {
    valid: resolvedToolCallPolicyOk,
    invalid: [
      { ...resolvedToolCallPolicyOk, replay: 'retry' },
      { ...resolvedToolCallPolicyOk, requiresApproval: 'sometimes' },
      { ...resolvedToolCallPolicyOk, approvalScopes: ['screen.front', 'screen.front'] },
      { ...resolvedToolCallPolicyOk, approvalScopes: Array.from({ length: 17 }, (_, i) => `scope.${i}`) },
      { ...resolvedToolCallPolicyOk, approvalScopes: ['1screen'] },
      { ...resolvedToolCallPolicyOk, approvalScopes: [rep(65)] },
      { ...resolvedToolCallPolicyOk, policyVersion: '' },
      { ...resolvedToolCallPolicyOk, policyVersion: '1' },
      { ...resolvedToolCallPolicyOk, policyVersion: rep(65) },
      { ...resolvedToolCallPolicyOk, executionDomain: 'host-computer-use' },
    ],
    note: 'the resolved call policy is closed, versioned and bounds a unique scope set; execution domain is deliberately not one of its writable fields',
  },
  ExecutionDomain: {
    valid: 'workspace',
    invalid: ['ordinary-sandbox', 'host', '', 1],
    note: 'Host attestation has exactly the workspace and host-computer-use domains',
  },
  DispatchPhase: {
    valid: 'not_sent',
    invalid: ['dispatch_pending', 'sent', 'unknown', 1],
    note: 'transport outcome uses the three-value phase vocabulary and never infers sent state from errors',
  },
  ToolCall: {
    valid: toolCallOk,
    invalid: [
      dataOf('i1-tool-call-bad-name'),
      { ...toolCallOk, toolUseId: rep(129) }, // boundary: maxLength:128
      { ...toolCallOk, name: rep(65) }, // boundary: the pattern allows 1+63=64 chars, so 65 is one over
      { ...toolCallOk, ordinal: -1 }, // boundary: minimum:0
      { ...toolCallOk, depth: -1 }, // boundary: minimum:0
      { ...toolCallOk, executionDomain: 'ordinary-sandbox' },
      { ...toolCallOk, definitionFingerprint: rep(63) },
      { ...toolCallOk, policyHash: rep(65) },
      { ...toolCallOk, resolvedPolicy: { ...resolvedToolCallPolicyOk, domain: 'host-computer-use' } },
    ],
    note: 'valid and the first invalid reuse the .data of fixtures/events/i1-types.jsonl; the rest are boundary negatives',
  },
  ToolResult: {
    valid: toolResultOk,
    invalid: [
      dataOf('i1-tool-result-missing-enforcement'),
      { ...toolResultOk, toolUseId: rep(129) }, // boundary: maxLength:128
      { ...toolResultOk, code: rep(65) }, // boundary: maxLength:64
      { ...toolResultOk, transformedBy: rep(129) }, // boundary: maxLength:128
      { ...toolResultOk, authz: { decisionId: rep(129) } }, // boundary: maxLength:128
      { ...toolResultOk, enforcement: { level: 'nope', scope: [] } }, // enum
      { ...toolResultOk, enforcement: { level: 'full', scope: ['nope'] } }, // items enum
    ],
    note: 'valid and the first invalid reuse the .data of fixtures/events/i1-types.jsonl; the rest are boundary negatives',
  },
  RequestMediaManifestEntry: {
    valid: requestMediaManifestEntryOk,
    invalid: [
      { ...requestMediaManifestEntryOk, nodeSeq: 0 },
      { ...requestMediaManifestEntryOk, artifactUri: `artifact://${'A'.repeat(64)}` },
      { ...requestMediaManifestEntryOk, sha256: rep(63) },
      { ...requestMediaManifestEntryOk, mime: 'image/gif' },
      { ...requestMediaManifestEntryOk, width: 0 },
      { ...requestMediaManifestEntryOk, height: 0 },
      { ...requestMediaManifestEntryOk, selected: 'yes' },
      { ...requestMediaManifestEntryOk, reason: 'oldest' },
      { ...requestMediaManifestEntryOk, elementMapDigest: rep(63) },
      { ...requestMediaManifestEntryOk, extra: true },
    ],
    note: 'artifact-backed image metadata is closed and exact; dimensions have no guessed P0 ceiling',
  },
  RequestMediaManifest: {
    valid: requestMediaManifestOk,
    invalid: [{ manifest: requestMediaManifestOk }, [{ ...requestMediaManifestEntryOk, width: 0 }]],
    note: 'the manifest preserves ordered entries and delegates every entry constraint to its schema',
  },
  RequestMediaHeader: {
    valid: requestMediaOk,
    invalid: [
      { ...requestMediaOk, version: 2 },
      { ...requestMediaOk, selectionOrder: [-1] },
      { ...requestMediaOk, selectionOrder: [1, 1] },
      { ...requestMediaOk, route: 'provider-fallback' },
      { ...requestMediaOk, manifest: [{ ...requestMediaManifestEntryOk, mime: 'image/gif' }] },
      { version: 1, route: 'text-only', manifest: [] },
      { ...requestMediaOk, extra: true },
    ],
    note: 'one optional closed header makes version, order, pre-routed capability path and manifest all-or-none',
  },
  RequestHeader: {
    valid: requestMediaHeaderOk,
    invalid: [
      dataOf('i1-request-header-missing-envelopenonce'),
      { ...requestHeaderOk, envelopeNonce: rep(65) }, // boundary: maxLength:64
      { ...requestHeaderOk, parser_version: rep(33) }, // boundary: maxLength:32
      { ...requestHeaderOk, model: rep(257) }, // boundary: maxLength:256
      { ...requestHeaderOk, derived_hash: rep(129) }, // boundary: maxLength:128
      { ...requestHeaderOk, contract_id: rep(129) }, // boundary: maxLength:128 on the string branch of the union type
      { ...requestHeaderOk, transforms: [{ event: rep(65), ext: 'e' }] }, // boundary: maxLength:64
      { ...requestHeaderOk, transforms: [{ event: 'e', ext: rep(129) }] }, // boundary: maxLength:128
      { ...requestHeaderOk, media: { ...requestMediaOk, version: 2 } },
    ],
    note: 'the new valid fixture carries media; the legacy missing-field fixture and flat hash bounds remain covered',
  },
  RequestSent: {
    valid: requestSentOk,
    invalid: [
      requestMediaDataOf('request-sent-short-hash'),
      requestMediaDataOf('request-sent-missing-transforms'),
      { ...requestSentOk, prompt_prefix_hash: rep(63) },
      { ...requestSentOk, tool_schema_hash: rep(63) },
      { ...requestSentOk, parser_version: rep(33) },
      { ...requestSentOk, contract_id: rep(129) },
      { ...requestSentOk, model: { route: rep(129), id: 'm' } },
      { ...requestSentOk, model: { route: 'r', id: rep(257) } },
      { ...requestSentOk, model: { route: 'r', id: 'm', responseModel: rep(257) } },
      { ...requestSentOk, derived_hash: rep(63) },
      { ...requestSentOk, transforms: [{ event: rep(65), ext: 'e' }] },
      { ...requestSentOk, transforms: [{ event: 'e', ext: rep(129) }] },
      { ...requestSentOk, extra: true },
    ],
    note: 'the provider stamp is a strict post-dispatch event and mirrors ContractStamp without reusing a cyclic schema ref',
  },
  OpState: {
    valid: opStateOk,
    invalid: [
      dataOf('i1-op-state-bad-phase-kind'),
      opStateWithMeta({ turn: 0 }), // boundary: minimum:1
      opStateWithMeta({ triggerSeq: 0 }), // boundary: minimum:1
      opStateWithMeta({ depthLimit: -1 }), // boundary: minimum:0
      { ...clone(opStateOk), step: -1 }, // boundary: minimum:0
      // deferred.jobs elements are closed objects; jobId/toolUseId each carry maxLength:128
      {
        ...clone(opStateOk),
        phase: { kind: 'deferred', jobs: [{ jobId: rep(129), toolUseId: 't1' }], resumeAfter: {} },
      },
      { ...clone(opStateOk), phase: { kind: 'deferred', jobs: [{ jobId: 'j1' }], resumeAfter: {} } },
      {
        ...clone(opStateOk),
        phase: {
          kind: 'deferred',
          jobs: [{ jobId: 'j1', toolUseId: 't1', callSeq: 0 }],
          resumeAfter: {},
        },
      },
    ],
    note: 'valid and the first invalid reuse the .data of fixtures/events/i1-types.jsonl; the rest are boundary negatives',
  },
  Actor: {
    valid: actorOk,
    invalid: [
      { id: 'u', org: 'local', role: 'owner' }, // missing required deptPath/attrs
      { ...actorOk, id: '' }, // boundary: one below minLength:1
      { ...actorOk, id: rep(257) }, // boundary: maxLength:256
      { ...actorOk, org: rep(257) }, // boundary: maxLength:256
      { ...actorOk, role: rep(65) }, // boundary: maxLength:64
      { ...actorOk, deptPath: [rep(257)] }, // boundary: items.maxLength:256
      { ...actorOk, attrs: { k: rep(1025) } }, // boundary: dictionary value maxLength:1024
    ],
    note: 'valid reuses .payload.actor from the envelope fixture; invalid are hand-written (no fixture records an illegal Actor on its own)',
  },
  ContentBlock: {
    valid: userMessageContent0[0],
    invalid: [
      { type: 'bogus' }, // matches none of the three discriminated-union branches
      { type: 'text', text: rep(1048577) }, // boundary: maxLength:1048576
      { type: 'image', data: 'x', mimeType: rep(129) }, // boundary: maxLength:128
      { type: 'resource_link', uri: rep(4097) }, // boundary: maxLength:4096
      { type: 'resource_link', uri: 'u', name: rep(257) }, // boundary: maxLength:256
    ],
    note: 'valid reuses .data.content[0] from the user/message fixture; invalid are hand-written (no separate illegal-ContentBlock fixture)',
  },
  ToolCallState: {
    valid: toolCallStateOk,
    invalid: [
      { ...toolCallStateOk, status: 'bogus' }, // enum
      { ...toolCallStateOk, replay: 'bogus' }, // enum
      { ...toolCallStateOk, ordinal: -1 }, // boundary: minimum:0
      { ...toolCallStateOk, argsSeq: 0 }, // boundary: minimum:1
      { ...toolCallStateOk, dispatchPhase: 'dispatched' },
      { ...toolCallStateOk, executionDomain: 'ordinary-sandbox' },
      { ...toolCallStateOk, definitionFingerprint: rep(63) },
      { ...toolCallStateOk, policyHash: rep(65) },
      { ...toolCallStateOk, effectId: 'effect-1' }, // planned may not carry dispatch state
      {
        ...toolCallStateOk,
        status: 'dispatch_pending',
        effectId: 'effect-1',
        dispatchAttempt: 1,
        dispatchPhase: 'may_have_sent',
      }, // dispatch_pending may only be unobserved or host-attested not_sent
    ],
    note:
      'valid reuses .data.phase.batch.calls[0] from the op.state fixture, which was written with ' +
      "phase.kind='tools' precisely to cover this $def; invalid are hand-written",
  },
  SurfaceOp: {
    valid: 'append',
    invalid: [
      { op: 'replace', start: 0, end: 1 }, // boundary: minimum:1
      { op: 'replace', start: 1, end: 0 }, // boundary: minimum:1
      'appended', // a string other than the const 'append'
    ],
    note: 'no fixture ever sets EventEnvelope.surfaceOp (an optional field no event type uses yet), so every sample is hand-written',
  },
  JsonValue: {
    valid: { a: [1, 'x', true, null, { b: 2 }] },
    invalid: [
      undefined, // belongs to none of the null/boolean/number/string/array/object branches
      Number.NaN, // library-level difference, see KNOWN_DIFFS (delete that entry and this falls back to "both must reject" and goes red)
    ],
    note: "JsonValue's anyOf covers nearly every expressible JS value; NaN is registered in KNOWN_DIFFS rather than avoided in the samples",
  },
  // -- The 18 event data shapes wired into stage two, plus the three shapes they share -----------
  // Every valid sample below is the shape core writes on main today, copied from the writer. The
  // negatives sit one step outside a named constraint rather than merely omitting a required key,
  // because a dropped maxLength or a dropped pattern is invisible to a "missing field" negative.
  ArtifactRef: {
    valid: { sha256: rep64, size: 12, mime: 'text/plain' },
    invalid: [
      { sha256: rep(63), size: 12, mime: 'text/plain' }, // boundary: the pattern demands exactly 64 hex digits
      { sha256: rep64, size: -1, mime: 'text/plain' }, // boundary: one below minimum:0
      { sha256: rep64, size: 1, mime: rep(129) }, // boundary: one over maxLength:128
      { sha256: rep64, size: 1 }, // missing required mime
    ],
    note: 'hand-written; the artifact seam hands this back from put() and carries it on a finished job',
  },
  Verdict: {
    valid: { outcome: 'pass', reasons: [] },
    invalid: [
      { outcome: 'passed', reasons: [] }, // enum
      { outcome: 'pass' }, // missing required reasons
      { outcome: 'pass', reasons: [rep(1025)] }, // boundary: one over maxLength:1024
    ],
    note: 'hand-written; the verdict object hooks.json hands to turn_stopping, distinct from the flat verifier/signal row',
  },
  AssistantOutput: {
    valid: { state: 'started', effectId: 'e1', chars: { text: 5, thinking: 0 }, estimatedTokens: 2 },
    invalid: [
      { state: 'started', effectId: 'e1', chars: { text: 5 }, estimatedTokens: 2 }, // missing chars.thinking
      { state: 'done', effectId: 'e1', chars: { text: 5, thinking: 0 }, estimatedTokens: 2 }, // enum
      { state: 'interrupted', effectId: 'e1', chars: { text: 5, thinking: 0 }, estimatedTokens: 2 }, // missing content
      {
        state: 'progress',
        effectId: 'e1',
        chars: { text: 5, thinking: 0 },
        estimatedTokens: 2,
        content: [{ type: 'text', text: 'x' }],
      }, // additionalProperties:false: a live row carries no text
      { state: 'started', effectId: rep(129), chars: { text: 5, thinking: 0 }, estimatedTokens: 2 }, // boundary: maxLength:128
      { state: 'started', effectId: 'e1', chars: { text: 5, thinking: 0 }, estimatedTokens: -1 }, // boundary: minimum:0
    ],
    note: 'hand-written; the started / progress / interrupted rows that replace assistant/chunk',
  },
  PlanItems: {
    valid: { items: [{ id: 'a', text: 'do', status: 'todo' }] },
    invalid: [
      { items: [{ id: 'a', text: 'do', status: 'later' }] }, // enum
      { items: [{ id: 'a', text: 'do' }] }, // missing required status
      { items: [{ id: rep(65), text: 'do', status: 'todo' }] }, // boundary: one over maxLength:64
      {}, // missing required items
    ],
    note: 'valid is the register cell core writes through the plan tool; null is legal too and is covered by the register tombstone fixtures',
  },
  BudgetState: {
    valid: {
      slot: 'primary',
      escalate: false,
      creditsUsed: 0,
      creditsCap: null,
      lastPreflight: { tokens: 12, source: 'estimate' },
    },
    invalid: [
      { escalate: false, creditsUsed: 0, creditsCap: null }, // missing required slot
      { slot: 'primary', escalate: false, creditsUsed: -1, creditsCap: null }, // boundary: one below minimum:0
      {
        slot: 'primary',
        escalate: false,
        creditsUsed: 0,
        creditsCap: null,
        lastPreflight: { tokens: 1, source: 'guess' },
      }, // enum
      { slot: rep(33), escalate: false, creditsUsed: 0, creditsCap: null }, // boundary: one over maxLength:32
    ],
    note: 'valid is the cell core/src/step/gate.ts writes in budgetPreflight, lastPreflight included',
  },
  ArtifactJob: {
    valid: { jobId: 'j1', status: 'queued' },
    invalid: [
      { jobId: 'j1', status: 'submitted' }, // enum: the pre-I2 vocabulary, not the seam's
      { jobId: 'j1' }, // missing required status
      { jobId: 'j1', status: 'done', ref: { sha256: rep(63), size: 1, mime: 'text/plain' } }, // the nested ArtifactRef pattern
    ],
    note: "valid is what the artifacts tool writes on submit; the status vocabulary is ArtifactsSeam.poll()'s",
  },
  InboxItem: {
    valid: {
      itemId: 'i1',
      target: 'next-turn',
      content: [{ type: 'text', text: 'hi' }],
      actor: parityActor,
      enqueuedAt: '2026-09-09T00:00:00Z',
    },
    invalid: [
      { target: 'next-turn', content: [{ type: 'text', text: 'hi' }], actor: parityActor, enqueuedAt: 'x' }, // missing required itemId
      {
        itemId: 'i1',
        target: 'later',
        content: [{ type: 'text', text: 'hi' }],
        actor: parityActor,
        enqueuedAt: 'x',
      }, // enum
      { itemId: 'i1', target: 'next-turn', content: [], actor: parityActor, enqueuedAt: 'x' }, // boundary: one below minItems:1
      {
        itemId: 'i1',
        target: 'next-turn',
        content: [{ type: 'text', text: 'hi' }],
        actor: parityActor,
        enqueuedAt: 'x',
        trust: 'maybe',
      }, // enum
    ],
    note: 'hand-written from core/src/step/inbox.ts; kind and trust are set by whoever enqueued and default at the reader',
  },
  Inbox: {
    valid: {
      items: [
        {
          itemId: 'i1',
          target: 'next-turn',
          content: [{ type: 'text', text: 'hi' }],
          actor: parityActor,
          enqueuedAt: '2026-09-09T00:00:00Z',
        },
      ],
    },
    invalid: [
      {
        items: [
          {
            target: 'next-turn',
            content: [{ type: 'text', text: 'hi' }],
            actor: parityActor,
            enqueuedAt: 'x',
          },
        ],
      }, // the nested item is missing itemId
      { nextTurn: null, nextStep: null }, // the pre-I2 two-slot shape
      {}, // missing required items
    ],
    note: 'one register cell holding the whole queue, so every write replaces it entire',
  },
  HarnessEntryValue: {
    valid: harnessEntryOk,
    invalid: [
      { ...harnessEntryOk, version: 0 }, // boundary: one below minimum:1
      { ...harnessEntryOk, kind: 'note' }, // enum
      { ...harnessEntryOk, scope: 'team' }, // enum
      { ...harnessEntryOk, tombstone: true }, // additionalProperties:false - the tombstone is a sibling branch, not an extra key
    ],
    note: 'the live half of a harness/entry cell; the tombstone half is a separate branch of HarnessEntry',
  },
  HarnessEntry: {
    valid: { kind: 'skill', id: 'x', tombstone: true },
    invalid: [
      { kind: 'skill', id: 'x', tombstone: false }, // const: true - a tombstone says so or is not one
      { kind: 'skill', id: 'x' }, // neither branch: no tombstone flag and none of the live fields
      { ...harnessEntryOk, version: 0 }, // the live branch, one below minimum:1
    ],
    note:
      'this register deletes with a keyed tombstone rather than data:null, because its cell key is ' +
      'read out of data.kind/data.id and a null payload cannot name the key it removes',
  },
  EffectIntent: {
    valid: {
      effectId: 'e1',
      kind: 'tool',
      replay: 'safe',
      tool: { toolUseId: 't1', name: 'read' },
      argsSeq: 3,
    },
    invalid: [
      { effectId: 'e1', kind: 'tool', replay: 'maybe' }, // enum
      { effectId: 'e1', kind: 'artifact', replay: 'safe' }, // enum: the pre-I2 kind vocabulary
      { effectId: 'e1', kind: 'media', replay: 'safe' }, // media is a never-replay auxiliary effect
      { effectId: 'e1', kind: 'tool', replay: 'safe', tool: 'read' }, // tool is the object pair, not a bare name
      { effectId: 'e1', kind: 'tool', replay: 'safe', argsSeq: 0 }, // boundary: one below minimum:1
    ],
    note: 'valid is what core/src/effects/effect.ts writes for a tool call, the hottest row in the ledger',
  },
  EffectSettled: {
    valid: { effectId: 'e1', outcome: 'ok', durationMs: 4 },
    invalid: [
      { effectId: 'e1' }, // missing required outcome
      { effectId: 'e1', outcome: 'fine' }, // enum
      { effectId: 'e1', outcome: 'ok', durationMs: -1 }, // boundary: one below minimum:0
    ],
    note: 'the closing half of the effect sandwich',
  },
  VerifierSignal: {
    valid: { scope: 'turn', tier: 0, verdict: 'pass', reasons: [] },
    invalid: [
      { scope: 'turn', tier: 3, verdict: 'pass', reasons: [] }, // enum: tiers are 0/1/2
      { scope: 'turn', tier: 0, verdict: { outcome: 'pass', reasons: [] } }, // the nested shape; the row is flat
      { scope: 'run', tier: 0, verdict: 'pass', reasons: [] }, // enum
      { scope: 'turn', tier: 0, verdict: 'pass' }, // missing required reasons
    ],
    note: 'flat, matching what VerifierSeam.verify() returns; the nested Verdict object is the hooks-side shape',
  },
  RepairDecision: {
    valid: { round: 1, decision: 'repair', verdictSeq: 9 },
    invalid: [
      { round: 1, decision: 'retry', verdictSeq: 9 }, // enum
      { round: 0, decision: 'repair', verdictSeq: 9 }, // boundary: one below minimum:1
      { round: 1, action: 'repair', verifierSeq: 9 }, // the pre-I2 field names
    ],
    note: 'field names follow RepairSeam.decide, whose history argument reads these rows straight back',
  },
  FormatDeviation: {
    valid: { rule: 'fence', model: 'm', sampleHash: rep64, parserVersion: '1' },
    invalid: [
      { rule: 'fence', model: 'm', sampleHash: 'xyz', parserVersion: '1' }, // pattern: 64 hex digits
      { rule: 'fence', model: 'm', sample_hash: rep64, parser_version: '1' }, // the pre-I2 snake_case spelling
      { rule: 'fence', model: 'm', sampleHash: rep64 }, // missing required parserVersion
      { rule: rep(65), model: 'm', sampleHash: rep64, parserVersion: '1' }, // boundary: one over maxLength:64
    ],
    note: 'camelCase like every other field in this document; the snake_case negative is the spelling this replaced',
  },
  Billing: {
    valid: { usdMicros: 1250, source: 'gateway', subscription: true },
    invalid: [
      { usdMicros: -1, source: 'gateway', subscription: true },
      { usdMicros: 1.5, source: 'gateway', subscription: true },
      { usdMicros: 1250, source: 'provider', subscription: true },
      { usdMicros: 1250, source: 'gateway' },
    ],
    note: 'USD is represented as non-negative integer micros; source is closed and subscription is explicit',
  },
  CostLedger: {
    valid: costLedgerOk,
    invalid: [
      { ...costLedgerOk, creditSource: 'guess' }, // enum
      { ...costLedgerOk, model: { route: 'r', id: 'm' } }, // the model is a bare id; the provider route lives on request/sent
      { ...costLedgerOk, credits: -1 }, // boundary: one below minimum:0
      { ...costLedgerOk, billing: { usdMicros: -1, source: 'gateway', subscription: true } },
      { ...costLedgerOk, tokens: { input: 1, output: 1, cacheRead: 0 } }, // missing cacheWrite
      { ...costLedgerOk, timing: { ttftMs: 1, wallMs: 2 } }, // additionalProperties:false on the closed timing keys
    ],
    note: 'valid is the row core/src/step/inference.ts writes; credits is optional because only a gateway supplies one',
  },
  ApprovalAsked: {
    valid: { requestId: 'r1', kind: 'budget', summary: 's', risk: 'budget', bindingHash: '' },
    invalid: [
      { requestId: 'r1', kind: 'budget', summary: 's', risk: 'budget' }, // missing required bindingHash
      { requestId: 'r1', kind: 'budget', summary: 's', risk: 'budget', bindingHash: rep(63) }, // pattern: empty or exactly 64 hex
      { requestId: 'r1', kind: 'spend', summary: 's', risk: 'budget', bindingHash: '' }, // enum
      {
        requestId: 'r1',
        kind: 'tool',
        summary: 's',
        risk: 'destructive',
        bindingHash: rep64,
        pending: { ticket: 't' },
      }, // pending needs expiresAt
    ],
    note:
      'bindingHash is the empty string on the budget and unknown-outcome paths - neither ask is bound ' +
      'to a tool argv - so the pattern admits the empty string as well as 64 hex digits',
  },
  ApprovalDecided: {
    valid: { requestId: 'r1', verdict: 'rejected', via: 'sync' },
    invalid: [
      { requestId: 'r1', verdict: 'rejected', via: 'magic' }, // enum
      { requestId: 'r1', verdict: 'yes', via: 'sync' }, // enum
      { requestId: 'r1', verdict: 'rejected', via: 'sync', askedSeq: 4 }, // additionalProperties:false - asked and decided are written in one transaction, so asked has no seq yet
    ],
    note: 'valid is the row both approval call sites in core write; via is separately re-checked by core because a wrong value is unrecoverable',
  },
  ApprovalGrant: {
    valid: {
      grantId: 'g1',
      profileHash: `sha256-${rep64}`,
      actorId: 'u',
      actorOrg: 'o',
      toolId: 'computer_use',
      scope: 'cua:click:background',
      policyVersion: 'cua-v1',
      createdAt: '2026-09-17T00:00:00.000Z',
    },
    invalid: [
      { grantId: 'g1' },
      {
        grantId: 'g1',
        profileHash: rep64,
        actorId: 'u',
        actorOrg: 'o',
        toolId: 'computer_use',
        scope: 'cua:click:background',
        policyVersion: 'cua-v1',
        createdAt: 'now',
      },
    ],
    note: 'durable grants bind profile, actor, tool, scope, and policy version',
  },
  ApprovalGuardianDecision: {
    valid: {
      requestId: 'r1',
      effectId: 'e1',
      toolUseId: 't1',
      scope: 'cua:click:background',
      bindingHash: rep64,
      policyHash: rep64,
      decision: 'escalate',
      ruleVersion: 'guardian-v1',
      reasons: ['human review'],
      budget: {
        tokensReserved: 1024,
        credits: 1,
        creditSource: 'estimated',
        cap: 5,
        approved: true,
      },
    },
    invalid: [
      { requestId: 'r1', decision: 'allow', ruleVersion: 'guardian-v1', reasons: [] },
      {
        requestId: 'r1',
        effectId: 'e1',
        toolUseId: 't1',
        scope: 'cua:click:background',
        bindingHash: rep64,
        policyHash: rep64,
        decision: 'escalate',
        ruleVersion: '',
        reasons: [],
        budget: { tokensReserved: 1, credits: 1, creditSource: 'estimated', cap: null, approved: true },
      },
    ],
    note: 'the guardian result is an auditable internal decision, not a human approval verdict',
  },
  FeedbackRating: {
    valid: { targetSeq: 3, rating: 'up' },
    invalid: [
      { targetSeq: 3, rating: 3 }, // enum
      { targetSeq: 0, rating: 'up' }, // boundary: one below minimum:1
      { targetSeq: 3, rating: 'up', comment: rep(4097) }, // boundary: one over maxLength:4096
    ],
    note: 'no writer yet; the first one is responsible for reconciling the placeholder type in core with this shape',
  },
  FeedbackImplicit: {
    valid: { targetSeq: 3, kind: 'regenerate' },
    invalid: [
      { targetSeq: 3, kind: 'hover' }, // enum
      { targetSeq: 3 }, // missing required kind
      { targetSeq: 3, kind: 'copy', value: rep(257) }, // boundary: one over maxLength:256
    ],
    note: 'no writer yet; same caveat as FeedbackRating',
  },
  Participant: {
    valid: { action: 'join', participant: parityActor, surface: 'tui' },
    invalid: [
      { action: 'kick', participant: parityActor, surface: 'tui' }, // enum
      { action: 'join', participant: parityActor }, // missing required surface
      { action: 'join', participant: { id: 'u' }, surface: 'tui' }, // the nested Actor is incomplete
    ],
    note: 'no writer yet; surface is required because a join nobody can attribute to a surface is not reconstructible',
  },
  HarnessRefine: {
    valid: harnessRefineOk,
    invalid: [
      { ...harnessRefineOk, outcome: 'rejected:other' }, // enum
      { ...harnessRefineOk, trigger: 'nightly' }, // enum
      { ...harnessRefineOk, edits: [{ op: 'add', kind: 'skill', id: 'x' }] }, // the edit vocabulary is upsert/delete
      { ...harnessRefineOk, baseline: [{ key: 'skill x' }] }, // the baseline entry is missing version
    ],
    note: 'edits match RefineProposal.edits so the base implementation writes what the seam already hands it',
  },
}

const attachOk = byId(methodFixtures, 'attach-ok') as Json
const attachSeams = byId(methodFixtures, 'attach-seams') as Json
const attachResultOk = byId(methodFixtures, 'attach-result-ok') as Json
const steerOk = byId(methodFixtures, 'steer-ok') as Json
const steerActor = byId(methodFixtures, 'steer-actor') as Json
const steerResultOk = byId(methodFixtures, 'steer-result-ok') as Json
const apisListParamsOk = byId(methodFixtures, 'apis-list-params-ok') as Json
const apisListParamsExtra = byId(methodFixtures, 'apis-list-params-extra-key') as Json
const apisListResultOk = byId(methodFixtures, 'apis-list-result') as Json
const submitParamsOk = byId(methodFixtures, 'submit-params-ok') as Json
const submitParamsBadKind = byId(methodFixtures, 'submit-params-bad-kind') as Json
const submitAckOk = byId(methodFixtures, 'submit-ack-uncertain') as Json
const submitAckBad = byId(methodFixtures, 'submit-ack-bad-status') as Json
const followupOk = byId(methodFixtures, 'followup-ok') as Json
const detachParamsOk = byId(methodFixtures, 'session-detach-params-ok') as Json
const detachParamsExtra = byId(methodFixtures, 'session-detach-params-extra-key') as Json
const detachResultNotEmpty = byId(methodFixtures, 'session-detach-result-not-empty') as Json
const authClaimOnce = byId(methodFixtures, 'auth-claim-params-once') as Json
const authClaimWindowed = byId(methodFixtures, 'auth-claim-params-windowed') as Json
const authClaimMixed = byId(methodFixtures, 'auth-claim-params-mixed-shapes') as Json
const authClaimResultOk = byId(methodFixtures, 'auth-claim-result-ok') as Json
const authClaimResultMissing = byId(methodFixtures, 'auth-claim-result-missing-granted') as Json
const sessionEventOk = byId(methodFixtures, 'session-event-params-ok') as Json
const sessionEventNoActor = byId(methodFixtures, 'session-event-params-row-missing-actor') as Json
const daemonNoticeOk = byId(methodFixtures, 'daemon-notice-params-ok') as Json
const daemonNoticeBadKind = byId(methodFixtures, 'daemon-notice-params-unknown-kind') as Json
const authenticateOk = byId(methodFixtures, 'authenticate-params-ok') as Json
const authenticateNoMethodId = byId(methodFixtures, 'authenticate-params-missing-methodid') as Json
const loadParamsOk = byId(methodFixtures, 'session-load-params-ok') as Json
const loadParamsNoMcpServers = byId(methodFixtures, 'session-load-params-missing-mcpservers') as Json
const setModeOk = byId(methodFixtures, 'session-set-mode-params-ok') as Json
const setModeNoModeId = byId(methodFixtures, 'session-set-mode-params-missing-modeid') as Json

const harnessMetaOk: Json = {
  promptTurnId: 'pt1',
  eventSequence: 1,
  generation: 1,
  lane: 'main',
  phase: 'event',
}

const AGNES_SAMPLES: Record<string, Sample> = {
  ConfigOAuthInput: {
    note: 'OAuth input',
    valid: { action: 'poll', operationId: 'a' },
    invalid: [{ action: 'invalid' }],
  },
  ConfigOAuthResult: {
    note: 'No credentials in results',
    valid: { operationId: 'a', state: 'ready' },
    invalid: [{ operationId: 'a', state: 'ready', refresh: 'secret' }],
  },
  ConfigOAuthPrompt: {
    note: 'Manual code prompt',
    valid: { id: 'p', type: 'manual_code', message: 'Code' },
    invalid: [{ id: 'p', type: 'html', message: 'Code' }],
  },
  ConfigOAuthNotice: {
    note: 'Bounded login notice',
    valid: { message: 'Login', url: 'https://auth.openai.com' },
    invalid: [{ message: '' }],
  },
  ArtifactReadParams: {
    valid: {
      sessionId: 'session-a',
      laneId: 'lane-a',
      artifact: { sha256: 'a'.repeat(64), size: 16, mime: 'image/png' },
      range: 'bytes=0-7',
    },
    invalid: [
      {
        sessionId: 'session-a',
        laneId: 'lane-a',
        artifact: { sha256: 'a'.repeat(64), size: 16, mime: 'image/png' },
        path: '/tmp/secret',
      },
      {
        sessionId: 'session-a',
        laneId: 'lane-a',
        artifact: { sha256: 'a'.repeat(64), size: 16, mime: 'image/png' },
        range: 'bytes=0-1,4-5',
      },
      {
        sessionId: 'session-a',
        laneId: 'lane-a',
        artifact: { sha256: 'a'.repeat(64), size: 16, mime: 'image/png' },
        range: 'bytes=-',
      },
    ],
    note: 'artifact read binds a complete ref and one range without path or owner authority',
  },
  ArtifactReadResult: {
    valid: {
      ok: true,
      status: 206,
      artifact: { sha256: 'a'.repeat(64), size: 16, mime: 'image/png' },
      acceptRanges: 'bytes',
      contentLength: 3,
      etag: `"${'a'.repeat(64)}"`,
      contentRange: 'bytes 0-2/16',
      base64: 'AQID',
    },
    invalid: [
      { ok: false, status: 500, code: 'artifact_unavailable', message: 'secret' },
      { ok: false, status: 404, code: 'artifact_forbidden' },
      {
        ok: true,
        status: 200,
        artifact: { sha256: 'a'.repeat(64), size: 16, mime: 'image/png' },
        acceptRanges: 'bytes',
        contentLength: 3,
        etag: `"${'a'.repeat(64)}"`,
        contentRange: 'bytes 0-2/16',
        base64: 'AQID',
      },
      {
        ok: true,
        status: 206,
        artifact: { sha256: 'a'.repeat(64), size: 16, mime: 'image/png' },
        acceptRanges: 'bytes',
        contentLength: 3,
        etag: `"${'a'.repeat(64)}"`,
        base64: 'AQID',
      },
      {
        ok: true,
        status: 200,
        artifact: { sha256: 'a'.repeat(64), size: 16, mime: 'image/png' },
        acceptRanges: 'bytes',
        contentLength: 1048577,
        etag: `"${'a'.repeat(64)}"`,
        base64: '',
      },
    ],
    note: 'artifact read response is strict, fixed-error and bounded to one MiB raw bytes',
  },
  ConfigAccount: {
    valid: {
      accountId: 'work',
      label: 'Work',
      providerId: 'openai',
      route: 'account-work',
      baseUrl: 'http://localhost/v1',
      model: 'm',
      models: [{ id: 'm', name: 'M' }],
      enabled: true,
      credentialConfigured: true,
    },
    invalid: [{ accountId: '../bad' }],
    note: 'account snapshot is credential-free',
  },
  ConfigAccountInput: {
    valid: { accountId: 'work', action: 'enable', expectedRevision: 0 },
    invalid: [{ accountId: 'work', action: 'unknown', expectedRevision: 0 }],
    note: 'account action requires concurrency revision',
  },

  ConfigProvider: {
    note: 'Configuration RPC rejects malformed revisions and credential disclosure; hand-written boundary cases.',
    valid: { id: 'openai', label: 'OpenAI', api: 'openai-completions', baseUrl: 'https://api.example/v1' },
    invalid: [{ id: '' }, { id: 'a', label: 'A', api: 'a', baseUrl: 'x', apiKey: 'secret' }],
  },
  ConfigModel: {
    note: 'Configuration RPC rejects malformed revisions and credential disclosure; hand-written boundary cases.',
    valid: { id: 'm', name: 'Model' },
    invalid: [
      { id: '', name: 'Model' },
      { id: 'm', name: 'Model', secret: true },
    ],
  },
  ConfigSnapshot: {
    note: 'Configuration RPC rejects malformed revisions and credential disclosure; hand-written boundary cases.',
    valid: { profile: 'default', revision: 0, configured: false, provider: null, effect: 'new-sessions' },
    invalid: [
      { profile: 'default', revision: -1, configured: false, provider: null, effect: 'new-sessions' },
      {
        profile: 'default',
        revision: 1,
        configured: true,
        provider: { id: 'p', baseUrl: 'x', model: 'm', credentialConfigured: true, apiKey: 'secret' },
        effect: 'new-sessions',
      },
    ],
  },
  ConfigTestInput: {
    note: 'Configuration RPC rejects malformed revisions and credential disclosure; hand-written boundary cases.',
    valid: { providerId: 'openai', baseUrl: 'http://localhost:1234/v1', apiKey: 'test' },
    invalid: [
      { providerId: '' },
      { providerId: 'p', apiKey: rep(65537) },
      { providerId: 'p', baseUrl: rep(2049) },
    ],
  },
  ConfigTestResult: {
    note: 'Configuration RPC rejects malformed revisions and credential disclosure; hand-written boundary cases.',
    valid: { models: [{ id: 'm', name: 'Model' }], verified: true },
    invalid: [
      { models: [], verified: 'yes' },
      { models: [], verified: true, apiKey: 'secret' },
    ],
  },
  ConfigSaveInput: {
    note: 'Configuration RPC rejects malformed revisions and credential disclosure; hand-written boundary cases.',
    valid: { providerId: 'openai', model: 'm', expectedRevision: 0 },
    invalid: [
      { providerId: 'openai', model: 'm', expectedRevision: -1 },
      { providerId: 'openai', model: 'm', expectedRevision: 1.1 },
      { providerId: 'openai' },
    ],
  },
  ConfigProvidersResult: {
    note: 'Configuration RPC rejects malformed revisions and credential disclosure; hand-written boundary cases.',
    valid: { providers: [{ id: 'p', label: 'Provider', api: 'a', baseUrl: 'http://localhost' }] },
    invalid: [{ providers: 'p' }, { providers: [], apiKey: 'secret' }],
  },
  ConfigEmptyParams: {
    note: 'Configuration RPC rejects malformed revisions and credential disclosure; hand-written boundary cases.',
    valid: {},
    invalid: [{ apiKey: 'secret' }, []],
  },

  BudgetState: SESSION_SAMPLES.BudgetState as Sample,
  ArtifactRef: SESSION_SAMPLES.ArtifactRef as Sample,
  ArtifactJob: SESSION_SAMPLES.ArtifactJob as Sample,
  Credential: {
    valid: { kind: 'local' },
    invalid: [{ kind: 'sso' }, { kind: 'jwt' }],
    note: 'cross-file alias of channel Credential; sso is a resolved daemon identity, not a wire credential',
  },
  DirectoryEntry: {
    valid: { kind: 'user', id: 'u', name: 'Alice', syncedAt: '2026-09-11T00:00:00Z' },
    invalid: [
      { kind: 'user', id: 'u', name: 'Alice' },
      { kind: 'user', id: 'u', name: 'Alice', syncedAt: '2026-09-11T00:00:00Z', actor: {} },
    ],
    note: 'cross-file alias of channel DirectoryEntry; syncedAt is required and the row is closed',
  },
  JobSpec: {
    valid: {
      idempotencyKey: 'daily-report',
      sessionKey: 'agnes:local:default:cli:dm:main',
      payload: { prompt: 'prepare report' },
      schedule: { kind: 'once' },
    },
    invalid: [
      {
        sessionKey: 'agnes:local:default:cli:dm:main',
        payload: { prompt: 'prepare report' },
        schedule: { kind: 'once' },
      },
      {
        idempotencyKey: 'daily-report',
        sessionKey: 'agnes:local:default:cli:dm:main',
        payload: { prompt: 'prepare report' },
        schedule: { kind: 'every', everyMs: 999 },
      },
    ],
    note: 'cross-file alias of jobs JobSpec; idempotency and the schedule minimum are enforced',
  },
  JobStatus: {
    valid: {
      jobId: 'job-1',
      status: 'waiting',
      attempts: 0,
      createdAt: '2026-09-11T00:00:00Z',
      updatedAt: '2026-09-11T00:00:00Z',
    },
    invalid: [
      {
        jobId: 'job-1',
        status: 'unknown',
        attempts: 0,
        createdAt: '2026-09-11T00:00:00Z',
        updatedAt: '2026-09-11T00:00:00Z',
      },
      { jobId: 'job-1', status: 'waiting', attempts: -1, createdAt: 'x', updatedAt: 'x' },
    ],
    note: 'cross-file alias of jobs JobStatus; status is closed and attempts are non-negative',
  },
  SessionBudgetResult: {
    valid: { state: null, ledger: [{ creditSource: 'estimated', seq: 1 }] },
    invalid: [
      { ledger: [] },
      { state: null, ledger: [{ creditSource: 'invented', seq: 1 }] },
      { state: null, ledger: Array.from({ length: 201 }, () => ({ creditSource: 'estimated', seq: 1 })) },
    ],
    note: 'nullable state, unknown credits, closed source and recent 200 ceiling',
  },
  SessionProjectUIParams: {
    valid: { sessionId: 's' },
    invalid: [{ sessionId: 's', upto: -1 }, { sessionId: 's', surface: 'ide' }, { sessionId: rep(513) }],
    note: 'default request and seq/surface/id boundaries',
  },
  SessionProjectUIPatchParams: {
    valid: { sessionId: 's', after: 7, upto: 9, surface: 'tui' },
    invalid: [
      { sessionId: 's', after: -1 },
      { sessionId: 's', after: 7, surface: 'ide' },
      { sessionId: rep(513), after: 7 },
    ],
    note: 'exclusive applied cursor and optional target cut use the same seq and surface boundaries',
  },
  SessionProjectUIOpeningParams: {
    valid: { sessionId: 's', surface: 'tui', maxNodes: 200, maxBytes: 262_144 },
    invalid: [
      { sessionId: 's', maxNodes: 0 },
      { sessionId: 's', maxNodes: 501 },
      { sessionId: 's', maxBytes: 16_383 },
      { sessionId: 's', maxBytes: 1_048_577 },
      { sessionId: 's', surface: 'ide' },
    ],
    note: 'opening request has closed surface plus bounded node and byte budgets',
  },
  UIHistoryCursor: {
    valid: 'opaque-history-cursor',
    invalid: ['', rep(2049)],
    note: 'history cursors are non-empty opaque tokens with a hard transport ceiling',
  },
  SessionProjectUIHistoryParams: {
    valid: { sessionId: 's', cursor: 'opaque-history-cursor', limit: 100, maxBytes: 262_144 },
    invalid: [
      { sessionId: 's' },
      { sessionId: 's', cursor: '' },
      { sessionId: 's', cursor: 'c', limit: 0 },
      { sessionId: 's', cursor: 'c', limit: 201 },
      { sessionId: 's', cursor: 'c', maxBytes: 1_048_577 },
    ],
    note: 'history reads require an opaque cursor and clamp caller node/byte budgets',
  },
  SlotFillView: {
    valid: { slot: 'status.line', extId: 'test/e', payload: { text: 'ok' } },
    invalid: [
      { slot: 'invented', extId: 'e', payload: null },
      { slot: 'status.line', extId: rep(129), payload: null },
      { slot: 'status.line', extId: 'e', payload: null, requestSeq: 0 },
    ],
    note: 'closed slot and ext/id/requestSeq boundaries',
  },
  UINode: {
    valid: {
      kind: 'compaction',
      id: 'c',
      seq: 5,
      range: [1, 4],
      summary: 'summary',
      customInstructions: 'retain facts',
    },
    invalid: [
      { kind: 'compaction', id: 'c', seq: 5, range: [1] },
      { kind: 'compaction', id: 'c', seq: 5, range: [1, 2, 3] },
      { kind: 'cost', id: 'c', seq: 1, source: 'unknown' },
    ],
    note: 'historical compaction lacks token measurements; range cardinality and source are enforced',
  },
  UsageView: {
    valid: {
      totals: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, reasoning: 1 },
      cost: { usdMicros: 12, source: 'gateway', subscription: true },
      context: { tokens: 17, window: 128000, autoCompact: true },
      model: { route: 'agnes-gateway', id: 'deepseek-v4-pro', thinking: 'high' },
    },
    invalid: [
      {
        totals: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0 },
        context: { tokens: 16, window: 128000, autoCompact: true },
        model: { route: 'agnes-gateway', id: 'deepseek-v4-pro', thinking: 'high' },
      },
      {
        totals: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, reasoning: 0 },
        context: { tokens: 16, window: 0, autoCompact: true },
        model: { route: 'agnes-gateway', id: 'deepseek-v4-pro', thinking: 'high' },
      },
      {
        totals: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, reasoning: 0 },
        context: { tokens: 16, window: 128000, autoCompact: true },
        model: { route: 'Agnes-Gateway', id: 'deepseek-v4-pro', thinking: 'max' },
      },
    ],
    note: 'footer projection is a closed aggregate with token totals, context capacity and route/model selection',
  },
  UITurnCall: {
    valid: {
      id: 'effect-1',
      seq: 7,
      purpose: 'inference',
      model: 'm1',
      creditSource: 'gateway',
      tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1 },
      credits: 1,
      billing: { usdMicros: 5, source: 'gateway', subscription: true },
    },
    invalid: [{ id: 'e', seq: 0, purpose: 'other', model: 'm', creditSource: 'gateway' }],
    note: 'one committed cost row retains measured token, credit and billing evidence',
  },
  UITurnUsage: {
    valid: {
      totals: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1 },
      reasoningComplete: true,
      billingComplete: true,
      calls: [],
    },
    invalid: [{ totals: {}, reasoningComplete: true, billingComplete: true, calls: [] }],
    note: 'per-turn usage makes incomplete reasoning and billing explicit',
  },
  UISpan: {
    valid: {
      id: 'turn:1',
      kind: 'turn',
      name: 'Turn 1',
      status: 'completed',
      startSeq: 1,
      startedAt: '2026-09-17T00:00:00.000Z',
      children: [],
    },
    invalid: [
      {
        id: 's',
        kind: 'trace',
        name: 'x',
        status: 'completed',
        startSeq: 1,
        startedAt: '2026-09-17T00:00:00.000Z',
        children: [],
      },
      {
        id: 's',
        kind: 'turn',
        name: 'x',
        status: 'completed',
        startSeq: 1,
        startedAt: '2026-09-17T00:00:00.000Z',
      },
      {
        id: rep(129),
        kind: 'turn',
        name: 'x',
        status: 'completed',
        startSeq: 1,
        startedAt: '2026-09-17T00:00:00.000Z',
        children: [],
      },
      {
        id: 's',
        kind: 'turn',
        name: rep(257),
        status: 'completed',
        startSeq: 1,
        startedAt: '2026-09-17T00:00:00.000Z',
        children: [],
      },
    ],
    note: 'trace tree node; children required; kind closed',
  },
  UITurn: {
    valid: {
      id: 'turn:1',
      turn: 1,
      startSeq: 2,
      endSeq: 9,
      startedAt: '2026-09-13T00:00:00.000Z',
      endedAt: '2026-09-13T00:00:01.000Z',
      durationMs: 1000,
      status: 'completed',
      reason: 'completed',
      nodeIds: ['u1', 'a1'],
      usage: {
        totals: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1 },
        reasoningComplete: true,
        billingComplete: false,
        calls: [],
      },
      inherited: false,
      forkable: true,
    },
    invalid: [{ id: 't', turn: 0, startSeq: 1, startedAt: 'bad', status: 'done', nodeIds: [] }],
    note: 'a stable user-visible turn carries an exact fork boundary only when complete',
  },
  UIOperationState: {
    valid: null,
    invalid: [
      { turn: 1, step: 0 },
      { turn: 1, step: 0, phase: rep(33) },
      { turn: 1, step: 0, phase: 'parked', parked: { ticket: 't' } },
    ],
    note: 'nullable idle state or one complete active operation state',
  },
  UITimeline: {
    valid: { sessionId: 's', upto: 0, generation: 1, opState: null, nodes: [], turns: [] },
    invalid: [
      { sessionId: 's', upto: 0, opState: null, nodes: [] },
      { sessionId: 's', upto: 0, generation: 0, opState: null, nodes: [] },
      { sessionId: 's', upto: -1, generation: 1, opState: null, nodes: [] },
    ],
    note: 'wire generation required, empty ledger upto zero valid',
  },
  UIHistoryInfo: {
    valid: { hasEarlier: true, cursor: 'opaque-history-cursor', startIndex: 8, totalNodes: 9 },
    invalid: [
      { hasEarlier: true, startIndex: 8, totalNodes: 9 },
      { hasEarlier: false, cursor: 'ambiguous', startIndex: 0, totalNodes: 9 },
      { hasEarlier: false, startIndex: -1, totalNodes: 9 },
      { hasEarlier: false, startIndex: 0, totalNodes: 9_007_199_254_740_992 },
    ],
    note: 'global window coordinates are safe integers and continuation is present exactly when earlier history exists',
  },
  UIOpeningResult: {
    valid: {
      timeline: {
        sessionId: 's',
        upto: 9,
        generation: 2,
        opState: null,
        nodes: [{ kind: 'user', id: 'u9', seq: 9, content: [] }],
        turns: [],
      },
      history: { hasEarlier: true, cursor: 'opaque-history-cursor', startIndex: 8, totalNodes: 9 },
    },
    invalid: [
      { timeline: { sessionId: 's', upto: 0, generation: 1, opState: null, nodes: [] } },
      {
        timeline: { sessionId: 's', upto: 0, generation: 1, opState: null, nodes: [] },
        history: { hasEarlier: true, startIndex: 0, totalNodes: 0 },
      },
    ],
    note: 'opening is one bounded live timeline plus explicit earlier-history metadata',
  },
  UIHistoryPage: {
    valid: {
      sessionId: 's',
      generation: 2,
      cut: 9,
      nodes: [{ kind: 'user', id: 'u1', seq: 1, content: [] }],
      turns: [],
      hasEarlier: false,
      startIndex: 0,
      totalNodes: 9,
    },
    invalid: [
      { sessionId: 's', generation: 2, cut: 9, nodes: [], hasEarlier: true, startIndex: 1, totalNodes: 9 },
      {
        sessionId: 's',
        generation: 2,
        cut: 9,
        nodes: [],
        hasEarlier: false,
        cursor: 'ambiguous',
        startIndex: 0,
        totalNodes: 9,
      },
      { sessionId: 's', generation: 0, cut: 9, nodes: [], hasEarlier: false, startIndex: 0, totalNodes: 9 },
      { sessionId: 's', generation: 2, cut: -1, nodes: [], hasEarlier: false, startIndex: 0, totalNodes: 9 },
    ],
    note: 'history pages keep stable cut/global coordinates and an unambiguous earlier-page continuation',
  },
  UIProjectionNodeChange: {
    valid: { op: 'remove', id: 'old-node' },
    invalid: [
      { op: 'remove' },
      { op: 'upsert', index: -1, node: { kind: 'user', id: 'u', seq: 1, content: [] } },
      { op: 'move', id: 'u' },
    ],
    note: 'closed remove/upsert operations; upserts carry final non-negative positions',
  },
  UIProjectionTurnChange: {
    valid: { op: 'remove', id: 'turn:1' },
    invalid: [{ op: 'upsert', index: -1, turn: {} }],
    note: 'turn patches use the same remove/upsert discipline as node patches',
  },
  UITimelinePatch: {
    valid: {
      sessionId: 's',
      generation: 1,
      from: 7,
      upto: 9,
      totalNodes: 4,
      opState: null,
      changes: [],
      turnChanges: [],
    },
    invalid: [
      { sessionId: 's', generation: 1, from: 7, upto: 9, changes: [] },
      { sessionId: 's', generation: 0, from: 7, upto: 9, opState: null, changes: [] },
      { sessionId: 's', generation: 1, from: -1, upto: 9, opState: null, changes: [] },
    ],
    note: 'patch always carries its old/new watermarks and complete replacement metadata',
  },
  UIProjectionUpdate: {
    valid: {
      kind: 'patch',
      patch: {
        sessionId: 's',
        generation: 1,
        from: 7,
        upto: 9,
        totalNodes: 0,
        opState: null,
        changes: [],
        turnChanges: [],
      },
    },
    invalid: [
      { kind: 'patch' },
      { kind: 'replace' },
      {
        kind: 'patch',
        patch: { sessionId: 's', generation: 1, from: 7, upto: 9, opState: null, changes: [] },
        timeline: { sessionId: 's', generation: 1, upto: 9, opState: null, nodes: [] },
      },
    ],
    note: 'one response is exactly a patch or a replacement snapshot, never both',
  },
  // Same definition as the like-named $def in session-v1 (a cross-file alias), so the same samples
  // are reused — one source of truth, rather than a second hand-written set here.
  ContentBlock: SESSION_SAMPLES.ContentBlock as Sample,
  Actor: SESSION_SAMPLES.Actor as Sample,
  SurfaceOp: SESSION_SAMPLES.SurfaceOp as Sample,
  EventEnvelope: SESSION_SAMPLES.EventEnvelope as Sample,
  Cursor: {
    valid: attachOk.cursor,
    invalid: [
      { fromSeq: -1, generation: 1 }, // boundary: minimum:0
      { fromSeq: 0, generation: 0 }, // boundary: minimum:1
    ],
    note: 'valid reuses .cursor from the attach-ok fixture; invalid are hand-written boundary negatives',
  },
  AttachFilter: {
    valid: attachOk.filter,
    invalid: [
      { preview: 'no' }, // wrong type
      { chunks: false }, // additionalProperties:false: streamed text is asked for with preview
      { types: [rep(129)] }, // boundary: items.maxLength:128
      { lanes: [rep(65)] }, // boundary: items.maxLength:64
    ],
    note: 'valid reuses .filter from the attach-ok fixture; invalid are hand-written boundary negatives',
  },
  SessionAttachParams: {
    valid: attachOk,
    invalid: [
      attachSeams,
      { ...attachOk, sessionId: rep(513) }, // boundary: maxLength:512
    ],
    note: 'valid and the first invalid reuse fixtures/methods/i1.jsonl (attach-ok / attach-seams)',
  },
  SessionAttachResult: {
    valid: attachResultOk,
    invalid: [
      { generation: 0, lastSeq: 0, resolvedProfileHash: null }, // boundary: minimum:1
      { generation: 1, lastSeq: -1, resolvedProfileHash: null }, // boundary: minimum:0
    ],
    note: 'valid reuses the attach-result-ok fixture; invalid are hand-written boundary negatives',
  },
  SessionCompactParams: {
    valid: { sessionId: 's', commandId: 'compact-1', instructions: 'keep decisions', generation: 1 },
    invalid: [
      { sessionId: rep(513), commandId: 'compact-1' },
      { sessionId: 's', commandId: rep(129) },
      { sessionId: 's', commandId: 'compact-1', instructions: rep(4097) },
      { sessionId: 's', commandId: 'compact-1', generation: 0 },
    ],
    note: 'manual compaction is journal-bound and carries only an optional bounded instruction',
  },
  SessionSteerParams: {
    valid: steerOk,
    invalid: [
      steerActor,
      { ...steerOk, sessionId: rep(513) }, // boundary: maxLength:512
      { ...steerOk, commandId: rep(129) }, // boundary: maxLength:128
      { ...steerOk, content: [] }, // boundary: one below minItems:1
      { ...steerOk, generation: 0 }, // boundary: one below minimum:1
    ],
    note: 'valid and the first invalid reuse fixtures/methods/i1.jsonl (steer-ok / steer-actor)',
  },
  SessionSteerResult: {
    valid: steerResultOk,
    invalid: [{ seq: 0 }], // boundary: minimum:1
    note: 'valid reuses the steer-result-ok fixture; invalid is hand-written (seq below minimum:1)',
  },
  ApisListParams: {
    valid: apisListParamsOk,
    invalid: [apisListParamsExtra],
    note: 'the whole entry reuses fixtures/methods/i1.jsonl (apis-list-params-ok / apis-list-params-extra-key)',
  },
  ApisListResult: {
    valid: apisListResultOk,
    invalid: [
      { profile: apisListResultOk.profile, families: 'not-an-array' }, // wrong type
      {
        profile: apisListResultOk.profile,
        families: [{ name: 'session', methods: [], guidance: rep(4097) }], // boundary: maxLength:4096
      },
    ],
    note: 'valid reuses the apis-list-result fixture; invalid are hand-written',
  },
  SubmitParams: {
    valid: submitParamsOk,
    invalid: [
      submitParamsBadKind,
      { ...submitParamsOk, clientId: rep(129) }, // boundary: maxLength:128
      { ...submitParamsOk, commandId: rep(129) }, // boundary: maxLength:128
      { ...submitParamsOk, generation: 0 }, // boundary: one below minimum:1
    ],
    note: 'valid and the first invalid reuse fixtures/methods/i1.jsonl (submit-params-ok / submit-params-bad-kind)',
  },
  CommandAckParams: {
    valid: { clientId: 'client-one', sessionId: 'agnes:local:test:cli:dm:one', commandId: 'command-one' },
    invalid: [
      { clientId: 'client-one', sessionId: 'agnes:local:test:cli:dm:one' },
      { clientId: rep(129), sessionId: 's', commandId: 'c' },
      { clientId: 'c', sessionId: rep(513), commandId: 'c' },
      { clientId: 'c', sessionId: 's', commandId: rep(129) },
    ],
    note: 'hand-written; all three identity components are required and independently bounded',
  },
  Ack: {
    valid: submitAckOk,
    invalid: [
      submitAckBad,
      { replayed: false, seq: 0 }, // boundary: minimum:1
    ],
    note: 'valid and the first invalid reuse fixtures/methods/i1.jsonl (submit-ack-uncertain / submit-ack-bad-status)',
  },
  CompactOutcome: {
    valid: { state: 'completed', endSeq: 9 },
    invalid: [
      { state: 'completed' },
      { state: 'failed', endSeq: 0 },
      { state: 'unknown', endSeq: 9 },
      { state: 'cancelled', endSeq: 9 },
    ],
    note: 'K01 compact acknowledgements certify only completed, failed, or unknown',
  },
  HarnessMeta: {
    valid: harnessMetaOk,
    invalid: [
      { ...harnessMetaOk, phase: 'bogus' }, // enum
      { ...harnessMetaOk, promptTurnId: rep(65) }, // boundary: maxLength:64
      { ...harnessMetaOk, lane: rep(65) }, // boundary: maxLength:64
      { ...harnessMetaOk, eventSequence: 0 }, // boundary: minimum:1
      { ...harnessMetaOk, generation: 0 }, // boundary: minimum:1
      { ...harnessMetaOk, credits: { used: 1, source: 'bogus' } }, // enum
      { ...harnessMetaOk, turnEnd: { reason: 'bogus' } }, // enum
    ],
    note:
      'HarnessMeta travels the ACP `_meta["ai.agnes.harness"]` side channel ' +
      '(getHarnessMeta/setHarnessMeta) and is not the params/result schema of any METHODS entry, so no ' +
      'fixture produces it naturally — every sample is hand-written',
  },
  Auth: {
    valid: { kind: 'local' },
    invalid: [
      { kind: 'local', extra: 'x' }, // additionalProperties:false
      { kind: 'jwt', token: rep(8193) }, // boundary: maxLength:8192
      // boundary: the signature pattern demands exactly 64 hex digits; this gives 63
      { kind: 'source-auth', timestamp: 1, signature: `v0=${rep(63)}`, nonce: rep(32) },
      // boundary: the nonce pattern demands exactly 32 hex digits; this gives 33
      { kind: 'source-auth', timestamp: 1, signature: `v0=${rep(64)}`, nonce: rep(33) },
      { kind: 'portal-identity', token: rep(8193) }, // boundary: maxLength:8192
    ],
    note: 'Auth appears only in InitializeMeta.auth, on the `_meta` side channel, so every sample is hand-written',
  },
  InitializeMeta: {
    valid: {},
    invalid: [
      { unknownKey: 1 }, // additionalProperties:false
      { clientId: rep(129) }, // boundary: maxLength:128
    ],
    note: 'same as Auth: appears only on the `_meta` side channel, so every sample is hand-written',
  },
  NewSessionMeta: {
    valid: {},
    invalid: [
      { preset: 123 }, // wrong type
      { preset: rep(129) }, // boundary: maxLength:128
      { sessionKey: rep(513) }, // boundary: maxLength:512
    ],
    note: 'same as Auth: appears only on the `_meta` side channel, so every sample is hand-written',
  },
  ErrorData: {
    valid: { code: 'X', extra: 'allowed-by-e42-exemption' },
    invalid: [
      {}, // missing required code
      { code: rep(65) }, // boundary: maxLength:64
    ],
    note:
      'ErrorData is the shape of JSON-RPC error.data and is not in the METHODS params/result table, ' +
      'so the samples are hand-written. valid deliberately carries an undeclared extra key, pinning ' +
      'that the additionalProperties:true exemption really does let unknown keys through',
  },
  JsonValue: {
    valid: { a: [1, 'x', true, null, { b: 2 }] },
    invalid: [undefined, Number.NaN],
    note: "semantically identical to session-v1's JsonValue (a cross-file $ref); NaN is likewise registered in KNOWN_DIFFS",
  },
  SessionIdParams: {
    valid: detachParamsOk,
    invalid: [
      detachParamsExtra,
      { sessionId: rep(513) }, // boundary: maxLength:512
      {}, // missing required sessionId
    ],
    note: 'valid and the first invalid reuse fixtures/methods/i1.jsonl (session-detach-params-ok / session-detach-params-extra-key)',
  },
  ApprovalGrantListParams: {
    valid: { sessionId: 's', toolId: 'computer_use', scope: 'cua:click:background', policyVersion: 'v1' },
    invalid: [
      { sessionId: 's', toolId: 'computer_use', scope: 'cua:click:background', policyVersion: '' },
      {
        sessionId: 's',
        toolId: 'computer_use',
        scope: 'cua:click:background',
        policyVersion: 'v1',
        actorId: 'attacker',
      },
    ],
    note: 'grant list derives actor and profile server-side; callers provide only the exact policy binding',
  },
  ApprovalGrantRecord: {
    valid: {
      grantId: 'grant-1',
      profileHash: `sha256-${rep64}`,
      actorId: 'local',
      actorOrg: 'local',
      toolId: 'computer_use',
      scope: 'cua:click:background',
      policyVersion: 'v1',
      createdAt: '2026-09-19T00:00:00Z',
    },
    invalid: [
      {
        grantId: 'grant-1',
        profileHash: rep64,
        actorId: 'local',
        actorOrg: 'local',
        toolId: 'computer_use',
        scope: 'cua:click:background',
        policyVersion: 'v1',
        createdAt: '2026-09-19T00:00:00Z',
      },
      {
        grantId: 'grant-1',
        profileHash: `sha256-${rep64}`,
        actorId: 'local',
        actorOrg: 'local',
        toolId: 'computer_use',
        scope: 'cua:click:background',
        policyVersion: 'v1',
        createdAt: '2026-02-30T00:00:00Z',
      },
    ],
    note: 'public grant record preserves the durable full binding and strict timestamps',
  },
  ApprovalGrantRevokeParams: {
    valid: {
      sessionId: 's',
      toolId: 'computer_use',
      scope: 'cua:click:background',
      policyVersion: 'v1',
      grantId: 'grant-1',
    },
    invalid: [
      { sessionId: 's', toolId: 'computer_use', scope: 'cua:click:background', policyVersion: 'v1' },
      {
        sessionId: 's',
        toolId: 'computer_use',
        scope: 'cua:click:background',
        policyVersion: 'v1',
        grantId: '',
      },
    ],
    note: 'revoke adds only a bounded grant id to the server-derived list binding',
  },
  ApprovalGrantListResult: {
    valid: { grants: [] },
    invalid: [{}, { grants: [{}] }],
    note: 'grant listing is a closed array of fully bound durable records',
  },
  Empty: {
    valid: {},
    invalid: [
      detachResultNotEmpty,
      [], // an array is not the closed object this schema describes
    ],
    note:
      'the empty object is the only value this schema admits, so the negatives are the two ways to ' +
      'leave it; the first reuses the session-detach-result-not-empty fixture',
  },
  ComputerUseLockedPackageMutationStatus: {
    valid: {
      activationReady: false,
      recoveryReady: true,
      blockers: ['trusted-directory-handle-unavailable'],
    },
    invalid: [{ activationReady: true, recoveryReady: true, blockers: ['unknown'] }],
    note: 'locked package readiness is a closed read-only status projection',
  },
  ComputerUseStatusResult: {
    valid: {
      ...(byId(methodFixtures, 'computer-use-status-result-blocked') as Json),
      lockedPackageMutations: {
        activationReady: false,
        recoveryReady: true,
        blockers: ['trusted-directory-handle-unavailable'],
      },
    },
    invalid: [
      byId(methodFixtures, 'computer-use-status-result-running'),
      {
        schemaVersion: 1,
        status: 'blocked',
        admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
        runtime: { state: 'not-started', startAttempted: false },
        blockers: ['release-provenance-incomplete'],
        platform: 'darwin',
      },
      {
        schemaVersion: 1,
        status: 'blocked',
        admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
        runtime: { state: 'not-started', startAttempted: false },
        blockers: ['release-provenance-incomplete'],
        lockedPackageMutations: {
          activationReady: false,
          recoveryReady: true,
          blockers: ['untrusted-pathname-admitted'],
        },
      },
    ],
    note: 'closed P0-blocked status; fixtures pin that no driver or platform probe state is admitted',
  },
  ComputerUsePermissionsStatusResult: {
    valid: byId(methodFixtures, 'computer-use-permissions-result-blocked'),
    invalid: [
      {
        schemaVersion: 1,
        status: 'unavailable',
        admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
        probe: { state: 'ready', reason: 'production-driver-admission-disabled' },
      },
      {
        schemaVersion: 1,
        status: 'granted',
        admission: { state: 'ready', reason: 'macos-verified-driver' },
        probe: {
          state: 'passed',
          reason: 'macos-tcc-permissions-granted',
          accessibility: true,
          screenRecording: false,
        },
      },
      {
        schemaVersion: 1,
        status: 'required',
        admission: { state: 'ready', reason: 'macos-verified-driver' },
        probe: {
          state: 'passed',
          reason: 'macos-tcc-permissions-missing',
          accessibility: true,
          screenRecording: true,
        },
      },
    ],
    note: 'permission states fail closed and cannot contradict their macOS grant booleans',
  },
  ComputerUseDoctorParams: {
    valid: byId(methodFixtures, 'computer-use-doctor-params'),
    invalid: [byId(methodFixtures, 'computer-use-doctor-params-secret'), { include: [] }],
    note: 'bounded check selectors reject values that could carry option-attached credentials',
  },
  ComputerUseDoctorResult: {
    valid: {
      ...(byId(methodFixtures, 'computer-use-doctor-result-blocked') as Json),
      lockedPackageMutations: {
        activationReady: false,
        recoveryReady: true,
        blockers: ['trusted-directory-handle-unavailable'],
      },
    },
    invalid: [
      {
        schemaVersion: 1,
        status: 'blocked',
        admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
        checks: { state: 'pass', reason: 'production-driver-admission-disabled' },
      },
      {
        schemaVersion: 1,
        status: 'blocked',
        admission: { state: 'blocked', reason: 'p0-evidence-incomplete' },
        checks: { state: 'not-run', reason: 'production-driver-admission-disabled' },
        lockedPackageMutations: {
          activationReady: false,
          recoveryReady: true,
          blockers: ['trusted-directory-handle-unavailable'],
          mutationEnabled: true,
        },
      },
    ],
    note: 'P0-blocked doctor reports checks not-run rather than fixture or platform evidence',
  },
  ComputerUseOperationStartParams: {
    valid: { kind: 'update' },
    invalid: [{ kind: 'repair' }, { kind: 'install', force: true }],
    note: 'operation kinds are closed and cannot carry unreviewed force flags',
  },
  ComputerUseOperationStatusParams: {
    valid: { operationId: 'cu-123' },
    invalid: [{ operationId: '../bad' }],
    note: 'status accepts an optional opaque operation id only',
  },
  ComputerUseOperationIdParams: {
    valid: { operationId: 'cu-123' },
    invalid: [{}, { operationId: 'op-123' }],
    note: 'cancellation requires a namespaced operation id',
  },
  ComputerUseOperationResult: {
    valid: {
      schemaVersion: 1,
      status: 'found',
      operationId: 'cu-123',
      kind: 'update',
      state: 'running',
      phase: 'installing',
      startedAtMs: 1,
      updatedAtMs: 2,
    },
    invalid: [{ schemaVersion: 1, status: 'not-found', operationId: 'cu-123' }],
    note: 'operation results expose bounded progress without local errors or paths',
  },
  AuthClaimParams: {
    valid: authClaimOnce,
    invalid: [
      authClaimMixed,
      { kind: rep(65), value: 'u1' }, // boundary: maxLength:64
      { kind: 'send', value: rep(513) }, // boundary: maxLength:512
      { kind: 'send', value: 'u1', expiresAtMs: -1 }, // boundary: one below minimum:0
      { kind: 'send', value: 'u1', limit: 0, windowMs: 1000 }, // boundary: one below minimum:1
      { kind: 'send', value: 'u1', limit: 2, windowMs: 0 }, // boundary: one below minimum:1
      { value: 'u1' }, // neither branch is satisfied without kind
    ],
    note:
      'valid and the first invalid reuse fixtures/methods/i1.jsonl (auth-claim-params-once / ' +
      'auth-claim-params-mixed-shapes). The valid here is the once-only branch; the windowed branch ' +
      'is the valid sample of the METHODS entry below, so both branches are accepted somewhere',
  },
  AuthClaimResult: {
    valid: authClaimResultOk,
    invalid: [
      authClaimResultMissing,
      { granted: true, slot: -1 }, // boundary: one below minimum:0
      { granted: 'yes' }, // wrong type
    ],
    note: 'valid and the first invalid reuse fixtures/methods/i1.jsonl (auth-claim-result-ok / auth-claim-result-missing-granted)',
  },
  SessionEventParams: {
    valid: sessionEventOk,
    invalid: [
      sessionEventNoActor,
      { ...sessionEventOk, sessionId: rep(513) }, // boundary: maxLength:512
      { sessionId: 's1' }, // missing required event
      { ...sessionEventOk, _meta: {} }, // _meta declares ai.agnes.harness required
      // through the HarnessMeta $ref: an enum the side channel does not offer
      { ...sessionEventOk, _meta: { 'ai.agnes.harness': { ...harnessMetaOk, phase: 'bogus' } } },
    ],
    note: 'valid and the first invalid reuse fixtures/methods/i1.jsonl (session-event-params-ok / session-event-params-row-missing-actor)',
  },
  SessionPreviewParams: {
    valid: { sessionId: 's1', lane: 'main', effectId: 'e1', stream: 'text', offset: 0, delta: 'hi' },
    invalid: [
      { sessionId: 's1', lane: 'main', effectId: 'e1', stream: 'text', offset: -1, delta: 'hi' }, // boundary: minimum:0
      { sessionId: 's1', lane: 'main', effectId: 'e1', stream: 'audio', offset: 0, delta: 'hi' }, // enum
      { sessionId: 's1', lane: '', effectId: 'e1', stream: 'text', offset: 0, delta: 'hi' }, // boundary: minLength:1
      { sessionId: 's1', lane: 'main', effectId: 'e1', stream: 'text', offset: 0 }, // missing required delta
      { sessionId: 's1', lane: 'main', effectId: 'e1', stream: 'text', offset: 0, delta: 'hi', seq: 1 }, // additionalProperties:false
    ],
    note: 'hand-written; a preview carries no seq because it is never a ledger row',
  },
  DaemonNotice: {
    valid: daemonNoticeOk,
    invalid: [
      daemonNoticeBadKind,
      { ...daemonNoticeOk, sessionId: rep(513) }, // boundary: maxLength:512
      { kind: 'resumed', at: '2026-09-07T00:00:00Z' }, // missing required detail
      { kind: 'resumed', detail: {} }, // missing required at
    ],
    note: 'valid and the first invalid reuse fixtures/methods/i1.jsonl (daemon-notice-params-ok / daemon-notice-params-unknown-kind)',
  },
  // The four methods daemon's Task 10 needed and could not reach: session.fork/list/setPreset/
  // setModel had no entry anywhere in METHODS until now. Hand-written samples, same as
  // SessionProjectUIParams above — no fixture file is consulted for these four either.
  SlotName: {
    valid: 'primary',
    invalid: ['primary2', 'PRIMARY', ''],
    note: "model.json's closed seven-value SlotName enum, reused rather than retyped a second time",
  },
  SessionForkParams: {
    valid: { sessionId: 's', at: 12 },
    invalid: [
      { sessionId: 's' }, // missing required at
      { sessionId: 's', at: 0 }, // boundary: one below minimum:1
      { sessionId: 's', at: 12, childKey: rep(513) }, // boundary: maxLength:512
    ],
    note: 'fork params: sessionId + the seq to fork from, with an optional childKey',
  },
  WorkspaceEntry: {
    valid: {
      path: '/workspace/project',
      name: 'project',
      lastUsedAt: '2026-09-13T00:00:00.000Z',
      sessionCount: 2,
      available: true,
    },
    invalid: [
      { path: '', name: 'project', lastUsedAt: null, sessionCount: 0, available: true },
      {
        path: '/workspace/project',
        name: 'project',
        lastUsedAt: null,
        sessionCount: 0,
        available: true,
        workspaceId: 'not-hex',
      },
    ],
    note: 'workspace rows expose canonical path availability and backend session counts',
  },
  WorkspaceListParams: {
    valid: {},
    invalid: [{ extra: true }],
    note: 'workspace list has no caller-controlled filter',
  },
  WorkspaceListResult: {
    valid: { items: [] },
    invalid: [{}],
    note: 'workspace list always returns an item array',
  },
  WorkspaceAddParams: {
    valid: { path: '/workspace/project' },
    invalid: [{ path: '' }],
    note: 'workspace add requires one non-empty path for host validation',
  },
  SurfacesMountsParams: {
    valid: {},
    invalid: [{ extra: true }],
    note: 'surfaces mounts query has no caller-controlled filter',
  },
  SurfacesMountsResult: {
    valid: {
      mounts: [
        {
          package: 'agnes/demo-surface',
          surfaceId: 'demo',
          mount: '/demo',
          host: '127.0.0.1',
          port: 51234,
        },
      ],
    },
    invalid: [
      {
        mounts: [
          { package: 'agnes/demo-surface', surfaceId: 'demo', mount: '', host: '127.0.0.1', port: 51234 },
        ],
      }, // boundary: minLength:1
      {
        mounts: [
          { package: 'agnes/demo-surface', surfaceId: 'demo', mount: '/demo', host: '0.0.0.0', port: 51234 },
        ],
      }, // host is a closed loopback const
      {
        mounts: [
          { package: 'agnes/demo-surface', surfaceId: 'demo', mount: '/demo', host: '127.0.0.1', port: 0 },
        ],
      }, // boundary: minimum:1
      {
        mounts: [
          {
            package: 'agnes/demo-surface',
            surfaceId: 'demo',
            mount: '/demo',
            host: '127.0.0.1',
            port: 65536,
          },
        ],
      }, // boundary: maximum:65535
    ],
    note: 'Surface mount->endpoint rows for the CLI/Web mount-proxy bridge; host is always loopback',
  },
  WorkspaceAddResult: {
    valid: {
      workspace: {
        path: '/workspace/project',
        name: 'project',
        lastUsedAt: null,
        sessionCount: 0,
        available: true,
      },
    },
    invalid: [{ workspace: { path: '/workspace/project' } }],
    note: 'workspace add returns the canonical registered row',
  },
  SessionPreferences: {
    note: 'presentation preference',
    valid: { archived: false, title: '我的名称' },
    invalid: [{ archived: 'false' }, { archived: false, title: '' }],
  },
  SessionRenameParams: {
    note: 'manual title input',
    valid: { sessionId: 's', title: '名称' },
    invalid: [
      { sessionId: '', title: 'a' },
      { sessionId: 's', title: '' },
    ],
  },
  SessionArchiveParams: {
    note: 'archive input',
    valid: { sessionId: 's', archived: true },
    invalid: [{ sessionId: 's' }, { sessionId: 's', archived: 'yes' }],
  },
  DiagnosticsCollectParams: { note: 'collect takes no input', valid: {}, invalid: [{ extra: 1 }] },
  DiagnosticsCollectResult: {
    note: 'runtime info plus bounded audit tails',
    valid: {
      collectedAt: '2026-09-24T00:00:00.000Z',
      agh: { version: 'dev' },
      runtime: {
        platform: 'darwin',
        arch: 'arm64',
        osRelease: '25.0.0',
        node: '24.10.0',
        pid: 1,
        uptimeMs: 0,
      },
      logs: [{ name: 'daemon.jsonl', size: 0, text: '', truncated: false, missing: true }],
    },
    invalid: [{ collectedAt: 'x', agh: {}, runtime: {}, logs: [] }],
  },
  DiagnosticsEventsParams: {
    note: 'one bounded ledger page',
    valid: { sessionId: 's', afterSeq: 0, limit: 500, maxBytes: 1048576 },
    invalid: [
      { sessionId: 's', afterSeq: 0, limit: 501, maxBytes: 1 }, // boundary: one over limit maximum:500
      { sessionId: 's', afterSeq: -1, limit: 1, maxBytes: 1 }, // boundary: one below afterSeq minimum:0
    ],
  },
  DiagnosticsEventsResult: {
    note: 'items reuse the cross-file EventEnvelope; the empty page is the diagnostics.events result sample',
    valid: { events: [envOk], lastSeq: 5, nextAfterSeq: null },
    invalid: [{ events: [], lastSeq: 0 }],
  },
  SessionMeta: {
    valid: { sessionId: 's', createdAt: '2026-09-10T00:00:00Z', lastSeq: 3, generation: 1, preset: 'code' },
    invalid: [
      { createdAt: '2026-09-10T00:00:00Z', lastSeq: 3, generation: 1, preset: 'code' }, // missing sessionId
      {
        sessionId: 's',
        createdAt: '2026-09-10T00:00:00Z',
        lastSeq: -1, // boundary: one below minimum:0
        generation: 1,
        preset: 'code',
      },
      {
        sessionId: 's',
        createdAt: '2026-09-10T00:00:00Z',
        lastSeq: 3,
        generation: 0, // boundary: one below minimum:1
        preset: 'code',
      },
    ],
    note: 'one page row of session.list; lastSeq/generation boundaries and the five required fields',
  },
  SessionListParams: {
    valid: { q: { cwd: '/work', prefix: 'x', text: 'hello' }, cursor: 'c1', limit: 20 },
    invalid: [
      { limit: 0 }, // boundary: one below minimum:1
      { limit: 501 }, // boundary: one above maximum:500
      { cursor: rep(513) }, // boundary: maxLength:512
    ],
    note: 'every field is optional; the three boundaries are limit range and cursor length',
  },
  PageSessionMeta: {
    valid: {
      items: [
        { sessionId: 's', createdAt: '2026-09-10T00:00:00Z', lastSeq: 3, generation: 1, preset: 'code' },
      ],
      next: 'c2',
    },
    invalid: [
      {}, // missing required items
      { items: [{ sessionId: 's' }] }, // a row failing SessionMeta's own required fields
      { items: [], next: rep(513) }, // boundary: maxLength:512
    ],
    note: 'the $ref to SessionMeta propagates its required fields into each row',
  },
  SessionSetPresetParams: {
    valid: { sessionId: 's', preset: 'code' },
    invalid: [
      { sessionId: 's' }, // missing required preset
      { sessionId: 's', preset: rep(129) }, // boundary: maxLength:128
    ],
    note: 'setPreset params: sessionId + the preset name to switch to',
  },
  SessionSetModelParams: {
    valid: { sessionId: 's', slot: 'primary', route: 'r1', model: 'claude-sonnet-5', thinking: 'high' },
    invalid: [
      { sessionId: 's', slot: 'primary2', route: 'r1', model: 'claude-sonnet-5' }, // not in SlotName
      { sessionId: 's', slot: 'primary', model: 'claude-sonnet-5' }, // missing required route
      { sessionId: 's', slot: 'primary', route: 'r1', model: 'claude-sonnet-5', thinking: 'extreme' }, // not in ThinkingLevel
    ],
    note: 'setModel params: slot is the closed SlotName $ref, not retyped here; thinking is optional and $refs ThinkingLevel',
  },
  SessionSetYoloParams: {
    valid: { sessionId: 's', enabled: true },
    invalid: [
      { sessionId: 's' }, // missing required enabled
      { sessionId: 's', enabled: 'true' }, // not a boolean
    ],
    note: 'setYolo params: sessionId + the bypass flag to switch to',
  },
  EffectiveFromResult: {
    valid: { effectiveFromSeq: 9 },
    invalid: [
      {}, // missing required effectiveFromSeq
      { effectiveFromSeq: 0 }, // boundary: one below minimum:1
    ],
    note: 'the common result of setPreset/setModel: the seq the switch takes effect from',
  },
  SeqResult: {
    valid: { seq: 1 },
    invalid: [{}, { seq: 0 }],
    note: 'common append result; seq is required and starts at one',
  },
  ApprovalDecideParams: {
    valid: { ticket: 'ticket-1', verdict: 'allowed-once', approverCredential: { kind: 'local' } },
    invalid: [
      { ticket: 'ticket-1', verdict: 'cancelled', approverCredential: { kind: 'local' } },
      {
        ticket: 'ticket-1',
        verdict: 'allowed-once',
        approverCredential: { kind: 'local' },
        actor: parityActor,
      },
    ],
    note: 'credential-derived approval identity; actor is deliberately not accepted from the caller',
  },
  ParticipantParams: {
    valid: { sessionId: 's', credential: { kind: 'local' } },
    invalid: [{ sessionId: 's' }, { sessionId: 's', credential: { kind: 'sso' } }],
    note: 'join and leave both derive the actor from a wire credential',
  },
  ParticipantListResult: {
    valid: { participants: [{ actor: parityActor, joinedAt: '2026-09-11T00:00:00Z', surface: 'channel' }] },
    invalid: [{ participants: [{ actor: parityActor }] }, { participants: 'not-an-array' }],
    note: 'participant list rows carry the resolved actor and a valid join timestamp',
  },
  DirectoryUpsertParams: {
    valid: { entries: [{ kind: 'user', id: 'u', name: 'Alice', syncedAt: '2026-09-11T00:00:00Z' }] },
    invalid: [
      { entries: [{ kind: 'user', id: 'u', name: 'Alice' }] },
      {
        entries: Array.from({ length: 5001 }, () => ({
          kind: 'user',
          id: 'u',
          name: 'A',
          syncedAt: '2026-09-11T00:00:00Z',
        })),
      },
    ],
    note: 'directory rows retain channel validation and batches are capped at 5000',
  },
  DirectoryUpsertResult: {
    valid: { upserted: 1, deleted: 0 },
    invalid: [{ upserted: -1, deleted: 0 }, { upserted: 1 }],
    note: 'both non-negative counters are required',
  },
  JobIdParams: {
    valid: { jobId: 'job-1' },
    invalid: [{}, { jobId: rep(129) }],
    note: 'bounded job lookup key',
  },
  JobIdResult: {
    valid: { jobId: 'job-1' },
    invalid: [{}, { jobId: rep(129) }],
    note: 'bounded enqueue result key',
  },
  ExtUiResponseParams: {
    valid: { sessionId: 's', requestSeq: 1, action: 'accept', data: { id: 'export' } },
    invalid: [
      { sessionId: 's', requestSeq: 0, action: 'accept' },
      { sessionId: 's', requestSeq: 1, action: 'ok' },
    ],
    note: 'request sequence starts at one and action is a closed set',
  },
}

// ── model.json samples ───────────────────────────────────────────────────────────────────
// No fixture file produces these shapes (they are the model-layer request/response shapes, not events
// or method payloads), so every sample here is hand-written. The invalid list per entry follows the
// same discipline as the two documents above: one case sitting exactly one step outside each
// maxLength / minLength / pattern / minimum boundary the node declares, plus a closed-object and a
// discriminated-union miss where those apply.
const modelToolCall = { toolUseId: 't1', name: 'read', args: { path: 'a' }, ordinal: 0 }
const modelRequestBody = {
  kind: 'inference',
  sessionKey: 'agnes:t:a:cli:dm:x',
  slot: 'primary',
  route: 'agnes-gateway',
  model: 'agnes-flash',
  contractId: null,
  derivedHash: rep64,
  system: 'You are helpful.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
}
const modelRecordOk = {
  id: 'agnes-flash',
  name: 'Agnes Flash',
  api: 'openai-completions',
  route: 'agnes-gateway',
  baseUrl: 'https://gw.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}
const contractStampOk = {
  prompt_prefix_hash: null,
  tool_schema_hash: 'b'.repeat(64),
  parser_version: '1',
  contract_id: null,
  model: { route: 'agnes-gateway', id: 'agnes-flash' },
  derived_hash: rep64,
  sent_hash: rep64,
  transforms: [],
}
const probeReportOk = {
  route: 'agnes-gateway',
  ok: true,
  latencyMs: 12,
  checks: [{ name: 'auth', ok: true }],
}

const contractManifestOk: Json = {
  version: '1',
  model_family: 'deepseek-v4',
  parser_version: '1',
  released_at: '2026-09-09T00:00:00Z',
  sha256: { prefix: rep64, tools: rep64, syntax: rep64 },
}

const MODEL_SAMPLES: Record<string, Sample> = {
  ContractManifest: {
    valid: contractManifestOk,
    invalid: [
      { ...contractManifestOk, sha256: { ...(contractManifestOk.sha256 as Json), tools: 'short' } }, // the nested Sha256 pattern
      { ...contractManifestOk, released_at: 'yesterday' }, // format: date-time
      { ...contractManifestOk, version: rep(33) }, // boundary: one over maxLength:32
      { ...contractManifestOk, sha256: { prefix: rep64, tools: rep64 } }, // the hash triple is missing syntax
    ],
    note: 'the three hashes are shape-checked here and compared elsewhere; this package neither computes nor verifies them',
  },
  // The three cross-file aliases reuse session-v1's samples: one source of truth per definition.
  JsonValue: SESSION_SAMPLES.JsonValue as Sample,
  ContentBlock: SESSION_SAMPLES.ContentBlock as Sample,
  ToolCall: SESSION_SAMPLES.ToolCall as Sample,
  Billing: SESSION_SAMPLES.Billing as Sample,
  SlotName: {
    valid: 'primary',
    invalid: ['Primary', 'nope', 1],
    note: 'the seven slot names are a closed enum; the negatives are a case variant, a non-member and a non-string',
  },
  ThinkingLevel: {
    valid: 'max',
    invalid: ['extreme', 'High', 1],
    note: 'thinking levels are the closed off/minimal/low/medium/high/xhigh/max set exposed by onboarding and presets',
  },
  AiErrorCode: {
    valid: 'RATE_LIMIT',
    invalid: ['rate_limit', 'NOPE', null],
    note: 'the eleven error codes are a closed enum',
  },
  DecodeRule: {
    valid: 'think_tag',
    // 'native' is deliberately a negative: it is a sibling of DecodeRule wherever the two appear
    // together (an anyOf), never a member of DecodeRule itself.
    invalid: ['native', 'nope'],
    note: "the seven decode rules are a closed enum; 'native' belongs beside it, not in it",
  },
  Sha256: {
    valid: rep64,
    invalid: [
      'a'.repeat(63), // boundary: the pattern demands exactly 64 hex digits
      'a'.repeat(65), // boundary: one over
      'A'.repeat(64), // pattern: uppercase hex is not accepted
      `${'a'.repeat(63)}g`, // pattern: g is not a hex digit
    ],
    note: 'every hash field in this document funnels through Sha256, so its boundaries are pinned here once',
  },
  ToolSchema: {
    valid: { name: 'read_file', description: 'reads a file', parameters: { type: 'object' } },
    invalid: [
      { name: 'read_file', description: 'd' }, // missing required parameters
      { name: rep(65), description: 'd', parameters: {} }, // boundary: the pattern allows 1+63=64 chars
      { name: '1bad', description: 'd', parameters: {} }, // pattern: must not start with a digit
      { name: 'ok', description: rep(8193), parameters: {} }, // boundary: maxLength:8192
      { name: 'ok', description: 'd', parameters: {}, extra: 1 }, // additionalProperties:false
    ],
    note: 'hand-written; the name pattern is the same one session-v1 puts on ToolCall.name',
  },
  RequestMessage: {
    valid: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    invalid: [
      { role: 'system', content: [] }, // no branch of the discriminated union has this role
      { role: 'user' }, // missing required content
      // an assistant message carries only text/thinking blocks, never the full ContentBlock union
      { role: 'assistant', content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] },
      { role: 'tool_result', toolUseId: 't1', content: [] }, // missing required isError
      { role: 'tool_result', toolUseId: rep(129), content: [], isError: false }, // boundary: maxLength:128
    ],
    note: 'hand-written; the three branches are discriminated by role',
  },
  RequestBody: {
    valid: modelRequestBody,
    invalid: [
      { ...modelRequestBody, seams: {} }, // additionalProperties:false
      { ...modelRequestBody, kind: 'nope' }, // enum
      { ...modelRequestBody, sessionKey: rep(513) }, // boundary: maxLength:512
      { ...modelRequestBody, route: rep(129) }, // boundary: maxLength:128
      { ...modelRequestBody, model: rep(257) }, // boundary: maxLength:256
      { ...modelRequestBody, contractId: rep(129) }, // boundary: maxLength:128 on the string branch
      { ...modelRequestBody, derivedHash: 'a'.repeat(63) }, // boundary: Sha256 demands 64 digits
      { ...modelRequestBody, sampling: { temperature: 2.5 } }, // boundary: maximum:2
      { ...modelRequestBody, sampling: { maxTokens: 0 } }, // boundary: minimum:1
      { ...modelRequestBody, sampling: { thinking: 'extreme' } }, // enum
      { ...modelRequestBody, timeoutMs: { firstToken: 999, total: 60000 } }, // boundary: minimum:1000
      { ...modelRequestBody, timeoutMs: { firstToken: 30000 } }, // missing required total
    ],
    note: 'hand-written; sampling and timeoutMs are optional closed objects, so both are exercised through the optional path',
  },
  ModelCost: {
    valid: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    invalid: [
      { input: 3, output: 15, cacheRead: 0.3 }, // missing required cacheWrite
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, perImage: 1 }, // additionalProperties:false
    ],
    note: 'hand-written; the four price components are all required so a partial price table cannot be half-filled',
  },
  ModelRecord: {
    valid: modelRecordOk,
    invalid: [
      { ...modelRecordOk, contract_id: undefined }, // missing required contract_id
      { ...modelRecordOk, id: rep(257) }, // boundary: maxLength:256
      { ...modelRecordOk, name: rep(257) }, // boundary: maxLength:256
      { ...modelRecordOk, api: rep(65) }, // boundary: maxLength:64
      { ...modelRecordOk, route: rep(129) }, // boundary: maxLength:128
      { ...modelRecordOk, baseUrl: rep(2049) }, // boundary: maxLength:2048
      { ...modelRecordOk, contextWindow: 0 }, // boundary: minimum:1
      { ...modelRecordOk, maxTokens: 0 }, // boundary: minimum:1
      { ...modelRecordOk, input: ['audio'] }, // items enum
      { ...modelRecordOk, thinkingReplay: 'nope' }, // enum
      { ...modelRecordOk, toolCallFormats: ['nope'] }, // items: native plus the decode rules only
      { ...modelRecordOk, headers: { 'X-Agnes': 1 } }, // dict values are typed as strings
      { ...modelRecordOk, slot: 'nope' }, // enum via SlotName
    ],
    note: 'hand-written; toolCallFormats is the anyOf of a const and a $ref, so a non-member is the negative that matters',
  },
  ContractStamp: {
    valid: contractStampOk,
    invalid: [
      { ...contractStampOk, sent_hash: undefined }, // missing required sent_hash
      { ...contractStampOk, prompt_prefix_hash: 'a'.repeat(63) }, // boundary: Sha256 branch of the union
      { ...contractStampOk, parser_version: rep(33) }, // boundary: maxLength:32
      { ...contractStampOk, contract_id: rep(129) }, // boundary: maxLength:128 on the string branch
      { ...contractStampOk, model: { route: rep(129), id: 'm' } }, // boundary: maxLength:128
      { ...contractStampOk, model: { route: 'r', id: rep(257) } }, // boundary: maxLength:256
      { ...contractStampOk, model: { route: 'r', id: 'm', responseModel: rep(257) } }, // boundary: maxLength:256
      { ...contractStampOk, transforms: [{ event: rep(65), ext: 'e' }] }, // boundary: maxLength:64
      { ...contractStampOk, transforms: [{ event: 'e', ext: rep(129) }] }, // boundary: maxLength:128
      { ...contractStampOk, transforms: [{ event: 'e' }] }, // missing required ext
    ],
    note: 'hand-written; every hash field is a Sha256 $ref, so one boundary case per union position is enough',
  },
  TokenCounts: {
    valid: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 5 },
    invalid: [
      { input: 10, output: 20, cacheRead: 0 }, // missing required cacheWrite
      { input: -1, output: 20, cacheRead: 0, cacheWrite: 0 }, // boundary: minimum:0
      { input: 1.5, output: 20, cacheRead: 0, cacheWrite: 0 }, // integer, not number
      { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: -1 }, // boundary: minimum:0
    ],
    note: 'hand-written; the four counts are required and reasoning is the one optional fifth',
  },
  Timing: {
    valid: { ttftMs: 120, durationMs: 3400 },
    invalid: [
      { ttftMs: -1 }, // boundary: minimum:0
      { durationMs: -1 }, // boundary: minimum:0
      { ttftMs: 1.5 }, // integer, not number
      { ttftMs: 1, totalMs: 2 }, // additionalProperties:false
    ],
    note: 'hand-written; both fields are optional, so {} is legal and only the bounds and closure are testable',
  },
  CountResult: {
    valid: { tokens: 1200, source: 'provider', boundHash: rep64 },
    invalid: [
      { source: 'nope' }, // neither branch
      { tokens: 1200, source: 'provider' }, // missing required boundHash
      { tokens: -1, source: 'provider', boundHash: rep64 }, // boundary: minimum:0
      { tokens: 1200, source: 'unsupported', boundHash: rep64 }, // the unsupported branch carries no counts
      { tokens: 1200, source: 'provider', boundHash: 'a'.repeat(63) }, // boundary: Sha256
      { tokens: 1200, source: 'provider', boundHash: rep64, modelSnapshot: rep(257) }, // boundary: maxLength:256
    ],
    note: 'hand-written; the two branches are disjoint on source, so oneOf cannot match twice',
  },
  InferenceEvent: {
    valid: { type: 'sent', stamp: contractStampOk },
    invalid: [
      { type: 'nope' }, // no branch of the discriminated union
      { type: 'text_delta' }, // missing required delta
      { type: 'text_delta', delta: 'x', index: 0 }, // additionalProperties:false
      { type: 'toolcall_end', call: modelToolCall }, // missing required via
      { type: 'toolcall_end', call: modelToolCall, via: 'made_up' }, // via is native plus the decode rules
      { type: 'deviation', rule: 'other', sampleHash: 'c'.repeat(64) }, // const: unparsed
      { type: 'deviation', rule: 'unparsed', sampleHash: 'c'.repeat(63) }, // boundary: Sha256
      { type: 'usage', tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, creditSource: 'nope' }, // enum
      {
        type: 'usage',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'gateway',
        billing: { usdMicros: -1, source: 'gateway', subscription: true },
      },
      {
        type: 'usage',
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        creditSource: 'gateway',
        credits: -1,
      }, // boundary: minimum:0
      { type: 'done', reason: 'nope' }, // enum
      { type: 'error', reason: 'error', code: 'NOPE', message: 'x', retryable: true }, // AiErrorCode enum
      { type: 'error', reason: 'nope', code: 'AUTH', message: 'x', retryable: true }, // enum
      { type: 'error', reason: 'error', code: 'AUTH', message: rep(4097), retryable: true }, // boundary: maxLength:4096
      {
        type: 'error',
        reason: 'error',
        code: 'AUTH',
        message: 'x',
        retryable: true,
        retryAfterMs: -1,
      }, // boundary: minimum:0
      {
        type: 'error',
        reason: 'error',
        code: 'AUTH',
        message: 'x',
        retryable: true,
        requestId: rep(129),
      }, // boundary: maxLength:128
    ],
    note: 'hand-written; the seven branches are discriminated by type, and every branch is closed',
  },
  RouteDecl: {
    valid: { route: 'agnes-gateway', api: 'openai-completions', baseUrl: 'https://gw.invalid' },
    invalid: [
      { route: 'agnes-gateway', api: 'openai-completions' }, // missing required baseUrl
      { route: 'Agnes-Gateway', api: 'a', baseUrl: 'b' }, // pattern: lowercase slug only
      { route: '-leading', api: 'a', baseUrl: 'b' }, // pattern: must start alphanumeric
      { route: `a${'b'.repeat(64)}`, api: 'a', baseUrl: 'b' }, // boundary: the pattern allows 1+63=64 chars
      { route: 'r', api: rep(65), baseUrl: 'b' }, // boundary: maxLength:64
      { route: 'r', api: 'a', baseUrl: rep(2049) }, // boundary: maxLength:2048
      { route: 'r', api: 'a', baseUrl: 'b', displayName: rep(129) }, // boundary: maxLength:128
      { route: 'r', api: 'a', baseUrl: 'b', credentialRef: 'env://AGNES_KEY' }, // pattern: secret:// only
      { route: 'r', api: 'a', baseUrl: 'b', apiKey: 'sk-x' }, // additionalProperties:false
    ],
    note: 'hand-written; credentialRef is a reference, never a value, which the secret:// pattern enforces',
  },
  RouteTarget: {
    valid: { route: 'agnes-gateway', model: 'agnes-flash', fallbacks: [{ route: 'r2', model: 'm2' }] },
    invalid: [
      { route: 'r' }, // missing required model
      { route: rep(129), model: 'm' }, // boundary: maxLength:128
      { route: 'r', model: rep(257) }, // boundary: maxLength:256
      { route: 'r', model: 'm', fallbacks: [{ route: 'r2' }] }, // fallback entries need both fields
      { route: 'r', model: 'm', fallbacks: [{ route: rep(129), model: 'm2' }] }, // boundary: maxLength:128
      { route: 'r', model: 'm', fallbacks: [{ route: 'r2', model: rep(257) }] }, // boundary: maxLength:256
      { route: 'r', model: 'm', fallbacks: [{ route: 'r2', model: 'm2', weight: 1 }] }, // additionalProperties:false
    ],
    note: 'hand-written; a fallback is the same pair as the target itself, but may not nest further fallbacks',
  },
  RouteTable: {
    valid: { primary: { route: 'agnes-gateway', model: 'agnes-flash' } },
    invalid: [
      {}, // missing required primary
      { escalation: { route: 'r', model: 'm' } }, // every other slot is optional, but primary is not
      { primary: { route: 'r', model: 'm' }, planner: { route: 'r', model: 'm' } }, // additionalProperties:false
      { primary: { route: 'r' } }, // the target itself must be complete
    ],
    note: 'hand-written; primary is the one slot a table may not omit, and the key set is the seven slot names',
  },
  ProbeReport: {
    valid: probeReportOk,
    invalid: [
      { route: 'r', ok: true, checks: [] }, // missing required latencyMs
      { ...probeReportOk, latencyMs: -1 }, // boundary: minimum:0
      { ...probeReportOk, route: rep(129) }, // boundary: maxLength:128
      { ...probeReportOk, checks: [{ name: 'auth' }] }, // a check must report its verdict
      { ...probeReportOk, checks: [{ name: rep(65), ok: true }] }, // boundary: maxLength:64
      { ...probeReportOk, checks: [{ name: 'auth', ok: true, detail: rep(1025) }] }, // boundary: maxLength:1024
    ],
    note: 'hand-written; a probe report is what doctor prints, so every string it carries is bounded',
  },
}

const initP = byId(methodFixtures, 'initialize-params-ok') as Json
const initPBad = byId(methodFixtures, 'initialize-params-missing-protocolversion')
const initR = byId(methodFixtures, 'initialize-result-ok') as Json
const snewP = byId(methodFixtures, 'session-new-params-ok')
const snewPBad = byId(methodFixtures, 'session-new-params-missing-mcpservers')
const snewR = byId(methodFixtures, 'session-new-result-ok')
const promptP = byId(methodFixtures, 'session-prompt-params-ok')
const promptPBad = byId(methodFixtures, 'session-prompt-params-missing-prompt')
const promptR = byId(methodFixtures, 'session-prompt-result-ok')
const promptRBad = byId(methodFixtures, 'session-prompt-result-bad-stopreason')
const cancelP = byId(methodFixtures, 'session-cancel-params-ok')
const cancelPBad = byId(methodFixtures, 'session-cancel-params-missing-sessionid')
const updateP = byId(methodFixtures, 'session-update-params-ok')
const updatePBad = byId(methodFixtures, 'session-update-params-missing-update')
const reqPermP = byId(methodFixtures, 'session-request-permission-params-ok')
const reqPermPBad = byId(methodFixtures, 'session-request-permission-params-missing-options')
const reqPermR = byId(methodFixtures, 'session-request-permission-result-ok')
const reqPermRBad = byId(methodFixtures, 'session-request-permission-result-missing-outcome')

// The ACP schema is a vendored upstream file this repo does not modify, and it carries few numeric
// constraints of its own. `ProtocolVersion` (allOf → minimum:0 / maximum:65535) is the only one of the
// 10 referenced definitions from which a boundary negative can be constructed directly — conveniently,
// it also checks that the generator carried the numeric bounds across when it merged allOf into an
// Intersect.
const ACP_SAMPLES: Record<string, Sample> = {
  InitializeRequest: {
    valid: initP,
    invalid: [
      initPBad,
      { ...initP, protocolVersion: 65536 }, // boundary: maximum:65535
      { ...initP, protocolVersion: -1 }, // boundary: minimum:0
    ],
    note: 'valid and the first invalid reuse fixtures/methods/i1.jsonl; the rest are ProtocolVersion boundary negatives',
  },
  InitializeResponse: {
    valid: initR,
    invalid: [
      {}, // missing required protocolVersion
      { ...initR, protocolVersion: 65536 }, // boundary: maximum:65535
      { ...initR, protocolVersion: -1 }, // boundary: minimum:0
    ],
    note: 'valid reuses the initialize-result-ok fixture; invalid are hand-written (no separate negative fixture)',
  },
  NewSessionRequest: {
    valid: snewP,
    invalid: [snewPBad],
    note: 'the whole entry reuses fixtures/methods/i1.jsonl',
  },
  NewSessionResponse: {
    valid: snewR,
    invalid: [{}],
    note: 'valid reuses the session-new-result-ok fixture; invalid is hand-written (missing required sessionId)',
  },
  PromptRequest: {
    valid: promptP,
    invalid: [promptPBad],
    note: 'the whole entry reuses fixtures/methods/i1.jsonl',
  },
  PromptResponse: {
    valid: promptR,
    invalid: [promptRBad],
    note: 'the whole entry reuses fixtures/methods/i1.jsonl',
  },
  CancelNotification: {
    valid: cancelP,
    invalid: [cancelPBad],
    note: 'the whole entry reuses fixtures/methods/i1.jsonl',
  },
  SessionNotification: {
    valid: updateP,
    invalid: [updatePBad],
    note: 'the whole entry reuses fixtures/methods/i1.jsonl',
  },
  RequestPermissionRequest: {
    valid: reqPermP,
    invalid: [reqPermPBad],
    note: 'the whole entry reuses fixtures/methods/i1.jsonl',
  },
  RequestPermissionResponse: {
    valid: reqPermR,
    invalid: [reqPermRBad],
    note: 'the whole entry reuses fixtures/methods/i1.jsonl',
  },
  AuthenticateRequest: {
    valid: authenticateOk,
    invalid: [authenticateNoMethodId, { methodId: 5 }],
    note: 'valid and the first invalid reuse fixtures/methods/i1.jsonl (authenticate-params-ok / authenticate-params-missing-methodid)',
  },
  // The three responses declare no required property, so "missing a required field" is not available
  // as a negative. What is left is the two ways the shape itself can be wrong: an optional property
  // given a type it does not admit, and a value that is not an object at all.
  AuthenticateResponse: {
    valid: {},
    invalid: [
      { _meta: 5 }, // _meta is object|null upstream
      'not-an-object',
    ],
    note: 'no fixture records an illegal ACP response body, so both negatives are hand-written',
  },
  LoadSessionRequest: {
    valid: loadParamsOk,
    invalid: [loadParamsNoMcpServers, { ...loadParamsOk, cwd: 5 }],
    note: 'valid and the first invalid reuse fixtures/methods/i1.jsonl (session-load-params-ok / session-load-params-missing-mcpservers)',
  },
  LoadSessionResponse: {
    valid: {},
    invalid: [
      { modes: 5 }, // modes is SessionModeState|null upstream
      'not-an-object',
    ],
    note: 'no fixture records an illegal ACP response body, so both negatives are hand-written',
  },
  SetSessionModeRequest: {
    valid: setModeOk,
    invalid: [setModeNoModeId, { ...setModeOk, modeId: 5 }],
    note: 'valid and the first invalid reuse fixtures/methods/i1.jsonl (session-set-mode-params-ok / session-set-mode-params-missing-modeid)',
  },
  SetSessionModeResponse: {
    valid: {},
    invalid: [
      { _meta: 5 }, // _meta is object|null upstream
      'not-an-object',
    ],
    note: 'no fixture records an illegal ACP response body, so both negatives are hand-written',
  },
}
const toolMetaOk: Json = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  costHint: null,
  deferLoading: false,
  requiresApproval: 'never',
}
const parametersOk: Json = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: false,
}
const toolDefOk: Json = {
  name: 'read',
  description: 'Read a file',
  parameters: parametersOk,
  meta: toolMetaOk,
}

const TOOLDEF_SAMPLES: Record<string, Sample> = {
  JsonValue: SESSION_SAMPLES.JsonValue as Sample,
  ToolMeta: {
    valid: toolMetaOk,
    invalid: [
      { ...toolMetaOk, deferLoading: undefined }, // the in-process spelling of "no declaration"; on the wire it is null
      { ...toolMetaOk, replay: 'retry' }, // enum
      { ...toolMetaOk, requiresApproval: 'sometimes' }, // enum
      { ...toolMetaOk, costHint: { credits: -1 } }, // boundary: one below minimum:0
      { ...toolMetaOk, extra: 1 }, // additionalProperties:false
    ],
    note: 'all eight keys are required, so an author cannot leave one to a default nobody wrote down',
  },
  ParametersSchema: {
    valid: parametersOk,
    invalid: [
      { ...parametersOk, additionalProperties: true }, // const:false - a tool's arguments are a closed object
      { ...parametersOk, type: 'array' }, // const:'object'
      { properties: {}, additionalProperties: false }, // missing required type
      { ...parametersOk, description: rep(2049) }, // boundary: one over maxLength:2048
    ],
    note: 'the JSON Schema subset a tool may publish for its arguments, closed on both counts',
  },
  ToolDef: {
    valid: toolDefOk,
    invalid: [
      { ...toolDefOk, execute: 'fn' }, // additionalProperties:false - execute is code, not schema
      { ...toolDefOk, name: 'sales-analysis' }, // pattern: no hyphens
      { ...toolDefOk, name: `a${rep(64)}` }, // boundary: the pattern allows 1+63 characters
      { ...toolDefOk, description: '' }, // boundary: one below minLength:1
    ],
    note: 'the three model-visible fields plus meta; execute lives in code and must not appear here',
  },
}

// hooks.json samples. The seven aliases reuse the sample of the definition they point at, so each
// shape is described once. Every own definition carries a negative sitting one step outside a named
// constraint rather than merely dropping a required key.
const promptSectionOk: Json = { id: 's1', order: 0, text: 'hi' }
const resourceEntryOk: Json = { id: 'r1', kind: 'skill', name: 'n', description: 'd' }
const hookApprovalRequestOk: Json = {
  tool: 'shell',
  argvHash: rep64,
  risk: 'destructive',
  actor: parityActor,
  context: 'rm -rf',
}
const compactionPlanOk: Json = {
  keepFromSeq: 3,
  summarizeRange: [1, 2],
  prompts: { system: 's', history: 'h' },
  maxTokens: 1000,
  details: { readFiles: [], modifiedFiles: [] },
}
const hookToolResultOk: Json = {
  toolUseId: 't1',
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
  enforcement: { level: 'full', scope: ['file'] },
  authz: { decisionId: 'd1' },
}
// The seven observe hooks return nothing, and `null` is the one value that says so. Their $defs are
// separate names on purpose, because the extension-api type maps are generated from the pair names.
const nullReturn: Sample = {
  valid: null,
  invalid: [{}, 'ok', 0],
  note: 'an observe hook returns nothing; anything else is a value the runner would have to discard in silence',
}

const HOOKS_SAMPLES: Record<string, Sample> = {
  JsonValue: SESSION_SAMPLES.JsonValue as Sample,
  Actor: SESSION_SAMPLES.Actor as Sample,
  ContentBlock: SESSION_SAMPLES.ContentBlock as Sample,
  ToolResult: SESSION_SAMPLES.ToolResult as Sample,
  PlanItems: SESSION_SAMPLES.PlanItems as Sample,
  Verdict: SESSION_SAMPLES.Verdict as Sample,
  ToolMeta: TOOLDEF_SAMPLES.ToolMeta as Sample,
  ResolvedToolCallPolicy: SESSION_SAMPLES.ResolvedToolCallPolicy as Sample,
  ExecutionDomain: SESSION_SAMPLES.ExecutionDomain as Sample,
  HookEvent: {
    valid: 'tool_call',
    invalid: ['toolCall', 'registerCommand', 1],
    note: 'the seventeen event names are a closed enum; the negatives are a case variant, a non-member and a non-string',
  },
  PromptSection: {
    valid: promptSectionOk,
    invalid: [
      { ...promptSectionOk, order: -1 }, // boundary: one below minimum:0
      { ...promptSectionOk, id: rep(65) }, // boundary: one over maxLength:64
      { id: 's1', order: 0 }, // missing required text
    ],
    note: 'one ordered chunk of the system prompt, which the context hook rewrites as a whole list',
  },
  ResourceEntry: {
    valid: resourceEntryOk,
    invalid: [
      { ...resourceEntryOk, kind: 'plugin' }, // enum
      { ...resourceEntryOk, description: rep(2049) }, // boundary: one over maxLength:2048
      { id: 'r1', kind: 'skill', name: 'n' }, // missing required description
    ],
    note: 'what resources_discover advertises; `schema` is free-form JSON because each kind describes itself differently',
  },
  SurfaceDigest: {
    valid: { nodes: 3, tokensEstimate: 40 },
    invalid: [
      { nodes: -1, tokensEstimate: 40 }, // boundary: one below minimum:0
      { nodes: 3 }, // missing required tokensEstimate
    ],
    note: 'a size summary rather than the surface itself: the surface is fetched lazily and is not serialisable into a payload',
  },
  ApprovalRequest: {
    valid: hookApprovalRequestOk,
    invalid: [
      { ...hookApprovalRequestOk, argvHash: rep(63) }, // boundary: the pattern demands exactly 64 hex digits
      { ...hookApprovalRequestOk, risk: 'mild' }, // enum
      { ...hookApprovalRequestOk, context: rep(4097) }, // boundary: one over maxLength:4096
    ],
    note: 'the hook-side view of an ask, narrower than the approval/asked ledger row',
  },
  CompactionPlan: {
    valid: compactionPlanOk,
    invalid: [
      { ...compactionPlanOk, summarizeRange: [1] }, // boundary: one below minItems:2
      { ...compactionPlanOk, summarizeRange: [1, 2, 3] }, // boundary: one over maxItems:2
      { ...compactionPlanOk, maxTokens: 0 }, // boundary: one below minimum:1
      { ...compactionPlanOk, prompts: { system: 's' } }, // missing required history
    ],
    note: 'what before_compact may hand back instead of null; the range is a pair, pinned on both ends',
  },

  SessionStartPayload: {
    valid: { reason: 'new', preset: 'standard', cwd: '/w' },
    invalid: [
      { reason: 'restart', preset: 'standard', cwd: '/w' }, // enum
      { reason: 'new', preset: 'standard' }, // missing required cwd
    ],
    note: 'hand-written',
  },
  SessionStartReturn: nullReturn,
  ResourcesDiscoverPayload: {
    valid: { actor: parityActor, cwd: '/w', registered: [resourceEntryOk] },
    invalid: [
      { actor: parityActor, cwd: '/w' }, // missing required registered
      { actor: parityActor, cwd: '/w', registered: [{ ...resourceEntryOk, kind: 'plugin' }] }, // the nested enum
    ],
    note: 'hand-written; `registered` is what the host already knows about, so a hook can avoid duplicating it',
  },
  ResourcesDiscoverReturn: {
    valid: { resources: [resourceEntryOk], additionalContext: 'x' },
    invalid: [
      { resources: [{ ...resourceEntryOk, kind: 'plugin' }] }, // the nested enum
      { additionalContext: rep(8193) }, // boundary: one over maxLength:8192
      { resources: [], extra: 1 }, // additionalProperties:false
    ],
    note: 'every field is optional: a transform hook that changes nothing returns an empty object',
  },
  BeforeStepPayload: {
    valid: { turn: 1, step: 2, depth: 0, budget: { remaining: 5, cap: null } },
    invalid: [
      { turn: 1, step: 2, depth: -1, budget: { remaining: 5, cap: null } }, // boundary: one below minimum:0
      { turn: 1, step: 2, depth: 0, budget: { remaining: 5 } }, // missing required cap
      { turn: 1, step: 2, depth: 0 }, // missing required budget
    ],
    note: 'hand-written; remaining and cap are nullable because an uncapped session has neither',
  },
  BeforeStepReturn: {
    valid: { block: true, reason: 'not now' },
    invalid: [
      { block: 'yes' }, // type
      { reason: rep(1025) }, // boundary: one over maxLength:1024
      { block: true, halt: true }, // additionalProperties:false
    ],
    note: 'a directive hook: the only thing it may say is stop, and why',
  },
  ContextPayload: {
    valid: { sections: [promptSectionOk], surfaceDigest: { nodes: 3, tokensEstimate: 40 } },
    invalid: [
      { sections: [promptSectionOk] }, // missing required surfaceDigest
      { sections: [{ ...promptSectionOk, order: -1 }], surfaceDigest: { nodes: 0, tokensEstimate: 0 } }, // the nested boundary
    ],
    note: 'carries the digest rather than the surface, which is fetched through a runtime call and cannot be serialised here',
  },
  ContextReturn: {
    valid: { sections: [promptSectionOk] },
    invalid: [
      { sections: [{ id: 's1', order: 0 }] }, // the nested section is missing text
      { additionalContext: rep(8193) }, // boundary: one over maxLength:8192
    ],
    note: 'hand-written',
  },
  BeforeRequestPayload: {
    valid: { request: { messages: [] }, slot: 'primary', model: 'm', attempt: 1 },
    invalid: [
      { request: {}, slot: 'primary', model: 'm', attempt: 0 }, // boundary: one below minimum:1
      { request: {}, slot: 'primary', model: 'm' }, // missing required attempt
    ],
    note: 'hand-written; the request is JsonValue because its shape belongs to the provider api, not to this document',
  },
  BeforeRequestReturn: {
    valid: { patch: { maxTokens: 100, samplingParams: { temperature: 0.2 } } },
    invalid: [
      { patch: { maxTokens: 0 } }, // boundary: one below minimum:1
      { patch: { model: 'other' } }, // additionalProperties:false - a hook may not reroute the request
      { maxTokens: 100 }, // additionalProperties:false - the patch is a named envelope
    ],
    note: 'the patch is a closed set of fields, so a hook cannot silently repoint the request at another model',
  },
  BeforeProviderHeadersPayload: {
    valid: { route: 'default', headers: { Authorization: 'x' } },
    invalid: [
      { route: 'default' }, // missing required headers
      { route: 'default', headers: { Authorization: 1 } }, // the dictionary's value type
    ],
    note: 'hand-written',
  },
  BeforeProviderHeadersReturn: {
    valid: { headers: { 'X-Ext-Trace': '1' } },
    invalid: [
      { headers: { 'X-Agnes-Session': 'x' } }, // propertyNames: an extension may only add its own namespace
      { headers: { 'X-Ext-Trace': 1 } }, // the value type
      { headers: {}, extra: 1 }, // additionalProperties:false
    ],
    note:
      'the key pattern is the whole point of this return, and TypeBox needed the closing option to ' +
      'enforce it - see the keyed-dictionary branch in tools/gen-core.ts',
  },
  RequestErrorPayload: {
    valid: { code: 'RATE_LIMIT', message: 'slow down', attempt: 2, retryable: true },
    invalid: [
      { code: 'RATE_LIMIT', message: 'slow down', attempt: 2 }, // missing required retryable
      { code: 'RATE_LIMIT', message: 'slow down', attempt: 2, retryable: 'yes' }, // type
    ],
    note: 'hand-written',
  },
  RequestErrorReturn: nullReturn,
  ToolCallPayload: {
    valid: {
      toolUseId: 't1',
      name: 'read',
      args: { path: 'a' },
      meta: toolMetaOk,
      actor: parityActor,
      taint: false,
      resolvedPolicy: resolvedToolCallPolicyOk,
      executionDomain: 'workspace',
      definitionFingerprint: rep64,
      policyHash: 'b'.repeat(64),
    },
    invalid: [
      { toolUseId: 't1', name: 'read', args: {}, meta: toolMetaOk, actor: parityActor }, // missing required taint
      {
        toolUseId: 't1',
        name: 'read',
        args: {},
        meta: { ...toolMetaOk, replay: 'retry' },
        actor: parityActor,
        taint: false,
      }, // the nested ToolMeta enum
      {
        toolUseId: 't1',
        name: 'read',
        args: {},
        meta: toolMetaOk,
        actor: parityActor,
        taint: false,
        resolvedPolicy: { ...resolvedToolCallPolicyOk, executionDomain: 'host-computer-use' },
      }, // the policy is closed; domain attestation is a sibling owned by Host
      {
        toolUseId: 't1',
        name: 'read',
        args: {},
        meta: toolMetaOk,
        actor: parityActor,
        taint: false,
        executionDomain: 'ordinary-sandbox',
      },
      {
        toolUseId: 't1',
        name: 'read',
        args: {},
        meta: toolMetaOk,
        actor: parityActor,
        taint: false,
        definitionFingerprint: rep(63),
      },
    ],
    note: 'carries the full ToolMeta so a directive hook can decide on the same facts the kernel used',
  },
  ToolCallReturn: {
    valid: { allow: true },
    invalid: [
      { allow: 'ask' }, // neither branch of the union
      { allow: false }, // the deny branch requires a reason
      { allow: true, reason: 'why' }, // the allow branch is closed, so an allow cannot carry one
    ],
    note: 'a deny must say why, and an allow must not: the two branches are closed in opposite directions',
  },
  ToolResultPayload: {
    valid: {
      toolUseId: 't1',
      name: 'read',
      args: { path: 'a' },
      result: hookToolResultOk,
      enforcement: { level: 'full', scope: ['file', 'network'] },
    },
    invalid: [
      {
        toolUseId: 't1',
        name: 'read',
        args: {},
        result: hookToolResultOk,
        enforcement: { level: 'full', scope: ['disk'] },
      }, // enum
      { toolUseId: 't1', name: 'read', args: {}, result: hookToolResultOk }, // missing required enforcement
    ],
    note: 'hand-written; enforcement travels with the result so a hook can tell a sandboxed result from an unsandboxed one',
  },
  ToolResultReturn: {
    valid: { result: hookToolResultOk },
    invalid: [
      { result: { toolUseId: 't1', content: [] } }, // the nested ToolResult is missing required fields
      { result: hookToolResultOk, extra: 1 }, // additionalProperties:false
    ],
    note: 'hand-written; the only thing a transform hook may replace is the result itself',
  },
  TurnStoppingPayload: {
    valid: { turn: 1, step: 2, proposedReason: 'completed', verifier: { outcome: 'pass', reasons: [] } },
    invalid: [
      { turn: 1, step: 2, proposedReason: 'finished' }, // enum
      { turn: 1, step: 2 }, // missing required proposedReason
      { turn: 1, step: 2, proposedReason: 'completed', verifier: { outcome: 'pass' } }, // the nested Verdict is missing reasons
    ],
    note: 'hand-written; the reason vocabulary is the turn-end one, so a hook reads the same names the ledger writes',
  },
  TurnStoppingReturn: {
    valid: { action: 'stop' },
    invalid: [
      { action: 'continue' }, // the continue branch requires a note
      { action: 'retry' }, // neither branch
      { action: 'stop', note: 'why' }, // the stop branch is closed
    ],
    note: 'continuing a turn the kernel wanted to end has to be explained; stopping does not',
  },
  ApprovalRequestPayload: {
    valid: { request: hookApprovalRequestOk },
    invalid: [
      { request: { ...hookApprovalRequestOk, argvHash: 'short' } }, // the nested pattern
      {}, // missing required request
    ],
    note: 'hand-written',
  },
  ApprovalRequestReturn: {
    valid: { request: { risk: 'always', context: 'raised by policy' } },
    invalid: [
      { request: { risk: 'mild' } }, // enum
      { request: { tool: 'shell' } }, // additionalProperties:false - a hook may raise the risk, not retarget the ask
      { request: { context: rep(4097) } }, // boundary: one over maxLength:4096
    ],
    note: 'deliberately narrower than the payload: only risk and context may be rewritten',
  },
  BeforeCompactPayload: {
    valid: { contextTokens: 90000, contextWindow: 128000, reserveTokens: 16384, reason: 'threshold' },
    invalid: [
      { contextTokens: 90000, contextWindow: 0, reserveTokens: 16384, reason: 'threshold' }, // boundary: one below minimum:1
      { contextTokens: 90000, contextWindow: 128000, reserveTokens: 16384, reason: 'full' }, // enum
      { contextTokens: -1, contextWindow: 128000, reserveTokens: 16384, reason: 'threshold' }, // boundary: one below minimum:0
      { contextTokens: 90000, contextWindow: 128000, reserveTokens: 0, reason: 'threshold' }, // boundary: one below minimum:1
      { contextTokens: 90000, contextWindow: 128000, reason: 'threshold' }, // missing required reserveTokens
    ],
    note: 'hand-written',
  },
  BeforeCompactReturn: {
    valid: null,
    invalid: [
      { ...compactionPlanOk, maxTokens: 0 }, // the plan branch, one below minimum:1
      {}, // neither null nor a complete plan
    ],
    note: 'null means "use the default plan"; anything else has to be a complete plan',
  },
  CompactPayload: {
    valid: { replaceSeq: 12, range: [1, 11], tokensBefore: 90000, tokensAfter: 4000 },
    invalid: [
      { replaceSeq: 0, range: [1, 11], tokensBefore: 1, tokensAfter: 1 }, // boundary: one below minimum:1
      { replaceSeq: 12, range: [1], tokensBefore: 1, tokensAfter: 1 }, // boundary: one below minItems:2
      { replaceSeq: 12, range: [1, 11], tokensBefore: 1 }, // missing required tokensAfter
    ],
    note: 'hand-written; observed after the fact, so it reports what was replaced rather than proposing it',
  },
  CompactReturn: nullReturn,
  SubagentStartPayload: {
    valid: { childKey: 'c1', kind: 'fork', budget: null },
    invalid: [
      { childKey: 'c1', kind: 'detach', budget: null }, // enum
      { childKey: 'c1', kind: 'fork' }, // missing required budget - an unbudgeted child says so with null
    ],
    note: 'budget is required and nullable: "no budget" has to be stated, not left out',
  },
  SubagentStartReturn: nullReturn,
  SubagentEndPayload: {
    valid: { childKey: 'c1', outcome: 'completed', credits: 1.5 },
    invalid: [
      { childKey: 'c1', outcome: 'finished', credits: 1.5 }, // enum
      { childKey: 'c1', outcome: 'completed', credits: -1 }, // boundary: one below minimum:0
    ],
    note: 'hand-written',
  },
  SubagentEndReturn: nullReturn,
  FormatDeviationPayload: {
    valid: { rule: 'unparsed', model: 'm', sampleHash: rep64 },
    invalid: [
      { rule: 'unparsed', model: 'm', sampleHash: 'xyz' }, // pattern: 64 hex digits
      { rule: 'unparsed', model: 'm' }, // missing required sampleHash
    ],
    note: 'the hash rather than the sample: the sample is model output and must not travel into a hook payload',
  },
  FormatDeviationReturn: nullReturn,
  ShutdownPayload: {
    valid: { reason: 'close' },
    invalid: [
      { reason: 'crash' }, // enum
      {}, // missing required reason
    ],
    note: 'hand-written',
  },
  ShutdownReturn: nullReturn,
}

const toolCardOk: Json = {
  title: 'monthly sales',
  table: { columns: ['region', 'amount'], rows: [['east', '1,200']] },
  actions: [{ id: 'export', label: 'Export' }],
}

const SLOTS_SAMPLES: Record<string, Sample> = {
  UiSlotName: {
    valid: 'status.line',
    invalid: ['statusline', 'primary', 1],
    note: "the four UI slot names are a closed enum; 'primary' is a model slot and belongs to a different set entirely",
  },
  ToolCardInlinePayload: {
    valid: toolCardOk,
    invalid: [
      { ...toolCardOk, chart: { kind: 'pie', series: [] } }, // enum: bar and line only
      { ...toolCardOk, actions: [{ id: 'Bad Id', label: 'y' }] }, // pattern: lower-case, no spaces
      { ...toolCardOk, table: { columns: ['a'] } }, // the nested table is missing rows
      { title: rep(257) }, // boundary: one over maxLength:256
      { ...toolCardOk, actions: Array.from({ length: 9 }, () => ({ id: 'a', label: 'b' })) }, // boundary: one over maxItems:8
    ],
    note: 'the richest of the four payloads, and the only one that can carry a chart',
  },
  SidebarActionPayload: {
    valid: { id: 'rerun', label: 'Re-run', icon: 'arrow', disabled: false },
    invalid: [
      { id: 'Re Run', label: 'Re-run' }, // pattern
      { id: 'rerun' }, // missing required label
      { id: 'rerun', label: rep(65) }, // boundary: one over maxLength:64
    ],
    note: 'hand-written; the id pattern is the same one the card actions use, so both are addressable the same way',
  },
  StatusLinePayload: {
    valid: { text: '3 tools running', level: 'info' },
    invalid: [
      { text: 'x', level: 'debug' }, // enum
      { text: 'x' }, // missing required level
      { text: rep(513), level: 'info' }, // boundary: one over maxLength:512
      { text: 'x', level: 'info', onClick: 'fn' }, // additionalProperties:false - a slot carries data, never behaviour
    ],
    note: 'the closed-object negative matters here: a slot payload crosses a process boundary, so a function-shaped key must be refused rather than dropped',
  },
  NotificationPayload: {
    valid: { title: 'done', body: 'the turn finished', link: 'https://example.invalid/x' },
    invalid: [
      { title: 'done' }, // missing required body
      { title: 'done', body: rep(4097) }, // boundary: one over maxLength:4096
      { title: 'done', body: 'x', link: rep(2049) }, // boundary: one over maxLength:2048
    ],
    note: 'hand-written',
  },
}

const FORMAT_SAMPLES: Record<string, Sample> = {
  UriFormat: {
    valid: 'https://example.com/a?b=c#d',
    invalid: [
      'not a uri', // no scheme
      'http://', // library-level difference, see KNOWN_DIFFS (delete the entry → falls back to "both must reject" → goes red)
    ],
    note: "comparing the format checkers themselves: ajv-formats' uri regex vs the new URL() checker the generated module registers",
  },
  DateTimeFormat: {
    valid: '2026-09-07T00:00:00Z',
    invalid: [
      'not-a-date',
      '',
      '2026-09-07',
      '2026-02-30T00:00:00Z',
      '1900-02-29T00:00:00Z',
      '2026-09-07T24:00:00Z',
    ],
    note: "comparing the format checkers themselves: ajv-formats' date-time vs the generated module's calendar-aware check",
  },
}

// ---------------------------------------------------------------------------
// The generic loop: every comparison entry runs 1 valid sample and N invalid ones, and every sample
// is looked up in KNOWN_DIFFS first.

type ParityTarget = { check: (x: unknown) => boolean; schema: TSchema }

function preview(x: unknown): string {
  if (x === undefined) return 'undefined'
  if (typeof x === 'number' && Number.isNaN(x)) return 'NaN'
  const s = JSON.stringify(x) ?? String(x)
  return s.length > 72 ? `${s.slice(0, 72)}…(${s.length} chars)` : s
}

function assertParity(target: ParityTarget, scope: string, name: string, x: unknown, expected: boolean) {
  const diff = matchDiff(scope, name, x)
  const actual = { ajv: target.check(x), typebox: Value.Check(target.schema, x) }
  if (diff) {
    // A registered library-level difference: assert the specific pair of verdicts from the table.
    // Delete the entry and this sample takes the generic assertion below instead, and goes red.
    expect(actual, diff.reason).toEqual({ ajv: diff.ajv, typebox: diff.typebox })
    return
  }
  expect(actual).toEqual({ ajv: expected, typebox: expected })
}

describe('persisted tool policy envelope ajv ↔ TypeBox parity', () => {
  const keys = ['resolvedPolicy', 'executionDomain', 'definitionFingerprint', 'policyHash'] as const
  const withoutEnvelope = (value: Json): Json => {
    const copy = clone(value)
    for (const key of keys) delete copy[key]
    return copy
  }
  const eachPartial = (value: Json): Json[] =>
    keys.map((missing) => {
      const copy = clone(value)
      delete copy[missing]
      return copy
    })
  const hookFull: Json = {
    toolUseId: 't1',
    name: 'read',
    args: {},
    meta: toolMetaOk,
    actor: parityActor,
    taint: false,
    resolvedPolicy: resolvedToolCallPolicyOk,
    executionDomain: 'workspace',
    definitionFingerprint: rep64,
    policyHash: 'b'.repeat(64),
  }
  const cases: Array<[string, string, TSchema, Json]> = [
    [SESSION_ID, 'ToolCall', SessionGen.ToolCall, toolCallOk],
    [SESSION_ID, 'ToolCallState', SessionGen.ToolCallState, toolCallStateOk],
    [HOOKS_ID, 'ToolCallPayload', HooksGen.ToolCallPayload, hookFull],
  ]

  it.each(cases)(
    '%s#/$defs/%s accepts absent/full and rejects every partial envelope',
    (scope, name, schema, full) => {
      const target = { check: ajvDef(scope, name), schema }
      assertParity(target, scope, name, withoutEnvelope(full), true)
      assertParity(target, scope, name, full, true)
      for (const partial of eachPartial(full)) assertParity(target, scope, name, partial, false)
    },
  )

  it('keeps the persisted-policy envelope all-or-none across every ToolCallState branch', () => {
    const target = {
      check: ajvDef(SESSION_ID, 'ToolCallState'),
      schema: SessionGen.ToolCallState,
    }
    const legacyCompatible = [
      { ...toolCallStateOk, status: 'planned' },
      { ...toolCallStateOk, status: 'awaiting_approval' },
      { ...toolCallStateOk, status: 'effect_pending', effectId: 'effect-1' },
      { ...toolCallStateOk, status: 'completed' },
      { ...toolCallStateOk, status: 'completed', effectId: 'effect-1' },
    ]
    const requiresEnvelope = [
      { ...toolCallStateOk, status: 'approved' },
      {
        ...toolCallStateOk,
        status: 'dispatch_pending',
        effectId: 'effect-1',
        dispatchAttempt: 1,
      },
      {
        ...toolCallStateOk,
        status: 'dispatched',
        effectId: 'effect-1',
        dispatchAttempt: 1,
        dispatchPhase: 'may_have_sent',
      },
      {
        ...toolCallStateOk,
        status: 'responded',
        effectId: 'effect-1',
        dispatchAttempt: 1,
        dispatchPhase: 'responded',
      },
      {
        ...toolCallStateOk,
        status: 'completed',
        effectId: 'effect-1',
        dispatchAttempt: 1,
        dispatchPhase: 'responded',
      },
    ]
    for (const full of legacyCompatible) {
      assertParity(target, SESSION_ID, 'ToolCallState', full, true)
      assertParity(target, SESSION_ID, 'ToolCallState', withoutEnvelope(full), true)
      for (const partial of eachPartial(full))
        assertParity(target, SESSION_ID, 'ToolCallState', partial, false)
    }
    for (const full of requiresEnvelope) {
      assertParity(target, SESSION_ID, 'ToolCallState', full, true)
      assertParity(target, SESSION_ID, 'ToolCallState', withoutEnvelope(full), false)
      for (const partial of eachPartial(full))
        assertParity(target, SESSION_ID, 'ToolCallState', partial, false)
    }
  })
})

describe('tool-call dispatch state ajv ↔ TypeBox parity', () => {
  const target = {
    check: ajvDef(SESSION_ID, 'ToolCallState'),
    schema: SessionGen.ToolCallState,
  }
  const state = (status: string, patch: Json = {}): Json => ({
    ...toolCallStateOk,
    status,
    ...patch,
  })
  const legacyState = (status: string, patch: Json = {}): Json => {
    const value = state(status, patch)
    for (const key of ['resolvedPolicy', 'executionDomain', 'definitionFingerprint', 'policyHash'])
      delete value[key]
    return value
  }

  const valid = [
    state('planned'),
    state('awaiting_approval'),
    state('approved'),
    state('dispatch_pending', { effectId: 'effect-1', dispatchAttempt: 1 }),
    state('dispatch_pending', {
      effectId: 'effect-1',
      dispatchAttempt: 2,
      dispatchPhase: 'not_sent',
      executionDomain: 'host-computer-use',
    }),
    state('effect_pending', { effectId: 'effect-1' }),
    state('dispatched', {
      effectId: 'effect-1',
      dispatchAttempt: 1,
      dispatchPhase: 'may_have_sent',
    }),
    state('responded', {
      effectId: 'effect-1',
      dispatchAttempt: 1,
      dispatchPhase: 'responded',
    }),
    state('completed'),
    state('completed', { effectId: 'effect-1' }),
    state('completed', {
      effectId: 'effect-1',
      dispatchAttempt: 2,
      dispatchPhase: 'responded',
    }),
  ]
  const invalid = [
    legacyState('approved'),
    legacyState('dispatch_pending', { effectId: 'effect-1', dispatchAttempt: 1 }),
    legacyState('dispatched', {
      effectId: 'effect-1',
      dispatchAttempt: 1,
      dispatchPhase: 'may_have_sent',
    }),
    legacyState('responded', {
      effectId: 'effect-1',
      dispatchAttempt: 1,
      dispatchPhase: 'responded',
    }),
    legacyState('completed', {
      effectId: 'effect-1',
      dispatchAttempt: 1,
      dispatchPhase: 'responded',
    }),
    state('planned', { effectId: 'effect-1' }),
    state('awaiting_approval', { dispatchPhase: 'not_sent' }),
    state('approved', { dispatchAttempt: 1 }),
    state('dispatch_pending', { dispatchAttempt: 1 }),
    state('dispatch_pending', { effectId: 'effect-1' }),
    state('dispatch_pending', {
      effectId: 'effect-1',
      dispatchAttempt: 1,
      dispatchPhase: 'may_have_sent',
    }),
    state('dispatch_pending', {
      effectId: 'effect-1',
      dispatchAttempt: 2,
      dispatchPhase: 'not_sent',
      executionDomain: 'workspace',
    }),
    state('effect_pending'),
    state('effect_pending', { effectId: 'effect-1', dispatchAttempt: 1 }),
    state('effect_pending', { effectId: 'effect-1', dispatchPhase: 'may_have_sent' }),
    state('effect_pending', {
      effectId: 'effect-1',
      dispatchAttempt: 1,
      dispatchPhase: 'responded',
    }),
    state('dispatched', { dispatchAttempt: 1, dispatchPhase: 'may_have_sent' }),
    state('dispatched', { effectId: 'effect-1', dispatchPhase: 'may_have_sent' }),
    state('dispatched', { effectId: 'effect-1', dispatchAttempt: 1 }),
    state('dispatched', {
      effectId: 'effect-1',
      dispatchAttempt: 1,
      dispatchPhase: 'not_sent',
    }),
    state('responded', { dispatchAttempt: 1, dispatchPhase: 'responded' }),
    state('responded', { effectId: 'effect-1', dispatchPhase: 'responded' }),
    state('responded', { effectId: 'effect-1', dispatchAttempt: 1 }),
    state('responded', {
      effectId: 'effect-1',
      dispatchAttempt: 1,
      dispatchPhase: 'may_have_sent',
    }),
    state('completed', { dispatchPhase: 'responded' }),
    state('completed', { effectId: 'effect-1', dispatchPhase: 'may_have_sent' }),
    state('completed', { dispatchAttempt: 1, dispatchPhase: 'responded' }),
    state('completed', { effectId: 'effect-1', dispatchAttempt: 1 }),
    state('completed', {
      effectId: 'effect-1',
      dispatchAttempt: 0,
      dispatchPhase: 'not_sent',
    }),
    state('completed', {
      effectId: 'effect-1',
      dispatchAttempt: 3,
      dispatchPhase: 'responded',
    }),
  ]

  it('accepts every valid state combination in both validators', () => {
    for (const sample of valid) assertParity(target, SESSION_ID, 'ToolCallState', sample, true)
  })

  it('rejects every impossible combination in both validators', () => {
    for (const sample of invalid) assertParity(target, SESSION_ID, 'ToolCallState', sample, false)
  })
})

function runParity(
  label: string,
  scope: string,
  targets: Record<string, ParityTarget>,
  samples: Record<string, Sample>,
) {
  describe(`${label}: ajv ↔ TypeBox parity per $def`, () => {
    for (const [name, target] of Object.entries(targets)) {
      const sample = samples[name]
      it(`${name} has a registered sample`, () => {
        expect(sample, `${label}#/$defs/${name} has no registered comparison sample`).toBeDefined()
      })
      if (!sample) continue
      // A sample whose `invalid` list is empty satisfies every coverage guard in this file while
      // pinning nothing at all: a valid-only sample agrees with both validators for any schema down
      // to `true`, so an entry could be fully registered, fully compared, and still assert nothing
      // about the constraints the generator is supposed to preserve. One negative is the floor.
      it(`${name} has at least one negative sample`, () => {
        expect(
          sample.invalid.length,
          `${label}#/$defs/${name} registers no invalid sample, so nothing about it is pinned`,
        ).toBeGreaterThan(0)
      })
      // KNOWN_DIFFS is resolved at collection time — matchDiff is called once here — so whether an
      // entry is consumed is settled before any it runs, and the zombie-entry guard at the end does
      // not depend on test execution order.
      matchDiff(scope, name, sample.valid)
      for (const bad of sample.invalid) matchDiff(scope, name, bad)

      it(`${name}: valid sample — ajv and TypeBox agree (${sample.note})`, () => {
        assertParity(target, scope, name, sample.valid, true)
      })
      sample.invalid.forEach((bad, i) => {
        it(`${name}: invalid[${i}] ${preview(bad)} — ajv and TypeBox agree`, () => {
          assertParity(target, scope, name, bad, false)
        })
      })
    }
  })
}

function fromSchemaDefs(fileId: string, defs: Record<string, TSchema>): Record<string, ParityTarget> {
  const out: Record<string, ParityTarget> = {}
  for (const [name, schema] of Object.entries(defs)) out[name] = { check: ajvDef(fileId, name), schema }
  return out
}

function fromFormatDefs(): Record<string, ParityTarget> {
  const out: Record<string, ParityTarget> = {}
  for (const [name, schema] of Object.entries(FORMAT_DEFS)) {
    const check = FORMAT_AJV[name]
    if (!check) throw new Error(`no ajv checker registered for format target ${name}`)
    out[name] = { check, schema }
  }
  return out
}

// The self-owned schema documents, as (file name, parsed document, ajv $id, sample table) tuples.
// The sample table is part of the tuple rather than looked up by $id so that a document physically
// cannot be registered without one; the $defs table is reached through DEFS_BY_FILE, and the drift
// guards at the end of the file compare all of it in both directions and check that this list itself
// matches what is on disk.
const presetFixtures = loadJsonl(`${pkgRoot}fixtures/configs/preset.jsonl`) as Array<
  FixtureRow & { kind: string }
>
describe('preset consumer spellings: positive fixture parity', () => {
  it.each(presetFixtures.filter((row) => row.kind === 'valid'))('$id', (row) => {
    expect(ajvDef(PRESET_ID, 'PresetDoc')(row.payload)).toBe(true)
    expect(Value.Check(PresetGen.PresetDoc, row.payload)).toBe(true)
  })
})
const PRESET_DEFS: Record<string, TSchema> = {
  PresetDoc: PresetGen.PresetDoc,
  RouteTable: PresetGen.RouteTable,
  RouteTarget: PresetGen.RouteTarget,
  HookEvent: PresetGen.HookEvent,
}
const PRESET_SAMPLES: Record<string, Sample> = {
  PresetDoc: {
    valid: byId(presetFixtures, 'preset-full'),
    invalid: presetFixtures.filter((r) => r.kind === 'invalid').map((r) => r.payload),
    note: 'language-neutral config fixtures, including every protected operation',
  },
  RouteTable: MODEL_SAMPLES.RouteTable as Sample,
  RouteTarget: MODEL_SAMPLES.RouteTarget as Sample,
  HookEvent: HOOKS_SAMPLES.HookEvent as Sample,
}

const task20Fixtures = loadJsonl(`${pkgRoot}fixtures/configs/task20.jsonl`) as Array<
  FixtureRow & { kind: string; name: string }
>
const task20Helpers = JSON.parse(readFileSync(`${pkgRoot}test/task20-samples.json`, 'utf8')) as Record<
  string,
  unknown
>
function configSample(name: string): Sample {
  return {
    valid: byId(task20Fixtures, `${name}-full`),
    invalid: task20Fixtures.filter((r) => r.name === name && r.kind === 'invalid').map((r) => r.payload),
    note: 'Task20 language-neutral configuration boundaries',
  }
}
function helperSample(name: string, invalid: unknown[]): Sample {
  return {
    valid: task20Helpers[name],
    invalid,
    note: 'Task20 helper-specific lower, upper, and closed-object boundaries',
  }
}
const PROFILE_SAMPLES: Record<string, Sample> = {
  ApprovalMode: {
    valid: 'manual',
    invalid: ['automatic', '', null],
    note: 'approval mode is the closed manual/smart/off policy vocabulary',
  },
  ApprovalProfile: {
    valid: { mode: 'smart' },
    invalid: [{}, { mode: 'automatic' }, { mode: 'manual', extra: true }],
    note: 'the resolved approval policy is explicit and closed',
  },
  ComputerUseAppIdentity: {
    valid: {
      platform: 'win32',
      executablePath: 'C:\\Program Files\\Acme\\Acme.exe',
      publisherSha256: 'a'.repeat(64),
    },
    invalid: [
      { platform: 'win32', executablePath: 'C:\\Acme.exe', publisherSha256: 'A'.repeat(64) },
      { platform: 'darwin', bundleId: 'com.acme.app', teamId: 'ACME', signatureSha256: 'short' },
      { platform: 'linux', desktopId: 'acme.desktop', executablePath: '/usr/bin/acme' },
    ],
    note: 'application authority uses one closed platform-specific stable identity',
  },
  ComputerUseCapturePolicy: {
    valid: { maxImageDimension: 1456, maxBytesPerImage: 4 * 1024 * 1024 },
    invalid: [{ maxImageDimension: 1457 }, { maxCapturesPerHour: 0 }, { extra: true }],
    note: 'capture policy is closed and cannot exceed the reviewed hard maxima',
  },
  ComputerUseRetentionPolicy: {
    valid: { maxRecentPerSession: 100, ttlMs: 86_400_000 },
    invalid: [{ maxRecentPerSession: 101 }, { globalMaxBytes: 1024 }, { extra: true }],
    note: 'retention policy is closed and bounded by the reviewed maxima',
  },
  ComputerUseProfile: {
    valid: { enabled: false, appAccess: 'all', appAllowlist: [], capture: {}, retention: {} },
    invalid: [{ enabled: 'yes' }, { appAccess: 'some' }, { appAllowlist: [{}] }, { extra: true }],
    note: 'trusted profiles may declare the closed Computer Use policy',
  },
  ComputerUseRestriction: {
    valid: { enabled: false, appAccess: 'allowlist', appAllowlist: [], capture: { maxImageDimension: 1024 } },
    invalid: [
      { enabled: true },
      { appAccess: 'all' },
      { capture: { maxImageDimension: 1457 } },
      { extra: true },
    ],
    note: 'workspace Computer Use fragments can only express schema-level restrictions',
  },
  ResolvedComputerUseProfile: {
    valid: {
      enabled: false,
      appAccess: 'allowlist',
      appAllowlist: [],
      capture: {
        allowFullDesktop: false,
        maxImageDimension: 1456,
        maxBytesPerImage: 4 * 1024 * 1024,
        maxImagesPerResult: 1,
        maxImagesPerMutationResult: 2,
        maxImagesPerModelRequest: 4,
        maxCapturesPerHour: 120,
      },
      retention: {
        maxRecentPerSession: 100,
        ttlMs: 86_400_000,
        gcIntervalMs: 3_600_000,
        maxExtendedTtlMs: 604_800_000,
        globalMaxBytes: 1024 * 1024 * 1024,
      },
    },
    invalid: [{}, { enabled: false, appAccess: 'allowlist', appAllowlist: [], capture: {}, retention: {} }],
    note: 'resolved profiles materialize every Computer Use default',
  },
  CommandHookGrant: {
    valid: { source: 'workspace', configDigest: `sha256-${'a'.repeat(64)}`, workspaceRoot: 'C:/工作区' },
    invalid: [
      {},
      { source: 'other', configDigest: `sha256-${'a'.repeat(64)}`, workspaceRoot: '/work' },
      { source: 'data', configDigest: 'sha256-invalid', workspaceRoot: '/work' },
      { source: 'workspace', configDigest: `sha256-${'a'.repeat(64)}`, workspaceRoot: 'relative' },
      { source: 'workspace', configDigest: `sha256-${'a'.repeat(64)}`, workspaceRoot: 'C:relative' },
      { source: 'data', configDigest: `sha256-${'a'.repeat(64)}`, workspaceRoot: '/work', extra: true },
    ],
    note: 'Explicit trusted Hook grant requires source, digest and an absolute workspace',
  },
  CommandHooksPolicy: {
    valid: {
      trustedUnconfined: [
        { source: 'data', configDigest: `sha256-${'b'.repeat(64)}`, workspaceRoot: '/work' },
      ],
    },
    invalid: [
      {},
      { trustedUnconfined: true },
      { trustedUnconfined: [{}] },
      { trustedUnconfined: [], extra: true },
      {
        trustedUnconfined: Array.from({ length: 2 }, () => ({
          source: 'data',
          configDigest: `sha256-${'b'.repeat(64)}`,
          workspaceRoot: '/work',
        })),
      },
      {
        trustedUnconfined: Array.from({ length: 129 }, (_, i) => ({
          source: 'data',
          configDigest: `sha256-${'b'.repeat(64)}`,
          workspaceRoot: `/work/${i}`,
        })),
      },
    ],
    note: 'Trusted Hook policy is a closed object with at most 128 distinct grants',
  },
  ExtensionIsolationPolicy: {
    valid: { backend: 'seatbelt', extensions: { 'acme/plugin': 'required' } },
    invalid: [
      { extensions: { '*': 'required' } },
      { backend: 'other', extensions: {} },
      { extensions: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`acme/p${i}`, 'required'])) },
    ],
    note: 'R0 exact IDs, backend and bounded map',
  },
  ExtensionIsolationRequest: {
    valid: { extensions: { 'acme/plugin': 'preferred' } },
    invalid: [
      { backend: 'auto', extensions: {} },
      { extensions: { 'acme/plugin': 'off' } },
      { extensions: { 'acme/*': 'required' } },
    ],
    note: 'R0 workspace request cannot weaken or select backend',
  },
  Capability: helperSample('Capability', ['', 'A', 'a'.repeat(65), 'tools/invoke']),
  SeamName: helperSample('SeamName', ['provider', 'unknown']),
  PackageRef: helperSample('PackageRef', [
    { id: '@agnes/base' },
    { id: 'x', source: 'builtin', tombstone: 'true' },
    { id: 'x', source: 'builtin', extra: true },
  ]),
  SecretRef: helperSample('SecretRef', ['RAW_FIXTURE', 'secret://ns/a/b', 'secret://../name']),
  Transport: helperSample('Transport', [
    { kind: 'tcp' },
    { kind: 'unix', auth: { sourceAuthSecrets: ['secret://a/b', 'secret://a/c', 'secret://a/d'] } },
    { kind: 'stdio', auth: { rotationGraceMs: -1 } },
    { kind: 'ws-tls', tls: { key: 'RAW_FIXTURE' } },
  ]),
  Policy: helperSample('Policy', [
    { workspacePackages: 'allow' },
    { capabilityCeiling: ['INVALID'] },
    { extra: true },
  ]),
  ReconcilePoint: {
    valid: 'immediate',
    invalid: ['later', '', null],
    note: 'Task 7 reconcile point is a closed immediate/turn/step vocabulary',
  },
  ReconcilePolicy: {
    valid: { point: 'turn', maxWaitMs: 250 },
    invalid: [
      { point: 'immediate', maxWaitMs: 1 },
      { point: 'turn', maxWaitMs: -1 },
      { point: 'step', maxWaitMs: 1.5 },
      { point: 'later' },
      { point: 'turn', extra: true },
    ],
    note: 'Task 7 maxWaitMs is optional and only applies to turn or step',
  },
  RuntimeProfileManifest: configSample('RuntimeProfileManifest'),
  ProfileFragment: configSample('ProfileFragment'),
  ResolvedProfile: configSample('ResolvedProfile'),
  ManagedPolicy: configSample('ManagedPolicy'),
  RouteDecl: MODEL_SAMPLES.RouteDecl as Sample,
  ModelRecord: MODEL_SAMPLES.ModelRecord as Sample,
  ModelCost: MODEL_SAMPLES.ModelCost as Sample,
  DecodeRule: MODEL_SAMPLES.DecodeRule as Sample,
  SlotName: MODEL_SAMPLES.SlotName as Sample,
  JsonValue: SESSION_SAMPLES.JsonValue as Sample,
}
const EXTENSION_SAMPLES: Record<string, Sample> = {
  Capabilities: helperSample('Capabilities', [
    { events: ['x'] },
    { tools: { prefix: 'BAD' } },
    { hooks: ['invalid'] },
    { slots: ['invalid'] },
    { resources: ['exec'] },
    { network: { hosts: ['https://x'] } },
    { artifacts: 'yes' },
    { subagent: 'yes' },
    { extra: true },
  ]),
  SkinTokenValue: {
    valid: '#fdfeff',
    invalid: ['', 'url(http://x)', '#fff;color:red', '#fff}', 'a'.repeat(257), '@import x'],
    note: 'Skin token value: non-empty, bounded, no url()/@/brace/semicolon',
  },
  SkinContribution: {
    valid: { id: 'midnight', name: '午夜', css: './skins/midnight/skin.css' },
    invalid: [
      {},
      { id: 'light', name: 'x', css: './a.css' },
      { id: 'a', name: '', css: './a.css' },
      { id: 'a', name: 'x', css: 'a.css' },
      { id: 'a', name: 'x', css: './a.css', extra: true },
      { id: 'a', name: 'x', css: './a.css', tokens: { '--t': { light: '#fff' } } },
      { id: 'a', name: 'x', css: './a.css', tokens: { '--t': { light: '#fff', dark: '#000', extra: 1 } } },
      { id: 'a', name: 'x', css: './a.css', tokens: { '--t': { light: 'url(http://x)', dark: '#000' } } },
      { id: 'a', name: 'x', css: './a.css', tokens: { '--t': { light: '#fff;color:red', dark: '#000' } } },
    ],
    note: 'Skin contribution: reserved id, closed object, both palette modes, and value charset',
  },
  ClientContribution: {
    valid: { entry: 'dist/client/index.js', styles: ['dist/client/index.css'], slots: ['workbench.panel'] },
    invalid: [
      {},
      { entry: '' },
      { entry: 'dist/client/index.js', extra: true },
      { entry: 'dist/client/index.js', styles: ['x'], services: 'not-an-array' },
    ],
    note: 'Client contribution: entry required, closed object, reserved fields stay arrays (P1a)',
  },
  ExtensionManifest: configSample('ExtensionManifest'),
  HookEvent: HOOKS_SAMPLES.HookEvent as Sample,
  UiSlotName: SLOTS_SAMPLES.UiSlotName as Sample,
  SeamName: PROFILE_SAMPLES.SeamName as Sample,
}
const LOCK_SAMPLES: Record<string, Sample> = {
  PackageLock: helperSample('PackageLock', [
    {},
    { ...(task20Helpers.PackageLock as Json), trust: 'untrusted' },
    { ...(task20Helpers.PackageLock as Json), integrity: 'md5-bad' },
  ]),
  Lockfile: configSample('Lockfile'),
  Capabilities: EXTENSION_SAMPLES.Capabilities as Sample,
  HookEvent: HOOKS_SAMPLES.HookEvent as Sample,
  UiSlotName: SLOTS_SAMPLES.UiSlotName as Sample,
  SeamName: PROFILE_SAMPLES.SeamName as Sample,
  Capability: PROFILE_SAMPLES.Capability as Sample,
}
const DEPLOY_SAMPLES: Record<string, Sample> = { DeployManifest: configSample('DeployManifest') }
const JOBS_SAMPLES: Record<string, Sample> = {
  JsonValue: SESSION_SAMPLES.JsonValue as Sample,
  ContentBlock: SESSION_SAMPLES.ContentBlock as Sample,
  Schedule: helperSample('Schedule', [
    { kind: 'every', everyMs: 999 },
    { kind: 'at', at: -1 },
    { kind: 'at', at: '2026-09-09T00:00:00Z' },
    { kind: 'cron', expr: 'x'.repeat(129) },
    { kind: 'once', extra: true },
  ]),
  JobSpec: configSample('JobSpec'),
  JobStatus: configSample('JobStatus'),
}
const ProfileDefs: Record<string, TSchema> = {
  ApprovalMode: ProfileGen.ApprovalMode,
  ApprovalProfile: ProfileGen.ApprovalProfile,
  CommandHookGrant: ProfileGen.CommandHookGrant,
  CommandHooksPolicy: ProfileGen.CommandHooksPolicy,
  ComputerUseAppIdentity: ProfileGen.ComputerUseAppIdentity,
  ComputerUseCapturePolicy: ProfileGen.ComputerUseCapturePolicy,
  ComputerUseRetentionPolicy: ProfileGen.ComputerUseRetentionPolicy,
  ComputerUseProfile: ProfileGen.ComputerUseProfile,
  ComputerUseRestriction: ProfileGen.ComputerUseRestriction,
  ResolvedComputerUseProfile: ProfileGen.ResolvedComputerUseProfile,
  ExtensionIsolationPolicy: ProfileGen.ExtensionIsolationPolicy,
  ExtensionIsolationRequest: ProfileGen.ExtensionIsolationRequest,
  Capability: ProfileGen.Capability,
  SeamName: ProfileGen.SeamName,
  PackageRef: ProfileGen.PackageRef,
  SecretRef: ProfileGen.SecretRef,
  Transport: ProfileGen.Transport,
  Policy: ProfileGen.Policy,
  ReconcilePoint: ProfileGen.ReconcilePoint,
  ReconcilePolicy: ProfileGen.ReconcilePolicy,
  RuntimeProfileManifest: ProfileGen.RuntimeProfileManifest,
  ProfileFragment: ProfileGen.ProfileFragment,
  ManagedPolicy: ProfileGen.ManagedPolicy,
  ResolvedProfile: ProfileGen.ResolvedProfile,
  RouteDecl: ProfileGen.RouteDecl,
  DecodeRule: ProfileGen.DecodeRule,
  JsonValue: ProfileGen.JsonValue,
  ModelCost: ProfileGen.ModelCost,
  ModelRecord: ProfileGen.ModelRecord,
  SlotName: ProfileGen.SlotName,
}
const LockfileDefs: Record<string, TSchema> = {
  PackageLock: LockfileGen.PackageLock,
  Lockfile: LockfileGen.Lockfile,
  Capabilities: LockfileGen.Capabilities,
  HookEvent: LockfileGen.HookEvent,
  UiSlotName: LockfileGen.UiSlotName,
  SeamName: LockfileGen.SeamName,
  Capability: LockfileGen.Capability,
}
const ExtensionManifestDefs: Record<string, TSchema> = {
  Capabilities: ExtensionManifestGen.Capabilities,
  ClientContribution: ExtensionManifestGen.ClientContribution,
  SkinContribution: ExtensionManifestGen.SkinContribution,
  SkinTokenValue: ExtensionManifestGen.SkinTokenValue,
  ExtensionManifest: ExtensionManifestGen.ExtensionManifest,
  HookEvent: ExtensionManifestGen.HookEvent,
  UiSlotName: ExtensionManifestGen.UiSlotName,
  SeamName: ExtensionManifestGen.SeamName,
}
const DeployManifestDefs: Record<string, TSchema> = { DeployManifest: DeployManifestGen.DeployManifest }
const JobsDefs: Record<string, TSchema> = {
  JsonValue: JobsGen.JsonValue,
  Schedule: JobsGen.Schedule,
  JobSpec: JobsGen.JobSpec,
  JobStatus: JobsGen.JobStatus,
  ContentBlock: JobsGen.ContentBlock,
}

const task21Samples = JSON.parse(readFileSync(`${pkgRoot}test/task21-samples.json`, 'utf8')) as Record<
  string,
  Record<string, Sample>
>
function task21Group(name: string): Record<string, Sample> {
  const group = task21Samples[name]
  if (!group || typeof group !== 'object' || Array.isArray(group))
    throw new Error(`missing Task21 sample group: ${name}`)
  return group
}
const TASK21_SAMPLES = {
  authz: task21Group('authz'),
  channel: task21Group('channel'),
  bridge: task21Group('bridge'),
}
const AuthzDefs: Record<string, TSchema> = {
  Actor: AuthzGen.Actor,
  Target: AuthzGen.Target,
  Action: AuthzGen.Action,
  RowScope: AuthzGen.RowScope,
  Decision: AuthzGen.Decision,
}
const ChannelDefs: Record<string, TSchema> = {
  Credential: ChannelGen.Credential,
  ApprovalAction: ChannelGen.ApprovalAction,
  DirectoryEntry: ChannelGen.DirectoryEntry,
  ChannelCapabilities: ChannelGen.ChannelCapabilities,
  ChannelManifest: ChannelGen.ChannelManifest,
  JwtCredential: ChannelGen.JwtCredential,
  SourceAuthCredential: ChannelGen.SourceAuthCredential,
  PortalIdentityCredential: ChannelGen.PortalIdentityCredential,
  LocalCredential: ChannelGen.LocalCredential,
  SurfaceAuthCredential: ChannelGen.SurfaceAuthCredential,
  Auth: ChannelGen.Auth,
  ChannelCredential: ChannelGen.ChannelCredential,
}
const BridgeDefs: Record<string, TSchema> = {
  JsonValue: BridgeGen.JsonValue,
  BridgeMethod: BridgeGen.BridgeMethod,
  BridgeRequest: BridgeGen.BridgeRequest,
  BridgeResponse: BridgeGen.BridgeResponse,
  ToolsInvokeParams: BridgeGen.ToolsInvokeParams,
}
const workerIdentity = {
  treeHash: 'a'.repeat(64),
  resourceRevision: 'b'.repeat(64),
  compositeRevision: 'c'.repeat(64),
}
const workerArtifact = {
  encoding: 'base64',
  canonicalBase64: 'e30=',
  digest: `sha256-${'d'.repeat(64)}`,
  identity: workerIdentity,
}
const WorkerDefs: Record<string, TSchema> = {
  WorkerGeneration: WorkerGen.WorkerGeneration,
  RuntimeTargetIdentity: WorkerGen.RuntimeTargetIdentity,
  RuntimeTargetArtifact: WorkerGen.RuntimeTargetArtifact,
  RuntimeStaleFrame: WorkerGen.RuntimeStaleFrame,
  RuntimeConvergenceRow: WorkerGen.RuntimeConvergenceRow,
  RuntimeConvergenceReport: WorkerGen.RuntimeConvergenceReport,
  RuntimeBootReadyFrame: WorkerGen.RuntimeBootReadyFrame,
  RuntimeConvergedFrame: WorkerGen.RuntimeConvergedFrame,
  RuntimeApplyFailedFrame: WorkerGen.RuntimeApplyFailedFrame,
}
const WorkerSamples: Record<string, Sample> = {
  WorkerGeneration: {
    valid: 1,
    invalid: [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, '1'],
    note: 'hand-written safe-integer boundaries for the daemon-to-worker process generation',
  },
  RuntimeTargetIdentity: {
    valid: workerIdentity,
    invalid: [
      { ...workerIdentity, treeHash: rep(63) },
      { ...workerIdentity, resourceRevision: rep(65) },
      { treeHash: workerIdentity.treeHash, resourceRevision: workerIdentity.resourceRevision },
      { ...workerIdentity, extra: true },
    ],
    note: 'all three complete target identities are required lower-case SHA-256 values',
  },
  RuntimeTargetArtifact: {
    valid: workerArtifact,
    invalid: [
      { ...workerArtifact, encoding: 'utf8' },
      { ...workerArtifact, canonicalBase64: '' },
      { ...workerArtifact, canonicalBase64: 'e30' },
      // 16,777,216 is divisible by four; the next representable canonical base64 length is four over.
      { ...workerArtifact, canonicalBase64: 'A'.repeat(16_777_220) },
      { ...workerArtifact, digest: `sha256-${rep(63)}` },
      { ...workerArtifact, digest: rep64 },
      { ...workerArtifact, identity: { ...workerIdentity, compositeRevision: rep(63) } },
      { ...workerArtifact, extra: true },
    ],
    note: 'bounded canonical standard base64, prefixed SHA-256 digest and complete identity',
  },
  RuntimeStaleFrame: {
    valid: { type: 'runtime.stale', artifact: workerArtifact },
    invalid: [
      { type: 'runtime.stale' },
      { type: 'runtime.stale', target: workerArtifact },
      { type: 'runtime.stale', tree: {}, resource: {} },
      { type: 'runtime.stale', resourceRevision: workerIdentity.resourceRevision },
      { type: 'runtime.other', artifact: workerArtifact },
      { type: 'runtime.stale', artifact: workerArtifact, extra: true },
    ],
    note: 'runtime.stale carries exactly one complete artifact and no split or lookup payload',
  },
  RuntimeConvergenceRow: {
    valid: { id: 'ext:demo', state: 'active' },
    invalid: [{ id: '', state: 'active' }, { id: 'ext:demo', state: 'unknown' }, { state: 'active' }],
    note: 'one complete row id with a closed six-state report value',
  },
  RuntimeConvergenceReport: {
    valid: { hash: rep64, ok: true, rows: [{ id: 'ext:demo', state: 'active' }] },
    invalid: [
      { hash: rep(63), ok: true, rows: [] },
      { hash: rep64, rows: [] },
      { hash: rep64, ok: true, rows: [{ id: 'ext:demo' }] },
    ],
    note: 'qualified report is hash plus closed row states',
  },
  RuntimeBootReadyFrame: {
    valid: {
      type: 'runtime.boot_ready',
      workerKind: 'session',
      workerKey: '@shared',
      generation: 1,
      digest: workerArtifact.digest,
      identity: workerIdentity,
      source: 'lastGood',
    },
    invalid: [
      {
        type: 'runtime.boot_ready',
        workerKind: 'session',
        workerKey: '@shared',
        generation: 1,
        digest: workerArtifact.digest,
        identity: workerIdentity,
        source: 'probe',
      },
      {
        type: 'runtime.boot_ready',
        workerKind: 'probe',
        workerKey: '@shared',
        generation: 1,
        digest: workerArtifact.digest,
        identity: workerIdentity,
        source: 'bootstrap',
      },
    ],
    note: 'boot_ready is session/@shared plus lastGood or bootstrap of the applied artifact',
  },
  RuntimeConvergedFrame: {
    valid: {
      type: 'runtime.converged',
      workerKind: 'session',
      workerKey: '@shared',
      generation: 1,
      digest: workerArtifact.digest,
      identity: workerIdentity,
      report: { hash: workerIdentity.treeHash, ok: true, rows: [] },
    },
    invalid: [
      {
        type: 'runtime.converged',
        workerKind: 'session',
        workerKey: '@shared',
        generation: 1,
        digest: workerArtifact.digest,
        identity: workerIdentity,
      },
    ],
    note: 'converged carries the qualified complete report for the current desired digest',
  },
  RuntimeApplyFailedFrame: {
    valid: {
      type: 'runtime.apply_failed',
      workerKind: 'session',
      workerKey: '@shared',
      generation: 1,
      digest: workerArtifact.digest,
      identity: workerIdentity,
      phase: 'health',
      message: 'unhealthy',
    },
    invalid: [
      {
        type: 'runtime.apply_failed',
        workerKind: 'session',
        workerKey: '@shared',
        generation: 1,
        digest: workerArtifact.digest,
        identity: workerIdentity,
        phase: 'health',
      },
    ],
    note: 'apply_failed is qualified by generation/digest/identity and does not carry lastGood',
  },
}
const bridgeJsonSample = TASK21_SAMPLES.bridge.JsonValue
if (!bridgeJsonSample) throw new Error('missing bridge JsonValue sample')
bridgeJsonSample.invalid = [undefined, () => 1, Symbol('invalid-json')]
AGNES_SAMPLES.JwtCredential = TASK21_SAMPLES.channel.JwtCredential as Sample
AGNES_SAMPLES.SourceAuthCredential = TASK21_SAMPLES.channel.SourceAuthCredential as Sample
AGNES_SAMPLES.PortalIdentityCredential = TASK21_SAMPLES.channel.PortalIdentityCredential as Sample
AGNES_SAMPLES.LocalCredential = TASK21_SAMPLES.channel.LocalCredential as Sample
AGNES_SAMPLES.SurfaceAuthCredential = TASK21_SAMPLES.channel.SurfaceAuthCredential as Sample

const projectionRows = loadJsonl(`${pkgRoot}fixtures/projection/projection.jsonl`) as (FixtureRow & {
  name: string
  kind: string
})[]
const ProjectionSamples: Record<string, Sample> = Object.fromEntries(
  ['ProjectionCapability', 'ProjectionReadResult'].map((name) => [
    name,
    {
      valid: projectionRows.find((row) => row.name === name && row.kind === 'valid')?.payload,
      invalid: projectionRows
        .filter((row) => row.name === name && row.kind === 'invalid')
        .map((row) => row.payload),
      note: 'P1 checked-in boundary fixtures',
    },
  ]),
)

const serviceRows = loadJsonl(`${pkgRoot}fixtures/extension-service/service.jsonl`) as (FixtureRow & {
  name: string
  definition?: string
  kind: string
})[]
const ServiceSamples: Record<string, Sample> = Object.fromEntries(
  [
    'ServiceCapability',
    'ExtensionCallParams',
    'ExtensionCallResult',
    'ExtensionAckParams',
    'ExtensionCallError',
  ].map((name) => [
    name,
    {
      valid: serviceRows.find((row) => (row.definition ?? row.name) === name && row.kind === 'valid')
        ?.payload,
      invalid: serviceRows
        .filter((row) => (row.definition ?? row.name) === name && row.kind === 'invalid')
        .map((row) => row.payload),
      note: 'S1 boundary fixtures',
    },
  ]),
)
for (const name of ['ExtensionCallParams', 'ExtensionCallResult', 'ExtensionAckParams', 'ExtensionCallError'])
  AGNES_SAMPLES[name] = ServiceSamples[name] as Sample

function surfaceSamples(): Record<string, Sample> {
  const rows = loadJsonl(`${pkgRoot}fixtures/surface/surface.jsonl`) as (FixtureRow & {
    name: string
    kind: string
  })[]
  return Object.fromEntries(
    Object.keys(SurfaceDoc.$defs as Json).map((name) => [
      name,
      {
        valid: rows.find((row) => row.name === name && row.kind === 'valid')?.payload,
        invalid: rows.filter((row) => row.name === name && row.kind === 'invalid').map((row) => row.payload),
        note: 'F1 checked-in artifact and instance boundary fixtures',
      },
    ]),
  )
}

const PackageAdminRows = loadJsonl(`${pkgRoot}fixtures/package-admin/package-admin.jsonl`) as (FixtureRow & {
  name: string
  kind: string
  target: string
  side?: 'params' | 'result'
})[]
const PackageAdminSamples: Record<string, Sample> = Object.fromEntries(
  Object.keys(PackageAdminDoc.$defs as Json).map((name) => [
    name,
    {
      valid: PackageAdminRows.find(
        (row) => row.target === 'config' && row.name === name && row.kind === 'valid',
      )?.payload,
      invalid: PackageAdminRows.filter(
        (row) => row.target === 'config' && row.name === name && row.kind === 'invalid',
      ).map((row) => row.payload),
      note: 'PM4 checked-in management and supply-chain boundary fixtures',
    },
  ]),
)
AGNES_SAMPLES.PackageActivationTrust = PackageAdminSamples.PackageActivationTrust as Sample
AGNES_SAMPLES.PackageActivationRequest = PackageAdminSamples.PackageActivationRequest as Sample
AGNES_SAMPLES.PackageRollbackTarget = PackageAdminSamples.PackageRollbackTarget as Sample
AGNES_SAMPLES.PackageAdminContext = PackageAdminSamples.PackageAdminContext as Sample
AGNES_SAMPLES.PackageCatalogDescriptor = PackageAdminSamples.PackageCatalogDescriptor as Sample
AGNES_SAMPLES.PackageCatalogGetParams = PackageAdminSamples.PackageCatalogGetParams as Sample
AGNES_SAMPLES.PackageCatalogListParams = PackageAdminSamples.PackageCatalogListParams as Sample
AGNES_SAMPLES.PackageCatalogPage = PackageAdminSamples.PackageCatalogPage as Sample
AGNES_SAMPLES.PackageDisableParams = PackageAdminSamples.PackageDisableParams as Sample
AGNES_SAMPLES.PackageEnableParams = PackageAdminSamples.PackageEnableParams as Sample
AGNES_SAMPLES.PackageInspectParams = PackageAdminSamples.PackageInspectParams as Sample
AGNES_SAMPLES.PackageInstallParams = PackageAdminSamples.PackageInstallParams as Sample
AGNES_SAMPLES.PackageListParams = PackageAdminSamples.PackageListParams as Sample
AGNES_SAMPLES.PackageListResult = PackageAdminSamples.PackageListResult as Sample
AGNES_SAMPLES.SkinReadParams = PackageAdminSamples.SkinReadParams as Sample
AGNES_SAMPLES.ClientModuleReadParams = PackageAdminSamples.ClientModuleReadParams as Sample
AGNES_SAMPLES.PackageOperation = PackageAdminSamples.PackageOperation as Sample
AGNES_SAMPLES.PackageOperationCancelParams = PackageAdminSamples.PackageOperationCancelParams as Sample
AGNES_SAMPLES.PackageOperationGetParams = PackageAdminSamples.PackageOperationGetParams as Sample
AGNES_SAMPLES.PackageOperationReceipt = PackageAdminSamples.PackageOperationReceipt as Sample
AGNES_SAMPLES.PackagePinsInspectParams = PackageAdminSamples.PackagePinsInspectParams as Sample
AGNES_SAMPLES.PackagePinsInspectResult = PackageAdminSamples.PackagePinsInspectResult as Sample
AGNES_SAMPLES.PackagePinsReleaseParams = PackageAdminSamples.PackagePinsReleaseParams as Sample
AGNES_SAMPLES.PackagePinsReleaseResult = PackageAdminSamples.PackagePinsReleaseResult as Sample
AGNES_SAMPLES.PackageRemoveParams = PackageAdminSamples.PackageRemoveParams as Sample
AGNES_SAMPLES.PackageRollbackParams = PackageAdminSamples.PackageRollbackParams as Sample
AGNES_SAMPLES.PackageTrustParams = PackageAdminSamples.PackageTrustParams as Sample
AGNES_SAMPLES.PackageUntrustParams = PackageAdminSamples.PackageUntrustParams as Sample
AGNES_SAMPLES.PackageTrustWorkspaceParams = PackageAdminSamples.PackageTrustWorkspaceParams as Sample
AGNES_SAMPLES.PackageTrustWorkspaceResult = PackageAdminSamples.PackageTrustWorkspaceResult as Sample
AGNES_SAMPLES.PackageUpdateParams = PackageAdminSamples.PackageUpdateParams as Sample
AGNES_SAMPLES.PluginTreeApplyParams = PackageAdminSamples.PluginTreeApplyParams as Sample
AGNES_SAMPLES.PluginTreeRollbackParams = PackageAdminSamples.PluginTreeRollbackParams as Sample
AGNES_SAMPLES.PluginTreeView = PackageAdminSamples.PluginTreeView as Sample
AGNES_SAMPLES.PluginTreeApplyResult = PackageAdminSamples.PluginTreeApplyResult as Sample
AGNES_SAMPLES.PluginTreeRollbackResult = PackageAdminSamples.PluginTreeRollbackResult as Sample

type ResourceControlSampleName = Exclude<
  keyof typeof ResourceControlGen,
  'ResourceControlSchema' | 'SecretRef' | 'JsonValue'
>
function resourceControlSamples(): Record<ResourceControlSampleName, Sample> {
  const ok = (valid: unknown, invalid: unknown[] = [null]): Sample => ({
    valid,
    invalid,
    note: 'resource-control strict schema',
  })
  const rev = 'a'.repeat(64)
  const profile = 'local'
  const command = { clientId: 'cli-1', commandId: 'cmd-1' }
  const skillId = `skill/workspace-agnes/${'b'.repeat(64)}`
  const sourceIdentity = { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 'b'.repeat(64) }
  const safeError = { code: 'CONNECTION_FAILED', message: 'Connection failed' }
  const receipt = { operationId: 'op-1', state: 'received' }
  const stdio = { kind: 'stdio', executable: 'npx', args: ['-y', '@example/mcp'] }
  const http = { kind: 'http', url: 'https://mcp.example.test/api' }
  const sse = { kind: 'sse', url: 'https://mcp.example.test/sse' }
  const reference = ['secret:', '/mcp/key'].join('/')
  const stdioBinding = { kind: 'stdio-env', env: { API_KEY: reference } }
  const httpBinding = { kind: 'http-header', headerName: 'x-api-key', credentialRef: reference }
  const oauthBinding = { kind: 'oauth', staticClientId: 'test-oauth-client' }
  const definition = {
    serverId: 'example',
    displayName: 'Example',
    transport: stdio,
    secretBinding: stdioBinding,
    toolPolicy: { allow: ['search'] },
  }
  const definitionSseValid = {
    serverId: 'example',
    displayName: 'Example',
    transport: sse,
    secretBinding: httpBinding,
    toolPolicy: { allow: ['search'] },
  }
  const definitionSseInvalid = {
    serverId: 'example',
    displayName: 'Example',
    transport: { kind: 'sse', url: 'ftp://mcp.example.test/sse' },
    secretBinding: httpBinding,
    toolPolicy: { allow: ['search'] },
  }
  // Composed check for the new 'oauth' secretBinding kind — pins that McpServerDefinitionInput's
  // http/sse-transport branch actually reaches the new McpOAuthSecretBinding $def through the oneOf
  // it was appended to, not just the standalone leaf def (see the mcp-sse-transport plan's Task 1
  // lesson: a new oneOf branch can validate in isolation yet still be dropped once composed).
  const definitionOAuthValid = {
    serverId: 'example',
    displayName: 'Example',
    transport: http,
    secretBinding: oauthBinding,
    toolPolicy: { allow: ['search'] },
  }
  const skill = {
    kind: 'skill',
    resourceId: skillId,
    name: 'example',
    description: 'Example skill',
    revision: rev,
    sourceIdentity,
    priority: 500,
    resolution: { winner: true, shadowed: [] },
    trust: 'trusted',
    desired: 'enabled',
    actual: 'ready',
    stale: false,
  }
  const mcp = {
    kind: 'mcp',
    resourceId: 'mcp/example',
    serverId: 'example',
    displayName: 'Example',
    revision: rev,
    definition,
    transportKind: 'stdio',
    secretBindingKind: 'stdio-env',
    trust: 'trusted',
    desired: 'enabled',
    actual: 'ready',
    source: 'managed',
  }
  const status = {
    serverId: 'example',
    connectionState: 'ready',
    observedRevision: rev,
    catalogRevision: rev,
    toolCount: 1,
    observedAt: '2026-09-14T00:00:00Z',
  }
  const tool = {
    name: 'search',
    description: 'Search',
    inputSchema: {
      type: 'object',
      title: 'Fetch',
      description: 'Parameters for fetching a URL.',
      properties: {
        marker: { type: 'string', format: 'uri', title: 'Marker' },
        nested: { type: 'array', items: { enum: [null, true, 2, 'text'] } },
      },
      required: ['marker'],
    },
  }
  const operation = {
    operationId: 'op-1',
    kind: 'mcp.test',
    state: 'succeeded',
    profile,
    target: 'mcp/example',
    revision: rev,
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:01Z',
    progress: 100,
    result: { toolCount: 1, catalogRevision: rev },
  }
  const serverAction = { profile, serverId: 'example', expectedRevision: rev, ...command }
  return {
    ResourcePermission: ok('mcp.manage'),
    ProfileId: ok(profile),
    ResourceId: ok(skillId),
    ServerId: ok('example'),
    Revision: ok(rev),
    CommandId: ok('cmd-1'),
    ClientId: ok('cli-1'),
    SourceScope: ok('workspace'),
    SkillRootKey: ok('workspace-agnes'),
    SkillRootStatus: ok({ rootKey: 'workspace-agnes', scope: 'workspace', state: 'empty' }, [
      { rootKey: 'workspace-agnes', scope: 'workspace', state: 'missing' },
    ]),
    SkillRootDiagnostic: ok({ code: 'invalid-frontmatter' }, [
      { code: 'ROOT_SCAN_FAILED' },
      { code: 'invalid-frontmatter', detail: 'extra' },
    ]),
    WorkspaceId: ok(rev, ['not-a-workspace-id']),
    SkillSourceIdentity: ok(sourceIdentity),
    SkillResolution: ok({ winner: true, shadowed: [] }),
    TrustState: ok('trusted'),
    DesiredState: ok('enabled'),
    ActualState: ok('ready'),
    SafeError: ok(safeError),
    SkillDescriptor: ok(skill),
    McpEnvName: ok('API_KEY', ['PATH']),
    McpStdioTransport: ok(stdio, [{ kind: 'stdio', executable: '/bin/sh', args: ['-c'] }]),
    McpHttpTransport: ok(http, [
      { kind: 'http', url: 'https://mcp.example.test/?token=plaintext' },
      { kind: 'http', url: 'ftp://127.0.0.1/mcp' },
    ]),
    McpSseTransport: ok(sse, [
      { kind: 'sse', url: 'https://mcp.example.test/?token=plaintext' },
      { kind: 'sse', url: 'ftp://127.0.0.1/sse' },
    ]),
    McpSecretBinding: ok(stdioBinding, [
      { kind: 'http-header', headerName: 'cookie', credentialRef: 'secret://mcp/key' },
    ]),
    McpStdioSecretBinding: ok(stdioBinding, [httpBinding]),
    McpHttpSecretBinding: ok(httpBinding, [stdioBinding]),
    McpOAuthSecretBinding: ok(oauthBinding, [
      { kind: 'oauth', staticClientId: 'test-oauth-client', extraField: 'nope' },
    ]),
    McpToolPolicy: ok({ allow: ['search'] }),
    McpServerDefinitionInput: ok(definitionSseValid, [
      { ...definition, secretBinding: httpBinding },
      definitionSseInvalid,
      { ...definitionOAuthValid, secretBinding: { ...oauthBinding, extraField: 'nope' } },
    ]),
    McpServerDescriptor: ok(mcp, [{ ...mcp, authorizationStatus: 'bogus-status' }]),
    McpStatus: ok(status),
    McpInputSchema: ok(tool.inputSchema, [
      { type: 'array', properties: {} },
      { type: 'object', properties: [] },
      { ...tool.inputSchema, title: () => undefined },
    ]),
    McpTool: ok(tool),
    McpToolCatalogPage: ok({ serverId: 'example', catalogRevision: rev, items: [tool] }),
    ResourceOperationReceipt: ok(receipt),
    ResourceOperation: ok(operation),
    ResourceDescriptor: ok(skill),
    ResourceListParams: ok({ profile, kind: 'skill' }, [
      { profile, kind: 'skill', path: '/tmp/evil' },
      { profile, kind: 'skill', cwd: '/tmp/evil' },
    ]),
    ResourceListResult: ok({ items: [skill, mcp] }),
    ResourceGetParams: ok({ profile, resourceId: skillId }),
    ResourceDesiredSetParams: ok({
      profile,
      resourceId: skillId,
      state: 'enabled',
      config: { kind: 'none' },
      ...command,
    }),
    ResourceOperationGetParams: ok({ profile, operationId: 'op-1' }),
    ResourceOperationCancelParams: ok({ profile, operationId: 'op-1', ...command }),
    SkillRefreshParams: ok({ profile, rootKey: 'workspace-agnes', ...command }, [
      { profile, ...command, path: '/tmp/evil' },
      { profile, ...command, cwd: '/tmp/evil' },
      { profile, ...command, workspaceId: 'not-hex' },
    ]),
    SkillRemoveParams: ok({ profile, resourceId: skillId, expectedRevision: rev, ...command }, [
      { profile, resourceId: skillId, expectedRevision: rev, ...command, path: '/tmp/evil' },
    ]),
    SkillPrioritySetParams: ok(
      {
        profile,
        resourceId: skillId,
        expectedRevision: rev,
        expectedPriority: 400,
        priority: 500,
        ...command,
      },
      [
        {
          profile,
          resourceId: skillId,
          expectedRevision: rev,
          expectedPriority: 400,
          priority: 501,
          ...command,
        },
      ],
    ),
    SkillTrustSetParams: ok(
      { profile, resourceId: skillId, expectedRevision: rev, trust: 'trusted', ...command },
      [{ profile, resourceId: 'mcp/example', expectedRevision: rev, trust: 'trusted', ...command }],
    ),
    McpServerListParams: ok({ profile, cursor: 'page-1' }),
    McpServerListResult: ok({ items: [mcp] }, [{ items: [skill] }]),
    McpServerGetParams: ok({ profile, serverId: 'example' }),
    McpServerCreateParams: ok({ profile, definition, ...command }),
    McpServerUpdateParams: ok({
      profile,
      serverId: 'example',
      expectedRevision: rev,
      definition,
      ...command,
    }),
    McpServerRemoveParams: ok(serverAction),
    McpTrustSetParams: ok({ ...serverAction, trust: 'trusted' }),
    McpServerTestParams: ok(serverAction),
    McpServerEnableParams: ok(serverAction),
    McpServerDisableParams: ok(serverAction),
    McpServerReconnectParams: ok(serverAction),
    McpToolsListParams: ok({ profile, serverId: 'example' }),
    McpOAuthStatusSetParams: ok({ profile, serverId: 'example', status: 'authorized' }, [
      { profile, serverId: 'example', status: 'pending' },
    ]),
    McpOAuthStatusResult: ok({ authorizationStatus: 'authorized' }, [
      { authorizationStatus: 'bogus-status' },
    ]),
  }
}

const ResourceControlSamples = resourceControlSamples()
const SELF_OWNED_DOCS: Array<[string, Json, string, Record<string, Sample>]> = [
  [
    'resource-control.json',
    ResourceControlDoc,
    'https://agnes.ai/schema/resource-control.json',
    ResourceControlSamples,
  ],
  ['package-admin.json', PackageAdminDoc, 'https://agnes.ai/schema/package-admin.json', PackageAdminSamples],
  ['surface.json', SurfaceDoc, 'https://agnes.ai/schema/surface.json', surfaceSamples()],
  ['extension-service.json', ServiceDoc, 'https://agnes.ai/schema/extension-service.json', ServiceSamples],
  ['projection.json', ProjectionDoc, 'https://agnes.ai/schema/projection.json', ProjectionSamples],
  ['session-v1.json', sessionSchemaDoc, SESSION_ID, SESSION_SAMPLES],
  ['agnes-v1.json', agnesSchemaDoc, AGNES_ID, AGNES_SAMPLES],
  ['model.json', modelSchemaDoc, MODEL_ID, MODEL_SAMPLES],
  ['tooldef.json', toolDefSchemaDoc, TOOLDEF_ID, TOOLDEF_SAMPLES],
  ['hooks.json', hooksSchemaDoc, HOOKS_ID, HOOKS_SAMPLES],
  ['slots.json', slotsSchemaDoc, SLOTS_ID, SLOTS_SAMPLES],
  ['preset.json', presetSchemaDoc, PRESET_ID, PRESET_SAMPLES],
  ['profile.json', ProfileDoc, 'https://agnes.ai/schema/profile.json', PROFILE_SAMPLES],
  ['lockfile.json', LockfileDoc, 'https://agnes.ai/schema/lockfile.json', LOCK_SAMPLES],
  [
    'extension-manifest.json',
    ExtensionManifestDoc,
    'https://agnes.ai/schema/extension-manifest.json',
    EXTENSION_SAMPLES,
  ],
  ['deploy-manifest.json', DeployManifestDoc, 'https://agnes.ai/schema/deploy-manifest.json', DEPLOY_SAMPLES],
  ['jobs.json', JobsDoc, 'https://agnes.ai/schema/jobs.json', JOBS_SAMPLES],
  ['authz.json', AuthzDoc, 'https://agnes.ai/schema/authz.json', TASK21_SAMPLES.authz],
  ['channel.json', ChannelDoc, 'https://agnes.ai/schema/channel.json', TASK21_SAMPLES.channel],
  ['bridge.json', BridgeDoc, 'https://agnes.ai/schema/bridge.json', TASK21_SAMPLES.bridge],
  ['worker.json', WorkerDoc, 'https://agnes.ai/schema/worker.json', WorkerSamples],
]

const DEFS_BY_FILE: Record<string, Record<string, TSchema>> = {
  'https://agnes.ai/schema/worker.json': WorkerDefs,
  'https://agnes.ai/schema/resource-control.json': {
    ActualState: ResourceControlGen.ActualState,
    ClientId: ResourceControlGen.ClientId,
    CommandId: ResourceControlGen.CommandId,
    DesiredState: ResourceControlGen.DesiredState,
    McpEnvName: ResourceControlGen.McpEnvName,
    McpHttpTransport: ResourceControlGen.McpHttpTransport,
    McpSseTransport: ResourceControlGen.McpSseTransport,
    McpHttpSecretBinding: ResourceControlGen.McpHttpSecretBinding,
    McpOAuthSecretBinding: ResourceControlGen.McpOAuthSecretBinding,
    McpSecretBinding: ResourceControlGen.McpSecretBinding,
    McpServerCreateParams: ResourceControlGen.McpServerCreateParams,
    McpServerDefinitionInput: ResourceControlGen.McpServerDefinitionInput,
    McpServerDescriptor: ResourceControlGen.McpServerDescriptor,
    McpServerListResult: ResourceControlGen.McpServerListResult,
    McpServerDisableParams: ResourceControlGen.McpServerDisableParams,
    McpServerEnableParams: ResourceControlGen.McpServerEnableParams,
    McpServerGetParams: ResourceControlGen.McpServerGetParams,
    McpServerListParams: ResourceControlGen.McpServerListParams,
    McpServerReconnectParams: ResourceControlGen.McpServerReconnectParams,
    McpServerRemoveParams: ResourceControlGen.McpServerRemoveParams,
    McpServerTestParams: ResourceControlGen.McpServerTestParams,
    McpServerUpdateParams: ResourceControlGen.McpServerUpdateParams,
    McpStatus: ResourceControlGen.McpStatus,
    McpStdioTransport: ResourceControlGen.McpStdioTransport,
    McpStdioSecretBinding: ResourceControlGen.McpStdioSecretBinding,
    McpInputSchema: ResourceControlGen.McpInputSchema,
    McpTool: ResourceControlGen.McpTool,
    McpToolCatalogPage: ResourceControlGen.McpToolCatalogPage,
    McpToolPolicy: ResourceControlGen.McpToolPolicy,
    McpToolsListParams: ResourceControlGen.McpToolsListParams,
    McpTrustSetParams: ResourceControlGen.McpTrustSetParams,
    McpOAuthStatusSetParams: ResourceControlGen.McpOAuthStatusSetParams,
    McpOAuthStatusResult: ResourceControlGen.McpOAuthStatusResult,
    ProfileId: ResourceControlGen.ProfileId,
    ResourceDescriptor: ResourceControlGen.ResourceDescriptor,
    ResourceDesiredSetParams: ResourceControlGen.ResourceDesiredSetParams,
    ResourceGetParams: ResourceControlGen.ResourceGetParams,
    ResourceId: ResourceControlGen.ResourceId,
    ResourceListParams: ResourceControlGen.ResourceListParams,
    ResourceListResult: ResourceControlGen.ResourceListResult,
    ResourceOperation: ResourceControlGen.ResourceOperation,
    ResourceOperationCancelParams: ResourceControlGen.ResourceOperationCancelParams,
    ResourceOperationGetParams: ResourceControlGen.ResourceOperationGetParams,
    ResourceOperationReceipt: ResourceControlGen.ResourceOperationReceipt,
    ResourcePermission: ResourceControlGen.ResourcePermission,
    Revision: ResourceControlGen.Revision,
    SafeError: ResourceControlGen.SafeError,
    ServerId: ResourceControlGen.ServerId,
    SkillDescriptor: ResourceControlGen.SkillDescriptor,
    SkillRefreshParams: ResourceControlGen.SkillRefreshParams,
    SkillResolution: ResourceControlGen.SkillResolution,
    SkillRootDiagnostic: ResourceControlGen.SkillRootDiagnostic,
    SkillRootKey: ResourceControlGen.SkillRootKey,
    SkillRootStatus: ResourceControlGen.SkillRootStatus,
    SkillSourceIdentity: ResourceControlGen.SkillSourceIdentity,
    SkillTrustSetParams: ResourceControlGen.SkillTrustSetParams,
    SkillRemoveParams: ResourceControlGen.SkillRemoveParams,
    SkillPrioritySetParams: ResourceControlGen.SkillPrioritySetParams,
    SourceScope: ResourceControlGen.SourceScope,
    TrustState: ResourceControlGen.TrustState,
    WorkspaceId: ResourceControlGen.WorkspaceId,
  },
  'https://agnes.ai/schema/package-admin.json': {
    SkinListResult: PackageAdminGen.SkinListResult,
    SkinReadParams: PackageAdminGen.SkinReadParams,
    SkinReadResult: PackageAdminGen.SkinReadResult,
    ClientModuleListResult: PackageAdminGen.ClientModuleListResult,
    ClientModuleRosterRow: PackageAdminGen.ClientModuleRosterRow,
    ClientModuleReadParams: PackageAdminGen.ClientModuleReadParams,
    ClientModuleReadResult: PackageAdminGen.ClientModuleReadResult,
    ClientModuleServiceCallParams: PackageAdminGen.ClientModuleServiceCallParams,
    ClientModuleEffectCallParams: PackageAdminGen.ClientModuleEffectCallParams,
    ClientModuleEffectCallResult: PackageAdminGen.ClientModuleEffectCallResult,
    ClientModuleServiceCallResult: PackageAdminGen.ClientModuleServiceCallResult,
    PackageAdminPermission: PackageAdminGen.PackageAdminPermission,
    PackageActivationTrust: PackageAdminGen.PackageActivationTrust,
    PackageActivationRequest: PackageAdminGen.PackageActivationRequest,
    PackageRollbackTarget: PackageAdminGen.PackageRollbackTarget,
    PackageAdminContext: PackageAdminGen.PackageAdminContext,
    PackageSource: PackageAdminGen.PackageSource,
    PackageContributionSummary: PackageAdminGen.PackageContributionSummary,
    PackageCapabilityDiff: PackageAdminGen.PackageCapabilityDiff,
    PackageBlocker: PackageAdminGen.PackageBlocker,
    PackageWarning: PackageAdminGen.PackageWarning,
    PackageProvenance: PackageAdminGen.PackageProvenance,
    PackagePreview: PackageAdminGen.PackagePreview,
    PackageTrustDecision: PackageAdminGen.PackageTrustDecision,
    PackageInstalledDescriptor: PackageAdminGen.PackageInstalledDescriptor,
    PackageCatalogDescriptor: PackageAdminGen.PackageCatalogDescriptor,
    PackageAdminError: PackageAdminGen.PackageAdminError,
    PackageOperationReceipt: PackageAdminGen.PackageOperationReceipt,
    PackageOperation: PackageAdminGen.PackageOperation,
    PackageCatalogPage: PackageAdminGen.PackageCatalogPage,
    PackageListResult: PackageAdminGen.PackageListResult,
    PackageCatalogListParams: PackageAdminGen.PackageCatalogListParams,
    PackageCatalogGetParams: PackageAdminGen.PackageCatalogGetParams,
    PackageListParams: PackageAdminGen.PackageListParams,
    PackageInspectParams: PackageAdminGen.PackageInspectParams,
    PackageInstallParams: PackageAdminGen.PackageInstallParams,
    PackageTrustParams: PackageAdminGen.PackageTrustParams,
    PackageUntrustParams: PackageAdminGen.PackageUntrustParams,
    PackageEnableParams: PackageAdminGen.PackageEnableParams,
    PackageDisableParams: PackageAdminGen.PackageDisableParams,
    PackageRollbackParams: PackageAdminGen.PackageRollbackParams,
    PackageRemoveParams: PackageAdminGen.PackageRemoveParams,
    PackageUpdateParams: PackageAdminGen.PackageUpdateParams,
    PackageOperationGetParams: PackageAdminGen.PackageOperationGetParams,
    PackageOperationCancelParams: PackageAdminGen.PackageOperationCancelParams,
    RuntimePinDescriptor: PackageAdminGen.RuntimePinDescriptor,
    RuntimePinReleaseResult: PackageAdminGen.RuntimePinReleaseResult,
    PackagePinsInspectParams: PackageAdminGen.PackagePinsInspectParams,
    PackagePinsInspectResult: PackageAdminGen.PackagePinsInspectResult,
    PackagePinsReleaseParams: PackageAdminGen.PackagePinsReleaseParams,
    PackagePinsReleaseResult: PackageAdminGen.PackagePinsReleaseResult,
    PackageTrustWorkspaceParams: PackageAdminGen.PackageTrustWorkspaceParams,
    PackageTrustWorkspaceResult: PackageAdminGen.PackageTrustWorkspaceResult,
    PluginTreeArtifact: PackageAdminGen.PluginTreeArtifact,
    PluginTreeGetParams: PackageAdminGen.PluginTreeGetParams,
    PluginTreeListParams: PackageAdminGen.PluginTreeListParams,
    PluginTreeApplyParams: PackageAdminGen.PluginTreeApplyParams,
    PluginTreeRollbackParams: PackageAdminGen.PluginTreeRollbackParams,
    PluginTreeView: PackageAdminGen.PluginTreeView,
    PluginTreeApplyResult: PackageAdminGen.PluginTreeApplyResult,
    PluginTreeRollbackResult: PackageAdminGen.PluginTreeRollbackResult,
  },
  'https://agnes.ai/schema/surface.json': {
    SurfaceArtifact: SurfaceGen.SurfaceArtifact,
    SurfaceConfigValue: SurfaceGen.SurfaceConfigValue,
    SurfaceDescriptor: SurfaceGen.SurfaceDescriptor,
    SurfaceInstance: SurfaceGen.SurfaceInstance,
    SurfacePackageMetadata: SurfaceGen.SurfacePackageMetadata,
    SurfaceServiceGrant: SurfaceGen.SurfaceServiceGrant,
  },
  'https://agnes.ai/schema/extension-service.json': {
    ServiceCapability: ServiceGen.ServiceCapability,
    ExtensionCallParams: ServiceGen.ExtensionCallParams,
    ExtensionCallResult: ServiceGen.ExtensionCallResult,
    ExtensionAckParams: ServiceGen.ExtensionAckParams,
    ExtensionCallError: ServiceGen.ExtensionCallError,
  },
  'https://agnes.ai/schema/projection.json': {
    ProjectionCapability: ProjectionGen.ProjectionCapability,
    ProjectionReadResult: ProjectionGen.ProjectionReadResult,
  },
  [SESSION_ID]: SESSION_DEFS,
  [AGNES_ID]: AGNES_DEFS,
  [MODEL_ID]: MODEL_DEFS,
  [TOOLDEF_ID]: TOOLDEF_DEFS,
  [HOOKS_ID]: HOOKS_DEFS,
  [SLOTS_ID]: SLOTS_DEFS,
  [PRESET_ID]: PRESET_DEFS,
  'https://agnes.ai/schema/profile.json': ProfileDefs,
  'https://agnes.ai/schema/lockfile.json': LockfileDefs,
  'https://agnes.ai/schema/extension-manifest.json': ExtensionManifestDefs,
  'https://agnes.ai/schema/deploy-manifest.json': DeployManifestDefs,
  'https://agnes.ai/schema/jobs.json': JobsDefs,

  'https://agnes.ai/schema/authz.json': AuthzDefs,
  'https://agnes.ai/schema/channel.json': ChannelDefs,
  'https://agnes.ai/schema/bridge.json': BridgeDefs,
  [ACP_ID]: ACP_DEFS,
}

// Registration has to *be* the comparison, not a precondition for one. These calls used to be five
// hand-written lines, so listing a document above and never passing it to runParity left the suite
// green with zero parity tests generated for it — the same failure model.json shipped with, one step
// further out. Driving the loop from SELF_OWNED_DOCS makes that unreachable: whatever is registered
// is compared, and the only way to add a document without comparing it is to delete it from a list
// the on-disk guard then rejects. A missing $defs table degrades to {} here so the drift guard below
// reports it by name instead of this line throwing during collection.
for (const [file, , id, samples] of SELF_OWNED_DOCS)
  runParity(file.replace(/\.json$/, ''), id, fromSchemaDefs(id, DEFS_BY_FILE[id] ?? {}), samples)

// acp is a vendored upstream asset covered by the 10 referenced definitions rather than all 170, and
// the format checkers are not a schema document at all, so neither belongs in SELF_OWNED_DOCS.
runParity('acp', ACP_ID, fromSchemaDefs(ACP_ID, ACP_DEFS), ACP_SAMPLES)
runParity('format-checkers', FORMATS_ID, fromFormatDefs(), FORMAT_SAMPLES)

// mcp-oauth-authorization plan, Task 1: the 'oauth' secretBinding kind is not yet a branch of
// McpHttpSecretBinding's oneOf. These pin the exact shape the new McpOAuthSecretBinding $def must
// accept once added — staticClientId is optional, and additionalProperties:false must still reject
// unknown fields — and were written and watched red before the schema change landed (see
// task-1-brief.md Step 2/3).
describe('McpHttpSecretBinding: oauth secretBinding kind (mcp-oauth-authorization Task 1)', () => {
  const check = ajvDef('https://agnes.ai/schema/resource-control.json', 'McpHttpSecretBinding')
  it('accepts kind "oauth" with staticClientId', () => {
    const sample = { kind: 'oauth', staticClientId: 'test-oauth-client' }
    expect(check(sample)).toBe(true)
    expect(Value.Check(ResourceControlGen.McpHttpSecretBinding, sample)).toBe(true)
  })
  it('accepts kind "oauth" without staticClientId (optional field)', () => {
    const sample = { kind: 'oauth' }
    expect(check(sample)).toBe(true)
    expect(Value.Check(ResourceControlGen.McpHttpSecretBinding, sample)).toBe(true)
  })
  it('rejects kind "oauth" with an unknown extra field', () => {
    const sample = { kind: 'oauth', staticClientId: 'test-oauth-client', extraField: 'nope' }
    expect(check(sample)).toBe(false)
    expect(Value.Check(ResourceControlGen.McpHttpSecretBinding, sample)).toBe(false)
  })
})

// mcp-oauth-authorization plan, Task 1: McpServerDescriptor.authorizationStatus is optional (a
// non-oauth binding omits it or sets it null) and, when present, constrained to the four states.
// Exercised on a fully composed oauth-bound http descriptor rather than just the bare field, for the
// same reason as the McpServerDefinitionInput composed check above.
describe('McpServerDescriptor: authorizationStatus field (mcp-oauth-authorization Task 1)', () => {
  const check = ajvDef('https://agnes.ai/schema/resource-control.json', 'McpServerDescriptor')
  const descriptor = {
    kind: 'mcp',
    resourceId: 'mcp/example-oauth',
    serverId: 'example-oauth',
    displayName: 'Example OAuth',
    revision: 'a'.repeat(64),
    definition: {
      serverId: 'example-oauth',
      displayName: 'Example OAuth',
      transport: { kind: 'http', url: 'https://mcp.example.test/api' },
      secretBinding: { kind: 'oauth', staticClientId: 'test-oauth-client' },
      toolPolicy: { allow: ['search'] },
    },
    transportKind: 'http',
    secretBindingKind: 'oauth',
    trust: 'trusted',
    desired: 'enabled',
    actual: 'ready',
    source: 'managed',
  }
  it('accepts an oauth-bound descriptor with authorizationStatus set', () => {
    const sample = { ...descriptor, authorizationStatus: 'authorized' }
    expect(check(sample)).toBe(true)
    expect(Value.Check(ResourceControlGen.McpServerDescriptor, sample)).toBe(true)
  })
  it('accepts authorizationStatus: null', () => {
    const sample = { ...descriptor, authorizationStatus: null }
    expect(check(sample)).toBe(true)
    expect(Value.Check(ResourceControlGen.McpServerDescriptor, sample)).toBe(true)
  })
  it('accepts a descriptor that omits authorizationStatus (optional field)', () => {
    expect(check(descriptor)).toBe(true)
    expect(Value.Check(ResourceControlGen.McpServerDescriptor, descriptor)).toBe(true)
  })
  it('rejects an unknown authorizationStatus value', () => {
    const sample = { ...descriptor, authorizationStatus: 'bogus-status' }
    expect(check(sample)).toBe(false)
    expect(Value.Check(ResourceControlGen.McpServerDescriptor, sample)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Every method in the METHODS table, exercised through the public validateMethod rather than by
// reaching for the TSchema directly, with ajv's verdict confirmed to agree separately.
// followUp and steer share one SessionSteerParams/Result schema, but each method name has its own
// fixture rows (followup-ok / followup-missing-commandid / followup-result-ok) and does not reuse
// steer's sample objects: feeding both method names to validateMethod separately means passing the
// wrong method name cannot be masked by the fact that they share a schema.

type MethodDefRef = { fileId: string; params: string; result?: string }

const METHOD_DEF: Record<MethodName, MethodDefRef> = {
  '_agnes/v1/resources.list': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'ResourceListParams',
    result: 'ResourceListResult',
  },
  '_agnes/v1/resources.get': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'ResourceGetParams',
    result: 'ResourceDescriptor',
  },
  '_agnes/v1/resources.desired.set': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'ResourceDesiredSetParams',
    result: 'ResourceOperationReceipt',
  },
  '_agnes/v1/resources.operation.get': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'ResourceOperationGetParams',
    result: 'ResourceOperation',
  },
  '_agnes/v1/resources.operation.cancel': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'ResourceOperationCancelParams',
    result: 'ResourceOperationReceipt',
  },
  '_agnes/v1/skills.refresh': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'SkillRefreshParams',
    result: 'ResourceOperationReceipt',
  },
  '_agnes/v1/skills.remove': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'SkillRemoveParams',
    result: 'ResourceOperationReceipt',
  },
  '_agnes/v1/skills.priority.set': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'SkillPrioritySetParams',
    result: 'ResourceOperationReceipt',
  },
  '_agnes/v1/skills.trust.set': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'SkillTrustSetParams',
    result: 'ResourceOperationReceipt',
  },
  '_agnes/v1/mcp.servers.list': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'McpServerListParams',
    result: 'McpServerListResult',
  },
  '_agnes/v1/mcp.servers.get': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'McpServerGetParams',
    result: 'McpServerDescriptor',
  },
  '_agnes/v1/mcp.servers.status': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'McpServerGetParams',
    result: 'McpStatus',
  },
  '_agnes/v1/mcp.servers.tools.list': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'McpToolsListParams',
    result: 'McpToolCatalogPage',
  },
  '_agnes/v1/mcp.servers.create': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'McpServerCreateParams',
    result: 'ResourceOperationReceipt',
  },
  '_agnes/v1/mcp.servers.update': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'McpServerUpdateParams',
    result: 'ResourceOperationReceipt',
  },
  '_agnes/v1/mcp.servers.remove': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'McpServerRemoveParams',
    result: 'ResourceOperationReceipt',
  },
  '_agnes/v1/mcp.servers.trust.set': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'McpTrustSetParams',
    result: 'ResourceOperationReceipt',
  },
  '_agnes/v1/mcp.servers.test': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'McpServerTestParams',
    result: 'ResourceOperationReceipt',
  },
  '_agnes/v1/mcp.servers.enable': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'McpServerEnableParams',
    result: 'ResourceOperationReceipt',
  },
  '_agnes/v1/mcp.servers.disable': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'McpServerDisableParams',
    result: 'ResourceOperationReceipt',
  },
  '_agnes/v1/mcp.servers.reconnect': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'McpServerReconnectParams',
    result: 'ResourceOperationReceipt',
  },
  '_agnes/v1/mcp.servers.oauth.status': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'McpServerGetParams',
    result: 'McpOAuthStatusResult',
  },
  '_agnes/v1/mcp.servers.oauth.status.set': {
    fileId: 'https://agnes.ai/schema/resource-control.json',
    params: 'McpOAuthStatusSetParams',
    result: 'McpOAuthStatusResult',
  },
  '_agnes/v1/packages.catalog.list': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageCatalogListParams',
    result: 'PackageCatalogPage',
  },
  '_agnes/v1/packages.catalog.get': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageCatalogGetParams',
    result: 'PackageCatalogDescriptor',
  },
  '_agnes/v1/packages.list': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageListParams',
    result: 'PackageListResult',
  },
  '_agnes/v1/skins.list': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageListParams',
    result: 'SkinListResult',
  },
  '_agnes/v1/skins.read': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'SkinReadParams',
    result: 'SkinReadResult',
  },
  '_agnes/v1/clientModules.list': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageListParams',
    result: 'ClientModuleListResult',
  },
  '_agnes/v1/clientModules.read': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'ClientModuleReadParams',
    result: 'ClientModuleReadResult',
  },
  '_agnes/v1/clientModules.callService': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'ClientModuleServiceCallParams',
    result: 'ClientModuleServiceCallResult',
  },
  '_agnes/v1/clientModules.callEffect': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'ClientModuleEffectCallParams',
    result: 'ClientModuleEffectCallResult',
  },
  '_agnes/v1/packages.inspect': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageInspectParams',
    result: 'PackageOperationReceipt',
  },
  '_agnes/v1/packages.install': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageInstallParams',
    result: 'PackageOperationReceipt',
  },
  '_agnes/v1/packages.trust': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageTrustParams',
    result: 'PackageOperationReceipt',
  },
  '_agnes/v1/packages.untrust': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageUntrustParams',
    result: 'PackageOperationReceipt',
  },
  '_agnes/v1/packages.enable': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageEnableParams',
    result: 'PackageOperationReceipt',
  },
  '_agnes/v1/packages.disable': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageDisableParams',
    result: 'PackageOperationReceipt',
  },
  '_agnes/v1/packages.update': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageUpdateParams',
    result: 'PackageOperationReceipt',
  },
  '_agnes/v1/packages.rollback': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageRollbackParams',
    result: 'PackageOperationReceipt',
  },
  '_agnes/v1/packages.remove': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageRemoveParams',
    result: 'PackageOperationReceipt',
  },
  '_agnes/v1/packages.operation.get': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageOperationGetParams',
    result: 'PackageOperation',
  },
  '_agnes/v1/packages.operation.cancel': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageOperationCancelParams',
    result: 'PackageOperationReceipt',
  },
  '_agnes/v1/packages.pins.inspect': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackagePinsInspectParams',
    result: 'PackagePinsInspectResult',
  },
  '_agnes/v1/packages.pins.release': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackagePinsReleaseParams',
    result: 'PackagePinsReleaseResult',
  },
  '_agnes/v1/packages.trustWorkspace': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageTrustWorkspaceParams',
    result: 'PackageTrustWorkspaceResult',
  },
  '_agnes/v1/plugins.tree.get': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageListParams',
    result: 'PluginTreeView',
  },
  '_agnes/v1/plugins.tree.list': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PackageListParams',
    result: 'PluginTreeView',
  },
  '_agnes/v1/plugins.tree.apply': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PluginTreeApplyParams',
    result: 'PluginTreeApplyResult',
  },
  '_agnes/v1/plugins.tree.rollback': {
    fileId: 'https://agnes.ai/schema/package-admin.json',
    params: 'PluginTreeRollbackParams',
    result: 'PluginTreeRollbackResult',
  },

  '_agnes/v1/extension.ack': {
    fileId: AGNES_ID,
    params: 'ExtensionAckParams',
    result: 'Empty',
  },
  '_agnes/v1/extension.call': {
    fileId: AGNES_ID,
    params: 'ExtensionCallParams',
    result: 'ExtensionCallResult',
  },
  '_agnes/v1/config.get': { fileId: AGNES_ID, params: 'ConfigEmptyParams', result: 'ConfigSnapshot' },
  '_agnes/v1/config.oauth': { fileId: AGNES_ID, params: 'ConfigOAuthInput', result: 'ConfigOAuthResult' },
  '_agnes/v1/config.providers': {
    fileId: AGNES_ID,
    params: 'ConfigEmptyParams',
    result: 'ConfigProvidersResult',
  },
  '_agnes/v1/config.test': { fileId: AGNES_ID, params: 'ConfigTestInput', result: 'ConfigTestResult' },
  '_agnes/v1/config.account': { fileId: AGNES_ID, params: 'ConfigAccountInput', result: 'ConfigSnapshot' },
  '_agnes/v1/config.save': { fileId: AGNES_ID, params: 'ConfigSaveInput', result: 'ConfigSnapshot' },
  '_agnes/v1/computerUse.status': {
    fileId: AGNES_ID,
    params: 'Empty',
    result: 'ComputerUseStatusResult',
  },
  '_agnes/v1/computerUse.permissions.status': {
    fileId: AGNES_ID,
    params: 'Empty',
    result: 'ComputerUsePermissionsStatusResult',
  },
  '_agnes/v1/computerUse.permissions.grant': {
    fileId: AGNES_ID,
    params: 'Empty',
    result: 'ComputerUsePermissionsStatusResult',
  },
  '_agnes/v1/computerUse.doctor': {
    fileId: AGNES_ID,
    params: 'ComputerUseDoctorParams',
    result: 'ComputerUseDoctorResult',
  },
  '_agnes/v1/computerUse.operation.start': {
    fileId: AGNES_ID,
    params: 'ComputerUseOperationStartParams',
    result: 'ComputerUseOperationResult',
  },
  '_agnes/v1/computerUse.operation.status': {
    fileId: AGNES_ID,
    params: 'ComputerUseOperationStatusParams',
    result: 'ComputerUseOperationResult',
  },
  '_agnes/v1/computerUse.operation.cancel': {
    fileId: AGNES_ID,
    params: 'ComputerUseOperationIdParams',
    result: 'ComputerUseOperationResult',
  },
  '_agnes/v1/approvalGrants.list': {
    fileId: AGNES_ID,
    params: 'ApprovalGrantListParams',
    result: 'ApprovalGrantListResult',
  },
  '_agnes/v1/approvalGrants.revoke': {
    fileId: AGNES_ID,
    params: 'ApprovalGrantRevokeParams',
    result: 'ApprovalGrantRecord',
  },

  '_agnes/v1/session.budget': { fileId: AGNES_ID, params: 'SessionIdParams', result: 'SessionBudgetResult' },
  '_agnes/v1/session.projectUI': { fileId: AGNES_ID, params: 'SessionProjectUIParams', result: 'UITimeline' },
  '_agnes/v1/session.projectUIPatch': {
    fileId: AGNES_ID,
    params: 'SessionProjectUIPatchParams',
    result: 'UIProjectionUpdate',
  },
  '_agnes/v1/session.projectUIOpening': {
    fileId: AGNES_ID,
    params: 'SessionProjectUIOpeningParams',
    result: 'UIOpeningResult',
  },
  '_agnes/v1/session.projectUIHistory': {
    fileId: AGNES_ID,
    params: 'SessionProjectUIHistoryParams',
    result: 'UIHistoryPage',
  },
  initialize: { fileId: ACP_ID, params: 'InitializeRequest', result: 'InitializeResponse' },
  'session/new': { fileId: ACP_ID, params: 'NewSessionRequest', result: 'NewSessionResponse' },
  'session/prompt': { fileId: ACP_ID, params: 'PromptRequest', result: 'PromptResponse' },
  'session/cancel': { fileId: ACP_ID, params: 'CancelNotification' },
  'session/update': { fileId: ACP_ID, params: 'SessionNotification' },
  'session/request_permission': {
    fileId: ACP_ID,
    params: 'RequestPermissionRequest',
    result: 'RequestPermissionResponse',
  },
  '_agnes/v1/session.attach': {
    fileId: AGNES_ID,
    params: 'SessionAttachParams',
    result: 'SessionAttachResult',
  },
  '_agnes/v1/session.steer': { fileId: AGNES_ID, params: 'SessionSteerParams', result: 'SessionSteerResult' },
  '_agnes/v1/session.followUp': {
    fileId: AGNES_ID,
    params: 'SessionSteerParams',
    result: 'SessionSteerResult',
  },
  '_agnes/v1/apis.list': { fileId: AGNES_ID, params: 'ApisListParams', result: 'ApisListResult' },
  '_agnes/v1/submit': { fileId: AGNES_ID, params: 'SubmitParams', result: 'Ack' },
  '_agnes/v1/submit.ack': { fileId: AGNES_ID, params: 'CommandAckParams', result: 'Empty' },
  authenticate: { fileId: ACP_ID, params: 'AuthenticateRequest', result: 'AuthenticateResponse' },
  'session/load': { fileId: ACP_ID, params: 'LoadSessionRequest', result: 'LoadSessionResponse' },
  'session/set_mode': { fileId: ACP_ID, params: 'SetSessionModeRequest', result: 'SetSessionModeResponse' },
  '_agnes/v1/session.detach': { fileId: AGNES_ID, params: 'SessionIdParams', result: 'Empty' },
  '_agnes/v1/auth.claim': { fileId: AGNES_ID, params: 'AuthClaimParams', result: 'AuthClaimResult' },
  '_agnes/v1/session.event': { fileId: AGNES_ID, params: 'SessionEventParams' },
  '_agnes/v1/session.preview': { fileId: AGNES_ID, params: 'SessionPreviewParams' },
  '_agnes/v1/daemon.notice': { fileId: AGNES_ID, params: 'DaemonNotice' },
  '_agnes/v1/session.fork': { fileId: AGNES_ID, params: 'SessionForkParams', result: 'SessionIdParams' },
  '_agnes/v1/session.rename': {
    fileId: 'https://agnes.ai/schema/agnes-v1.json',
    params: 'SessionRenameParams',
    result: 'SessionPreferences',
  },
  '_agnes/v1/session.archive': {
    fileId: 'https://agnes.ai/schema/agnes-v1.json',
    params: 'SessionArchiveParams',
    result: 'SessionPreferences',
  },
  '_agnes/v1/diagnostics.collect': {
    fileId: AGNES_ID,
    params: 'DiagnosticsCollectParams',
    result: 'DiagnosticsCollectResult',
  },
  '_agnes/v1/diagnostics.events': {
    fileId: AGNES_ID,
    params: 'DiagnosticsEventsParams',
    result: 'DiagnosticsEventsResult',
  },
  '_agnes/v1/session.list': { fileId: AGNES_ID, params: 'SessionListParams', result: 'PageSessionMeta' },
  '_agnes/v1/workspace.list': {
    fileId: AGNES_ID,
    params: 'WorkspaceListParams',
    result: 'WorkspaceListResult',
  },
  '_agnes/v1/workspace.add': {
    fileId: AGNES_ID,
    params: 'WorkspaceAddParams',
    result: 'WorkspaceAddResult',
  },
  '_agnes/v1/surfaces.mounts': {
    fileId: AGNES_ID,
    params: 'SurfacesMountsParams',
    result: 'SurfacesMountsResult',
  },
  '_agnes/v1/session.setPreset': {
    fileId: AGNES_ID,
    params: 'SessionSetPresetParams',
    result: 'EffectiveFromResult',
  },
  '_agnes/v1/session.setModel': {
    fileId: AGNES_ID,
    params: 'SessionSetModelParams',
    result: 'EffectiveFromResult',
  },
  '_agnes/v1/session.setYolo': {
    fileId: AGNES_ID,
    params: 'SessionSetYoloParams',
    result: 'EffectiveFromResult',
  },
  '_agnes/v1/approval.decide': { fileId: AGNES_ID, params: 'ApprovalDecideParams', result: 'SeqResult' },
  '_agnes/v1/participant.join': { fileId: AGNES_ID, params: 'ParticipantParams', result: 'SeqResult' },
  '_agnes/v1/participant.leave': { fileId: AGNES_ID, params: 'ParticipantParams', result: 'SeqResult' },
  '_agnes/v1/participant.list': {
    fileId: AGNES_ID,
    params: 'SessionIdParams',
    result: 'ParticipantListResult',
  },
  '_agnes/v1/jobs.enqueue': { fileId: AGNES_ID, params: 'JobSpec', result: 'JobIdResult' },
  '_agnes/v1/jobs.poll': { fileId: AGNES_ID, params: 'JobIdParams', result: 'JobStatus' },
  '_agnes/v1/jobs.cancel': { fileId: AGNES_ID, params: 'JobIdParams', result: 'Empty' },
  '_agnes/v1/artifact.job.status': { fileId: AGNES_ID, params: 'JobIdParams', result: 'ArtifactJob' },
  '_agnes/v1/artifact.read': {
    fileId: AGNES_ID,
    params: 'ArtifactReadParams',
    result: 'ArtifactReadResult',
  },
  '_agnes/v1/ext.ui.response': { fileId: AGNES_ID, params: 'ExtUiResponseParams', result: 'SeqResult' },
  '_agnes/v1/directory.upsert': {
    fileId: AGNES_ID,
    params: 'DirectoryUpsertParams',
    result: 'DirectoryUpsertResult',
  },
}

const METHOD_PARAMS_SAMPLE: Record<MethodName, Sample> = {
  '_agnes/v1/resources.list': ResourceControlSamples.ResourceListParams,
  '_agnes/v1/resources.get': ResourceControlSamples.ResourceGetParams,
  '_agnes/v1/resources.desired.set': ResourceControlSamples.ResourceDesiredSetParams,
  '_agnes/v1/resources.operation.get': ResourceControlSamples.ResourceOperationGetParams,
  '_agnes/v1/resources.operation.cancel': ResourceControlSamples.ResourceOperationCancelParams,
  '_agnes/v1/skills.refresh': ResourceControlSamples.SkillRefreshParams,
  '_agnes/v1/skills.remove': ResourceControlSamples.SkillRemoveParams,
  '_agnes/v1/skills.priority.set': ResourceControlSamples.SkillPrioritySetParams,
  '_agnes/v1/skills.trust.set': ResourceControlSamples.SkillTrustSetParams,
  '_agnes/v1/mcp.servers.list': ResourceControlSamples.McpServerListParams,
  '_agnes/v1/mcp.servers.get': ResourceControlSamples.McpServerGetParams,
  '_agnes/v1/mcp.servers.status': ResourceControlSamples.McpServerGetParams,
  '_agnes/v1/mcp.servers.tools.list': ResourceControlSamples.McpToolsListParams,
  '_agnes/v1/mcp.servers.create': ResourceControlSamples.McpServerCreateParams,
  '_agnes/v1/mcp.servers.update': ResourceControlSamples.McpServerUpdateParams,
  '_agnes/v1/mcp.servers.remove': ResourceControlSamples.McpServerRemoveParams,
  '_agnes/v1/mcp.servers.trust.set': ResourceControlSamples.McpTrustSetParams,
  '_agnes/v1/mcp.servers.test': ResourceControlSamples.McpServerTestParams,
  '_agnes/v1/mcp.servers.enable': ResourceControlSamples.McpServerEnableParams,
  '_agnes/v1/mcp.servers.disable': ResourceControlSamples.McpServerDisableParams,
  '_agnes/v1/mcp.servers.reconnect': ResourceControlSamples.McpServerReconnectParams,
  '_agnes/v1/mcp.servers.oauth.status': ResourceControlSamples.McpServerGetParams,
  '_agnes/v1/mcp.servers.oauth.status.set': ResourceControlSamples.McpOAuthStatusSetParams,
  '_agnes/v1/packages.catalog.list': PackageAdminSamples.PackageCatalogListParams as Sample,
  '_agnes/v1/packages.catalog.get': PackageAdminSamples.PackageCatalogGetParams as Sample,
  '_agnes/v1/packages.list': PackageAdminSamples.PackageListParams as Sample,
  '_agnes/v1/skins.list': PackageAdminSamples.PackageListParams as Sample,
  '_agnes/v1/skins.read': PackageAdminSamples.SkinReadParams as Sample,
  '_agnes/v1/clientModules.list': PackageAdminSamples.PackageListParams as Sample,
  '_agnes/v1/clientModules.read': PackageAdminSamples.ClientModuleReadParams as Sample,
  '_agnes/v1/clientModules.callService': PackageAdminSamples.ClientModuleServiceCallParams as Sample,
  '_agnes/v1/clientModules.callEffect': PackageAdminSamples.ClientModuleEffectCallParams as Sample,
  '_agnes/v1/packages.inspect': PackageAdminSamples.PackageInspectParams as Sample,
  '_agnes/v1/packages.install': PackageAdminSamples.PackageInstallParams as Sample,
  '_agnes/v1/packages.trust': PackageAdminSamples.PackageTrustParams as Sample,
  '_agnes/v1/packages.untrust': PackageAdminSamples.PackageUntrustParams as Sample,
  '_agnes/v1/packages.enable': PackageAdminSamples.PackageEnableParams as Sample,
  '_agnes/v1/packages.disable': PackageAdminSamples.PackageDisableParams as Sample,
  '_agnes/v1/packages.update': PackageAdminSamples.PackageUpdateParams as Sample,
  '_agnes/v1/packages.rollback': PackageAdminSamples.PackageRollbackParams as Sample,
  '_agnes/v1/packages.remove': PackageAdminSamples.PackageRemoveParams as Sample,
  '_agnes/v1/packages.operation.get': PackageAdminSamples.PackageOperationGetParams as Sample,
  '_agnes/v1/packages.operation.cancel': PackageAdminSamples.PackageOperationCancelParams as Sample,
  '_agnes/v1/packages.pins.inspect': PackageAdminSamples.PackagePinsInspectParams as Sample,
  '_agnes/v1/packages.pins.release': PackageAdminSamples.PackagePinsReleaseParams as Sample,
  '_agnes/v1/packages.trustWorkspace': PackageAdminSamples.PackageTrustWorkspaceParams as Sample,
  '_agnes/v1/plugins.tree.get': PackageAdminSamples.PackageListParams as Sample,
  '_agnes/v1/plugins.tree.list': PackageAdminSamples.PackageListParams as Sample,
  '_agnes/v1/plugins.tree.apply': PackageAdminSamples.PluginTreeApplyParams as Sample,
  '_agnes/v1/plugins.tree.rollback': PackageAdminSamples.PluginTreeRollbackParams as Sample,

  '_agnes/v1/extension.ack': ServiceSamples.ExtensionAckParams as Sample,
  '_agnes/v1/extension.call': ServiceSamples.ExtensionCallParams as Sample,
  '_agnes/v1/config.get': AGNES_SAMPLES.ConfigEmptyParams as Sample,
  '_agnes/v1/config.oauth': {
    note: 'OAuth operation',
    valid: { action: 'poll', operationId: 'op' },
    invalid: [{ action: 'unknown' }],
  },
  '_agnes/v1/config.providers': AGNES_SAMPLES.ConfigEmptyParams as Sample,
  '_agnes/v1/config.test': AGNES_SAMPLES.ConfigTestInput as Sample,
  '_agnes/v1/config.account': {
    note: 'account management validates identity and revision',
    valid: { accountId: 'work', action: 'enable', expectedRevision: 1 },
    invalid: [{ accountId: '../bad', action: 'enable', expectedRevision: 1 }],
  },
  '_agnes/v1/config.save': AGNES_SAMPLES.ConfigSaveInput as Sample,
  '_agnes/v1/computerUse.status': AGNES_SAMPLES.Empty as Sample,
  '_agnes/v1/computerUse.permissions.status': AGNES_SAMPLES.Empty as Sample,
  '_agnes/v1/computerUse.permissions.grant': AGNES_SAMPLES.Empty as Sample,
  '_agnes/v1/computerUse.doctor': AGNES_SAMPLES.ComputerUseDoctorParams as Sample,
  '_agnes/v1/computerUse.operation.start': AGNES_SAMPLES.ComputerUseOperationStartParams as Sample,
  '_agnes/v1/computerUse.operation.status': AGNES_SAMPLES.ComputerUseOperationStatusParams as Sample,
  '_agnes/v1/computerUse.operation.cancel': AGNES_SAMPLES.ComputerUseOperationIdParams as Sample,
  '_agnes/v1/approvalGrants.list': AGNES_SAMPLES.ApprovalGrantListParams as Sample,
  '_agnes/v1/approvalGrants.revoke': AGNES_SAMPLES.ApprovalGrantRevokeParams as Sample,

  '_agnes/v1/session.budget': AGNES_SAMPLES.SessionIdParams as Sample,
  '_agnes/v1/session.projectUI': AGNES_SAMPLES.SessionProjectUIParams as Sample,
  '_agnes/v1/session.projectUIPatch': AGNES_SAMPLES.SessionProjectUIPatchParams as Sample,
  '_agnes/v1/session.projectUIOpening': AGNES_SAMPLES.SessionProjectUIOpeningParams as Sample,
  '_agnes/v1/session.projectUIHistory': AGNES_SAMPLES.SessionProjectUIHistoryParams as Sample,
  initialize: ACP_SAMPLES.InitializeRequest as Sample,
  'session/new': ACP_SAMPLES.NewSessionRequest as Sample,
  'session/prompt': ACP_SAMPLES.PromptRequest as Sample,
  'session/cancel': ACP_SAMPLES.CancelNotification as Sample,
  'session/update': ACP_SAMPLES.SessionNotification as Sample,
  'session/request_permission': ACP_SAMPLES.RequestPermissionRequest as Sample,
  '_agnes/v1/session.attach': AGNES_SAMPLES.SessionAttachParams as Sample,
  '_agnes/v1/session.steer': AGNES_SAMPLES.SessionSteerParams as Sample,
  '_agnes/v1/session.followUp': {
    valid: followupOk,
    invalid: [
      byId(methodFixtures, 'followup-missing-commandid'),
      { ...followupOk, commandId: rep(129) }, // boundary: maxLength:128
    ],
    note: 'valid and the first invalid reuse fixtures/methods/i1.jsonl (followup-ok / followup-missing-commandid)',
  },
  '_agnes/v1/apis.list': AGNES_SAMPLES.ApisListParams as Sample,
  '_agnes/v1/submit': AGNES_SAMPLES.SubmitParams as Sample,
  '_agnes/v1/submit.ack': AGNES_SAMPLES.CommandAckParams as Sample,
  authenticate: ACP_SAMPLES.AuthenticateRequest as Sample,
  'session/load': ACP_SAMPLES.LoadSessionRequest as Sample,
  'session/set_mode': ACP_SAMPLES.SetSessionModeRequest as Sample,
  '_agnes/v1/session.detach': AGNES_SAMPLES.SessionIdParams as Sample,
  // The windowed branch of the oneOf, so that between this entry and AGNES_SAMPLES.AuthClaimParams
  // (which takes the once-only branch) both shapes are accepted by a valid sample somewhere, not just
  // rejected by negatives.
  '_agnes/v1/auth.claim': {
    valid: authClaimWindowed,
    invalid: [
      authClaimMixed,
      { kind: 'send', value: 'u1', limit: 2, windowMs: 1000, extra: 1 }, // additionalProperties:false
    ],
    note: 'valid and the first invalid reuse fixtures/methods/i1.jsonl (auth-claim-params-windowed / auth-claim-params-mixed-shapes)',
  },
  '_agnes/v1/session.event': AGNES_SAMPLES.SessionEventParams as Sample,
  '_agnes/v1/session.preview': AGNES_SAMPLES.SessionPreviewParams as Sample,
  '_agnes/v1/daemon.notice': AGNES_SAMPLES.DaemonNotice as Sample,
  '_agnes/v1/session.fork': AGNES_SAMPLES.SessionForkParams as Sample,
  '_agnes/v1/session.rename': {
    note: 'manual title',
    valid: { sessionId: 's', title: 'name' },
    invalid: [{ sessionId: 's', title: '' }],
  },
  '_agnes/v1/session.archive': {
    note: 'reversible archive',
    valid: { sessionId: 's', archived: true },
    invalid: [{ sessionId: 's', archived: 'true' }],
  },
  '_agnes/v1/diagnostics.collect': AGNES_SAMPLES.DiagnosticsCollectParams as Sample,
  '_agnes/v1/diagnostics.events': AGNES_SAMPLES.DiagnosticsEventsParams as Sample,
  '_agnes/v1/session.list': AGNES_SAMPLES.SessionListParams as Sample,
  '_agnes/v1/workspace.list': AGNES_SAMPLES.WorkspaceListParams as Sample,
  '_agnes/v1/workspace.add': AGNES_SAMPLES.WorkspaceAddParams as Sample,
  '_agnes/v1/surfaces.mounts': AGNES_SAMPLES.SurfacesMountsParams as Sample,
  '_agnes/v1/session.setPreset': AGNES_SAMPLES.SessionSetPresetParams as Sample,
  '_agnes/v1/session.setModel': AGNES_SAMPLES.SessionSetModelParams as Sample,
  '_agnes/v1/session.setYolo': AGNES_SAMPLES.SessionSetYoloParams as Sample,
  '_agnes/v1/approval.decide': AGNES_SAMPLES.ApprovalDecideParams as Sample,
  '_agnes/v1/participant.join': AGNES_SAMPLES.ParticipantParams as Sample,
  '_agnes/v1/participant.leave': AGNES_SAMPLES.ParticipantParams as Sample,
  '_agnes/v1/participant.list': AGNES_SAMPLES.SessionIdParams as Sample,
  '_agnes/v1/jobs.enqueue': AGNES_SAMPLES.JobSpec as Sample,
  '_agnes/v1/jobs.poll': AGNES_SAMPLES.JobIdParams as Sample,
  '_agnes/v1/jobs.cancel': AGNES_SAMPLES.JobIdParams as Sample,
  '_agnes/v1/artifact.job.status': AGNES_SAMPLES.JobIdParams as Sample,
  '_agnes/v1/artifact.read': AGNES_SAMPLES.ArtifactReadParams as Sample,
  '_agnes/v1/ext.ui.response': AGNES_SAMPLES.ExtUiResponseParams as Sample,
  '_agnes/v1/directory.upsert': AGNES_SAMPLES.DirectoryUpsertParams as Sample,
}

const METHOD_RESULT_SAMPLE: Partial<Record<MethodName, Sample>> = {
  '_agnes/v1/session.rename': AGNES_SAMPLES.SessionPreferences as Sample,
  '_agnes/v1/session.archive': AGNES_SAMPLES.SessionPreferences as Sample,
  '_agnes/v1/diagnostics.collect': AGNES_SAMPLES.DiagnosticsCollectResult as Sample,
  '_agnes/v1/diagnostics.events': {
    note: 'empty last page',
    valid: { events: [], lastSeq: 0, nextAfterSeq: null },
    invalid: [{ events: [], lastSeq: 0 }],
  },
  '_agnes/v1/resources.list': ResourceControlSamples.ResourceListResult,
  '_agnes/v1/resources.get': ResourceControlSamples.ResourceDescriptor,
  '_agnes/v1/resources.desired.set': ResourceControlSamples.ResourceOperationReceipt,
  '_agnes/v1/resources.operation.get': ResourceControlSamples.ResourceOperation,
  '_agnes/v1/resources.operation.cancel': ResourceControlSamples.ResourceOperationReceipt,
  '_agnes/v1/skills.refresh': ResourceControlSamples.ResourceOperationReceipt,
  '_agnes/v1/skills.remove': ResourceControlSamples.ResourceOperationReceipt,
  '_agnes/v1/skills.priority.set': ResourceControlSamples.ResourceOperationReceipt,
  '_agnes/v1/skills.trust.set': ResourceControlSamples.ResourceOperationReceipt,
  '_agnes/v1/mcp.servers.list': ResourceControlSamples.McpServerListResult,
  '_agnes/v1/mcp.servers.get': ResourceControlSamples.McpServerDescriptor,
  '_agnes/v1/mcp.servers.status': ResourceControlSamples.McpStatus,
  '_agnes/v1/mcp.servers.tools.list': ResourceControlSamples.McpToolCatalogPage,
  '_agnes/v1/mcp.servers.create': ResourceControlSamples.ResourceOperationReceipt,
  '_agnes/v1/mcp.servers.update': ResourceControlSamples.ResourceOperationReceipt,
  '_agnes/v1/mcp.servers.remove': ResourceControlSamples.ResourceOperationReceipt,
  '_agnes/v1/mcp.servers.trust.set': ResourceControlSamples.ResourceOperationReceipt,
  '_agnes/v1/mcp.servers.test': ResourceControlSamples.ResourceOperationReceipt,
  '_agnes/v1/mcp.servers.enable': ResourceControlSamples.ResourceOperationReceipt,
  '_agnes/v1/mcp.servers.disable': ResourceControlSamples.ResourceOperationReceipt,
  '_agnes/v1/mcp.servers.reconnect': ResourceControlSamples.ResourceOperationReceipt,
  '_agnes/v1/mcp.servers.oauth.status': ResourceControlSamples.McpOAuthStatusResult,
  '_agnes/v1/mcp.servers.oauth.status.set': ResourceControlSamples.McpOAuthStatusResult,
  '_agnes/v1/packages.catalog.list': PackageAdminSamples.PackageCatalogPage as Sample,
  '_agnes/v1/packages.catalog.get': PackageAdminSamples.PackageCatalogDescriptor as Sample,
  '_agnes/v1/packages.list': PackageAdminSamples.PackageListResult as Sample,
  '_agnes/v1/skins.list': PackageAdminSamples.SkinListResult as Sample,
  '_agnes/v1/skins.read': PackageAdminSamples.SkinReadResult as Sample,
  '_agnes/v1/clientModules.list': PackageAdminSamples.ClientModuleListResult as Sample,
  '_agnes/v1/clientModules.read': PackageAdminSamples.ClientModuleReadResult as Sample,
  '_agnes/v1/clientModules.callService': PackageAdminSamples.ClientModuleServiceCallResult as Sample,
  '_agnes/v1/clientModules.callEffect': PackageAdminSamples.ClientModuleEffectCallResult as Sample,
  '_agnes/v1/packages.inspect': PackageAdminSamples.PackageOperationReceipt as Sample,
  '_agnes/v1/packages.install': PackageAdminSamples.PackageOperationReceipt as Sample,
  '_agnes/v1/packages.trust': PackageAdminSamples.PackageOperationReceipt as Sample,
  '_agnes/v1/packages.untrust': PackageAdminSamples.PackageOperationReceipt as Sample,
  '_agnes/v1/packages.enable': PackageAdminSamples.PackageOperationReceipt as Sample,
  '_agnes/v1/packages.disable': PackageAdminSamples.PackageOperationReceipt as Sample,
  '_agnes/v1/packages.update': PackageAdminSamples.PackageOperationReceipt as Sample,
  '_agnes/v1/packages.rollback': PackageAdminSamples.PackageOperationReceipt as Sample,
  '_agnes/v1/packages.remove': PackageAdminSamples.PackageOperationReceipt as Sample,
  '_agnes/v1/packages.operation.get': PackageAdminSamples.PackageOperation as Sample,
  '_agnes/v1/packages.operation.cancel': PackageAdminSamples.PackageOperationReceipt as Sample,
  '_agnes/v1/packages.pins.inspect': PackageAdminSamples.PackagePinsInspectResult as Sample,
  '_agnes/v1/packages.pins.release': PackageAdminSamples.PackagePinsReleaseResult as Sample,
  '_agnes/v1/packages.trustWorkspace': PackageAdminSamples.PackageTrustWorkspaceResult as Sample,
  '_agnes/v1/plugins.tree.get': PackageAdminSamples.PluginTreeView as Sample,
  '_agnes/v1/plugins.tree.list': PackageAdminSamples.PluginTreeView as Sample,
  '_agnes/v1/plugins.tree.apply': PackageAdminSamples.PluginTreeApplyResult as Sample,
  '_agnes/v1/plugins.tree.rollback': PackageAdminSamples.PluginTreeRollbackResult as Sample,

  '_agnes/v1/extension.ack': AGNES_SAMPLES.Empty as Sample,
  '_agnes/v1/extension.call': ServiceSamples.ExtensionCallResult as Sample,
  '_agnes/v1/config.get': AGNES_SAMPLES.ConfigSnapshot as Sample,
  '_agnes/v1/config.oauth': {
    note: 'OAuth result has no tokens',
    valid: { operationId: 'op', state: 'running' },
    invalid: [{ operationId: 'op', state: 'running', access: 'secret' }],
  },
  '_agnes/v1/config.providers': AGNES_SAMPLES.ConfigProvidersResult as Sample,
  '_agnes/v1/config.test': AGNES_SAMPLES.ConfigTestResult as Sample,
  '_agnes/v1/config.account': AGNES_SAMPLES.ConfigSnapshot as Sample,
  '_agnes/v1/config.save': AGNES_SAMPLES.ConfigSnapshot as Sample,
  '_agnes/v1/computerUse.status': AGNES_SAMPLES.ComputerUseStatusResult as Sample,
  '_agnes/v1/computerUse.permissions.status': AGNES_SAMPLES.ComputerUsePermissionsStatusResult as Sample,
  '_agnes/v1/computerUse.permissions.grant': AGNES_SAMPLES.ComputerUsePermissionsStatusResult as Sample,
  '_agnes/v1/computerUse.doctor': AGNES_SAMPLES.ComputerUseDoctorResult as Sample,
  '_agnes/v1/computerUse.operation.start': AGNES_SAMPLES.ComputerUseOperationResult as Sample,
  '_agnes/v1/computerUse.operation.status': AGNES_SAMPLES.ComputerUseOperationResult as Sample,
  '_agnes/v1/computerUse.operation.cancel': AGNES_SAMPLES.ComputerUseOperationResult as Sample,
  '_agnes/v1/approvalGrants.list': AGNES_SAMPLES.ApprovalGrantListResult as Sample,
  '_agnes/v1/approvalGrants.revoke': AGNES_SAMPLES.ApprovalGrantRecord as Sample,

  '_agnes/v1/session.budget': AGNES_SAMPLES.SessionBudgetResult as Sample,
  '_agnes/v1/session.projectUI': AGNES_SAMPLES.UITimeline as Sample,
  '_agnes/v1/session.projectUIPatch': AGNES_SAMPLES.UIProjectionUpdate as Sample,
  '_agnes/v1/session.projectUIOpening': AGNES_SAMPLES.UIOpeningResult as Sample,
  '_agnes/v1/session.projectUIHistory': AGNES_SAMPLES.UIHistoryPage as Sample,
  '_agnes/v1/session.fork': AGNES_SAMPLES.SessionIdParams as Sample,
  '_agnes/v1/session.list': AGNES_SAMPLES.PageSessionMeta as Sample,
  '_agnes/v1/workspace.list': AGNES_SAMPLES.WorkspaceListResult as Sample,
  '_agnes/v1/workspace.add': AGNES_SAMPLES.WorkspaceAddResult as Sample,
  '_agnes/v1/surfaces.mounts': AGNES_SAMPLES.SurfacesMountsResult as Sample,
  '_agnes/v1/session.setPreset': AGNES_SAMPLES.EffectiveFromResult as Sample,
  '_agnes/v1/session.setModel': AGNES_SAMPLES.EffectiveFromResult as Sample,
  '_agnes/v1/session.setYolo': AGNES_SAMPLES.EffectiveFromResult as Sample,
  initialize: ACP_SAMPLES.InitializeResponse as Sample,
  'session/new': ACP_SAMPLES.NewSessionResponse as Sample,
  'session/prompt': ACP_SAMPLES.PromptResponse as Sample,
  'session/request_permission': ACP_SAMPLES.RequestPermissionResponse as Sample,
  '_agnes/v1/session.attach': AGNES_SAMPLES.SessionAttachResult as Sample,
  '_agnes/v1/session.steer': AGNES_SAMPLES.SessionSteerResult as Sample,
  '_agnes/v1/session.followUp': {
    valid: byId(methodFixtures, 'followup-result-ok'),
    invalid: [{ seq: 0 }], // boundary: minimum:1
    note: 'valid reuses followup-result-ok from fixtures/methods/i1.jsonl; invalid is hand-written',
  },
  '_agnes/v1/apis.list': AGNES_SAMPLES.ApisListResult as Sample,
  '_agnes/v1/submit': AGNES_SAMPLES.Ack as Sample,
  '_agnes/v1/submit.ack': AGNES_SAMPLES.Empty as Sample,
  authenticate: ACP_SAMPLES.AuthenticateResponse as Sample,
  'session/load': ACP_SAMPLES.LoadSessionResponse as Sample,
  'session/set_mode': ACP_SAMPLES.SetSessionModeResponse as Sample,
  '_agnes/v1/session.detach': AGNES_SAMPLES.Empty as Sample,
  '_agnes/v1/auth.claim': AGNES_SAMPLES.AuthClaimResult as Sample,
  '_agnes/v1/approval.decide': AGNES_SAMPLES.SeqResult as Sample,
  '_agnes/v1/participant.join': AGNES_SAMPLES.SeqResult as Sample,
  '_agnes/v1/participant.leave': AGNES_SAMPLES.SeqResult as Sample,
  '_agnes/v1/participant.list': AGNES_SAMPLES.ParticipantListResult as Sample,
  '_agnes/v1/jobs.enqueue': AGNES_SAMPLES.JobIdResult as Sample,
  '_agnes/v1/jobs.poll': AGNES_SAMPLES.JobStatus as Sample,
  '_agnes/v1/jobs.cancel': AGNES_SAMPLES.Empty as Sample,
  '_agnes/v1/artifact.job.status': AGNES_SAMPLES.ArtifactJob as Sample,
  '_agnes/v1/artifact.read': AGNES_SAMPLES.ArtifactReadResult as Sample,
  '_agnes/v1/ext.ui.response': AGNES_SAMPLES.SeqResult as Sample,
  '_agnes/v1/directory.upsert': AGNES_SAMPLES.DirectoryUpsertResult as Sample,
}

describe('request media structural schema versus semantic validator boundary', () => {
  const structuralOnly = [
    { ...requestMediaOk, selectionOrder: [2] },
    { ...requestMediaOk, selectionOrder: [] },
    {
      ...requestMediaOk,
      manifest: [
        requestMediaManifestOk[0],
        { ...requestMediaManifestEntryOk, artifactUri: `artifact://${'d'.repeat(64)}` },
      ],
    },
    {
      ...requestMediaOk,
      manifest: [
        requestMediaManifestOk[0],
        { ...requestMediaManifestEntryOk, selected: true, reason: 'unsupported' },
      ],
    },
    { ...requestMediaOk, route: 'text-only' },
  ]

  it('documents that AJV and generated TypeBox cannot enforce the cross-field invariants', () => {
    const ajvCheck = ajvDef(SESSION_ID, 'RequestMediaHeader')
    for (const value of structuralOnly) {
      expect(ajvCheck(value)).toBe(true)
      expect(Value.Check(SessionGen.RequestMediaHeader, value)).toBe(true)
      expect(validateRequestMedia(value).ok).toBe(false)
    }
  })
})

describe('METHODS table: validateMethod ↔ ajv parity per method (params + result)', () => {
  for (const name of Object.keys(METHODS) as MethodName[]) {
    const def = METHOD_DEF[name]
    const paramsSample = METHOD_PARAMS_SAMPLE[name]
    it(`${name} params: validateMethod and ajv agree`, () => {
      const check = ajvDef(def.fileId, def.params)
      expect(validateMethod(name, 'params', paramsSample.valid).ok).toBe(true)
      expect(check(paramsSample.valid)).toBe(true)
      for (const bad of paramsSample.invalid) {
        expect(validateMethod(name, 'params', bad).ok, `validateMethod ${name} params ${preview(bad)}`).toBe(
          false,
        )
        expect(check(bad), `ajv ${name} params ${preview(bad)}`).toBe(false)
      }
    })
    if (def.result) {
      const resultSample = METHOD_RESULT_SAMPLE[name]
      it(`${name} result: validateMethod and ajv agree`, () => {
        if (!resultSample) throw new Error(`no result sample registered for ${name}`)
        const check = ajvDef(def.fileId, def.result as string)
        expect(validateMethod(name, 'result', resultSample.valid).ok).toBe(true)
        expect(check(resultSample.valid)).toBe(true)
        for (const bad of resultSample.invalid) {
          expect(
            validateMethod(name, 'result', bad).ok,
            `validateMethod ${name} result ${preview(bad)}`,
          ).toBe(false)
          expect(check(bad), `ajv ${name} result ${preview(bad)}`).toBe(false)
        }
      })
    } else {
      it(`${name} has no result (notification)`, () => {
        // METHODS is built from per-entry literals with `satisfies MethodSpec`, so the literal type of
        // a notification entry has no `result` key at all — not "present but undefined". Read it
        // through MethodSpec's public shape rather than through one entry's narrow literal type.
        const spec = METHODS[name] as unknown as { result?: unknown }
        expect(spec.result).toBeUndefined()
      })
    }
  }
})

// ---------------------------------------------------------------------------
// Coverage drift guards. The three hand-written Records are the sole source of coverage, and nothing
// previously kept them in sync with the schemas: adding a $def to a schema and forgetting to register
// it here silently left one entry uncovered — demonstrated with a `ZzzNewDef` probe. These guards
// compare **both directions** as sets for the two self-owned schemas, and on the ACP side compare
// against both the "definitions used by this repo" line of UPSTREAM.md and the names METHOD_DEF
// actually references.
// Precedent: DATA_DEFS in src/validate.ts has long carried a "read the schema directly and check"
// assertion; this follows the same approach.

function defNamesOf(doc: Json): string[] {
  return Object.keys(doc.$defs as Json).sort()
}

describe('coverage drift guards', () => {
  it('SESSION_DEFS covers exactly schema/session-v1.json $defs (both directions)', () => {
    expect(Object.keys(SESSION_DEFS).sort()).toEqual(defNamesOf(sessionSchemaDoc))
  })
  it('AGNES_DEFS covers exactly schema/agnes-v1.json $defs (both directions)', () => {
    expect(Object.keys(AGNES_DEFS).sort()).toEqual(defNamesOf(agnesSchemaDoc))
  })
  it('MODEL_DEFS covers exactly schema/model.json $defs (both directions)', () => {
    expect(Object.keys(MODEL_DEFS).sort()).toEqual(defNamesOf(modelSchemaDoc))
  })
  it('TOOLDEF_DEFS covers exactly schema/tooldef.json $defs (both directions)', () => {
    expect(Object.keys(TOOLDEF_DEFS).sort()).toEqual(defNamesOf(toolDefSchemaDoc))
  })
  it('HOOKS_DEFS covers exactly schema/hooks.json $defs (both directions)', () => {
    expect(Object.keys(HOOKS_DEFS).sort()).toEqual(defNamesOf(hooksSchemaDoc))
  })
  it('SLOTS_DEFS covers exactly schema/slots.json $defs (both directions)', () => {
    expect(Object.keys(SLOTS_DEFS).sort()).toEqual(defNamesOf(slotsSchemaDoc))
  })
  it('SESSION_SAMPLES covers exactly SESSION_DEFS (both directions)', () => {
    expect(Object.keys(SESSION_SAMPLES).sort()).toEqual(Object.keys(SESSION_DEFS).sort())
  })
  it('AGNES_SAMPLES covers exactly AGNES_DEFS (both directions)', () => {
    expect(Object.keys(AGNES_SAMPLES).sort()).toEqual(Object.keys(AGNES_DEFS).sort())
  })
  it('MODEL_SAMPLES covers exactly MODEL_DEFS (both directions)', () => {
    expect(Object.keys(MODEL_SAMPLES).sort()).toEqual(Object.keys(MODEL_DEFS).sort())
  })
  it('TOOLDEF_SAMPLES covers exactly TOOLDEF_DEFS (both directions)', () => {
    expect(Object.keys(TOOLDEF_SAMPLES).sort()).toEqual(Object.keys(TOOLDEF_DEFS).sort())
  })
  it('HOOKS_SAMPLES covers exactly HOOKS_DEFS (both directions)', () => {
    expect(Object.keys(HOOKS_SAMPLES).sort()).toEqual(Object.keys(HOOKS_DEFS).sort())
  })
  it('SLOTS_SAMPLES covers exactly SLOTS_DEFS (both directions)', () => {
    expect(Object.keys(SLOTS_SAMPLES).sort()).toEqual(Object.keys(SLOTS_DEFS).sort())
  })
  it('ACP_SAMPLES covers exactly ACP_DEFS (both directions)', () => {
    expect(Object.keys(ACP_SAMPLES).sort()).toEqual(Object.keys(ACP_DEFS).sort())
  })
  it('FORMAT_SAMPLES covers exactly FORMAT_DEFS (both directions)', () => {
    expect(Object.keys(FORMAT_SAMPLES).sort()).toEqual(Object.keys(FORMAT_DEFS).sort())
  })
  it('ACP_DEFS matches UPSTREAM.md "definitions used by this repo"', () => {
    const line = acpUpstreamMd.split('\n').find((l) => l.includes('definitions used by this repo'))
    expect(line, 'no "definitions used by this repo" line found in UPSTREAM.md').toBeDefined()
    const names = String(line)
      .split(':')
      .slice(1)
      .join(':')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z][A-Za-z0-9]*$/.test(s))
    expect(names.slice().sort()).toEqual(Object.keys(ACP_DEFS).sort())
  })
  it('ACP_DEFS matches the ACP definitions METHOD_DEF actually references', () => {
    const referenced = new Set<string>()
    for (const def of Object.values(METHOD_DEF)) {
      if (def.fileId !== ACP_ID) continue
      referenced.add(def.params)
      if (def.result) referenced.add(def.result)
    }
    expect([...referenced].sort()).toEqual(Object.keys(ACP_DEFS).sort())
  })
  it('every $def in every self-owned schema doc compiles on the ajv side', () => {
    for (const [, doc, id] of SELF_OWNED_DOCS)
      for (const name of defNamesOf(doc)) expect(ajvDef(id, name), name).toBeTypeOf('function')
  })

  // The three guards above name their document by hand, so **adding a fourth self-owned schema
  // document would have been covered by nothing at all** — which is exactly what happened when
  // model.json was added: the whole suite stayed green while none of its 21 $defs was compared.
  // This case reads the schema directory instead, so a new document has to be registered in
  // SELF_OWNED_DOCS (and therefore given a $defs table and samples) before the suite goes green.
  // The vendored acp/ subtree is excluded: it is an upstream asset covered by ACP_DEFS, which is
  // deliberately the 10 referenced definitions rather than all 170.
  it('every self-owned schema document on disk is registered for comparison', () => {
    const onDisk = readdirSync(`${pkgRoot}schema`)
      .filter((e) => e.endsWith('.json'))
      .sort()
    expect(onDisk).toEqual(SELF_OWNED_DOCS.map(([file]) => file).sort())
  })

  // Registration alone still proved nothing: a document could be listed in SELF_OWNED_DOCS and given
  // no $defs table and no samples, and the suite stayed green because every table-to-schema
  // comparison names its document by hand. This case closes the chain generically — for whatever is
  // registered, the $defs table and the sample table must each cover the document's $defs exactly, in
  // both directions. Together with the runParity loop being driven from the same list, and with each
  // registered $def owing at least one negative sample, registration is now what forces a document to
  // be compared rather than merely tabulated.
  it('every registered document has a $defs table and a sample table covering its $defs', () => {
    for (const [file, doc, id, samples] of SELF_OWNED_DOCS) {
      const names = defNamesOf(doc)
      expect(names.length, `${file} declares no $defs`).toBeGreaterThan(0)
      const defs = DEFS_BY_FILE[id]
      expect(defs, `${file} has no entry in DEFS_BY_FILE`).toBeDefined()
      expect(Object.keys(defs as Record<string, TSchema>).sort(), `${file} $defs table`).toEqual(names)
      expect(Object.keys(samples).sort(), `${file} sample table`).toEqual(names)
    }
  })
})

// METHOD_DEF used to restate the "method → schema name" mapping with nothing forcing it to agree with
// src/methods.ts. Once the two drifted — someone repointing session/prompt at a different definition —
// the comparison would check the **old** ajv schema against validateMethod's **new** result, and quite
// possibly still pass because the shapes are similar. This identity assertion pins the two together.
describe('METHOD_DEF ↔ src/methods.ts METHODS (no restated mapping drift)', () => {
  it('covers exactly the METHODS keys (both directions)', () => {
    expect(Object.keys(METHOD_DEF).sort()).toEqual(Object.keys(METHODS).sort())
  })
  for (const name of Object.keys(METHODS) as MethodName[]) {
    it(`${name}: METHOD_DEF names the same TSchema objects METHODS holds`, () => {
      const def = METHOD_DEF[name]
      const spec: MethodSpec = METHODS[name]
      const table = DEFS_BY_FILE[def.fileId]
      expect(table, `unknown fileId ${def.fileId}`).toBeDefined()
      expect((table as Record<string, TSchema>)[def.params]).toBe(spec.params)
      if (def.result) expect((table as Record<string, TSchema>)[def.result]).toBe(spec.result)
      else expect(spec.result).toBeUndefined()
    })
  }
})

// Zombie-entry guard: every KNOWN_DIFFS entry must actually be hit by one of the samples above.
// Leaving an entry that can never take effect writes yourself a blank cheque ("we already handled that
// difference") and is just as harmful as deleting an entry.
describe('KNOWN_DIFFS table hygiene', () => {
  it('every registered difference is reachable from a registered sample', () => {
    const orphans = KNOWN_DIFFS.filter((_, i) => !usedDiffs.has(i)).map(
      (d) => `${d.scope}#${d.def} ${preview(d.sample)}`,
    )
    expect(orphans, 'KNOWN_DIFFS entries not hit by any sample (zombie entries)').toEqual([])
  })
  it('every registered difference is an actual divergence (ajv ≠ typebox)', () => {
    for (const d of KNOWN_DIFFS)
      expect(
        d.ajv,
        `${d.scope}#${d.def}: both registered verdicts are equal, so it does not belong in this table`,
      ).not.toBe(d.typebox)
  })
})

describe('every Task20 language-neutral positive and negative has actual Ajv/TypeBox parity', () => {
  it.each(task20Fixtures)('$id', (row) => {
    // A method schema may expose an honest cross-file `$ref` alias (for example agnes-v1's
    // JobSpec), so definition names are no longer globally unique. Task20 owns the defining config
    // document: exclude ref-only aliases and compare its fixtures against the concrete definition.
    const found = SELF_OWNED_DOCS.filter(([, doc]) => {
      const definition = (doc.$defs as Json)[row.name]
      return (
        definition !== undefined &&
        !(typeof definition === 'object' && definition !== null && '$ref' in definition)
      )
    })
    expect(found).toHaveLength(1)
    const [, , id] = found[0] as [string, Json, string, Record<string, Sample>]
    const schema = DEFS_BY_FILE[id]?.[row.name]
    if (!schema) throw new Error(`missing generated schema ${row.name}`)
    const want = row.kind === 'valid'
    // Exact known reference-library defects still assert both concrete verdicts. The public
    // validator suite independently requires every invalid row to be rejected.
    assertParity({ schema, check: ajvDef(id, row.name) }, id, row.name, row.payload, want)
  })
})

describe('Task21 language-neutral public-validator fixture parity', () => {
  const rows = loadJsonl(`${pkgRoot}fixtures/configs/task21.jsonl`) as Array<
    FixtureRow & { name: string; kind: string }
  >
  it.each(rows)('$id', (row) => {
    const name =
      row.name === 'BridgeFrame'
        ? row.payload && typeof row.payload === 'object' && 'method' in row.payload
          ? 'BridgeRequest'
          : 'BridgeResponse'
        : row.name
    const doc =
      row.name === 'BridgeFrame'
        ? 'bridge'
        : ['Actor', 'Action', 'Target', 'Decision'].includes(name)
          ? 'authz'
          : 'channel'
    const id = `https://agnes.ai/schema/${doc}.json`
    const schema = DEFS_BY_FILE[id]?.[name]
    if (!schema) throw new Error(`missing schema ${doc}.${name}`)
    assertParity({ schema, check: ajvDef(id, name) }, id, name, row.payload, row.kind === 'valid')
  })
})

describe('non-tool approval continuation parity', () => {
  it.each([
    { label: 'no tool', continues: { turn: 1, step: 1, requestId: 'review' }, valid: true },
    { label: 'legacy tool', continues: { turn: 1, step: 1, toolUseId: 'call' }, valid: true },
    { label: 'invalid tool id', continues: { turn: 1, step: 1, toolUseId: 1 }, valid: false },
  ])('$label', ({ continues, valid }) => {
    const schema = SESSION_DEFS.TurnStart
    if (!schema) throw new Error('missing TurnStart schema')
    assertParity(
      { schema, check: ajvDef(SESSION_ID, 'TurnStart') },
      SESSION_ID,
      'TurnStart',
      { turn: 2, trigger: 'approval-resume', continues },
      valid,
    )
  })
})

describe('F1 Surface fixture differential checks', () => {
  for (const row of loadJsonl(`${pkgRoot}fixtures/surface/surface.jsonl`) as (FixtureRow & {
    name: string
    kind: string
  })[]) {
    const file =
      row.name === 'Lockfile' ? 'lockfile' : row.name === 'DeployManifest' ? 'deploy-manifest' : 'surface'
    const id = `https://agnes.ai/schema/${file}.json`
    const schema = DEFS_BY_FILE[id]?.[row.name]
    if (!schema) throw new Error(`missing F1 schema ${row.name}`)
    it(row.id, () =>
      assertParity({ schema, check: ajvDef(id, row.name) }, id, row.name, row.payload, row.kind === 'valid'),
    )
  }
})

describe('P1 Projection schema differential checks', () => {
  const definitions = {
    ProjectionCapability: ProjectionGen.ProjectionCapability,
    ProjectionReadResult: ProjectionGen.ProjectionReadResult,
  }
  for (const row of loadJsonl(`${pkgRoot}fixtures/projection/projection.jsonl`) as (FixtureRow & {
    name: string
    kind: string
  })[]) {
    if (!(row.name in definitions)) continue
    it(row.id, () => {
      const schema = definitions[row.name as keyof typeof definitions]
      const expected = row.kind === 'valid'
      expect(ajvDef('https://agnes.ai/schema/projection.json', row.name)(row.payload)).toBe(expected)
      expect(Value.Check(schema, row.payload)).toBe(expected)
    })
  }
})

describe('PM4 every fixture compares production, generated TypeBox and AJV', () => {
  for (const row of PackageAdminRows)
    it(row.id, () => {
      const method = row.target === 'method' ? METHOD_DEF[row.name as MethodName] : undefined
      const name = method ? (row.side === 'params' ? method.params : method.result) : row.name
      const id = method
        ? // Package-admin methods own their DTOs in package-admin.json; only the core ACP methods
          // are re-exported through agnes-v1.json. Keeping this distinction here prevents a new
          // private package BFF DTO from being incorrectly promoted to the core protocol surface.
          method.fileId === 'https://agnes.ai/schema/package-admin.json'
          ? method.fileId
          : AGNES_ID
        : row.name === 'Lockfile'
          ? 'https://agnes.ai/schema/lockfile.json'
          : row.name === 'ExtensionManifest'
            ? 'https://agnes.ai/schema/extension-manifest.json'
            : 'https://agnes.ai/schema/package-admin.json'
      if (!name) throw new Error('missing definition')
      const schema = DEFS_BY_FILE[id]?.[name]
      if (!schema) throw new Error('missing schema')
      const expected = row.kind === 'valid'
      expect(validateAgainst(schema, row.payload).ok).toBe(expected)
      expect(ajvDef(id, name)(row.payload)).toBe(expected)
    })
})

describe('UITurn.trace is optional', () => {
  const usage = {
    totals: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1 },
    reasoningComplete: true,
    billingComplete: false,
    calls: [],
  }
  const turn = {
    id: 'turn:1',
    turn: 1,
    startSeq: 2,
    startedAt: '2026-09-17T00:00:00.000Z',
    status: 'completed' as const,
    nodeIds: [] as string[],
    usage,
    inherited: false,
    forkable: true,
  }
  const trace = {
    id: 'turn:1',
    kind: 'turn' as const,
    name: 'Turn 1',
    status: 'completed' as const,
    startSeq: 2,
    startedAt: '2026-09-17T00:00:00.000Z',
    children: [],
  }

  it('accepts a turn without trace', () => {
    expect(validateAgainst(AgnesGen.UITurn, turn).ok).toBe(true)
  })

  it('accepts a turn with a well-formed trace tree', () => {
    expect(validateAgainst(AgnesGen.UITurn, { ...turn, trace }).ok).toBe(true)
  })

  it('rejects an unknown span kind', () => {
    expect(validateAgainst(AgnesGen.UISpan, { ...trace, kind: 'span' }).ok).toBe(false)
  })
})
