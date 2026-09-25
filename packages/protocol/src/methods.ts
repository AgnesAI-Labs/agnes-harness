import type { TSchema } from '@sinclair/typebox'
import * as Acp from '../gen/ts/acp.js'
import * as A from '../gen/ts/agnes-v1.js'
import {
  PACKAGE_ADMIN_METHODS,
  type PackageAdminAccessPolicy,
  type PackageAdminMethodName,
  validatePackageAdminCall,
} from './package-admin.js'
import {
  RESOURCE_CONTROL_METHODS,
  type ResourceControlAccessPolicy,
  type ResourceControlMethodName,
  validateResourceControlCall,
} from './resource-control.js'
import { validateExtensionCall } from './services.js'
import { type ValidationResult, validateAgainst } from './validate.js'

export type MethodSpec = {
  kind: 'request' | 'notification'
  direction: 'c2s' | 's2c'
  params: TSchema
  result?: TSchema
  administration?: PackageAdminAccessPolicy | ResourceControlAccessPolicy
}

const clientRequest = (params: TSchema, result: TSchema): MethodSpec => ({
  kind: 'request',
  direction: 'c2s',
  params,
  result,
})

// ACP definition names follow the actual names recorded on the "definitions used by this repo" line
// of schema/acp/UPSTREAM.md (checked with `jq`, one for one against this file). If a name diverges
// because upstream renamed it, change this file and UPSTREAM.md — never the vendored `schema.json`.
// Written out rather than derived as `keyof typeof METHODS`. Seven more entries, three of them
// carrying the largest vendored ACP definitions, put the inferred type of the table past the length
// tsc will serialize into a declaration file (TS7056), and the fix that error asks for is an explicit
// annotation on the table. The annotation below then checks this union in both directions at compile
// time: a name here with no entry is a missing property, and an entry whose name is not here is an
// excess property on the object literal. The runtime key list in test/methods.test.ts pins the same
// set a third way.
export type MethodName =
  | PackageAdminMethodName
  | ResourceControlMethodName
  | '_agnes/v1/extension.ack'
  | '_agnes/v1/extension.call'
  | '_agnes/v1/config.get'
  | '_agnes/v1/config.oauth'
  | '_agnes/v1/config.providers'
  | '_agnes/v1/config.test'
  | '_agnes/v1/config.save'
  | '_agnes/v1/config.account'
  | '_agnes/v1/computerUse.status'
  | '_agnes/v1/computerUse.permissions.status'
  | '_agnes/v1/computerUse.permissions.grant'
  | '_agnes/v1/computerUse.doctor'
  | '_agnes/v1/computerUse.operation.start'
  | '_agnes/v1/computerUse.operation.status'
  | '_agnes/v1/computerUse.operation.cancel'
  | '_agnes/v1/approvalGrants.list'
  | '_agnes/v1/approvalGrants.revoke'
  | '_agnes/v1/artifact.read'
  | 'initialize'
  | 'session/new'
  | 'session/prompt'
  | 'session/cancel'
  | 'session/update'
  | 'session/request_permission'
  | '_agnes/v1/session.attach'
  | '_agnes/v1/session.steer'
  | '_agnes/v1/session.budget'
  | '_agnes/v1/session.projectUI'
  | '_agnes/v1/session.projectUIPatch'
  | '_agnes/v1/session.projectUIOpening'
  | '_agnes/v1/session.projectUIHistory'
  | '_agnes/v1/session.readToolDetail'
  | '_agnes/v1/session.followUp'
  | '_agnes/v1/session.fork'
  | '_agnes/v1/session.rename'
  | '_agnes/v1/session.archive'
  | '_agnes/v1/diagnostics.collect'
  | '_agnes/v1/diagnostics.events'
  | '_agnes/v1/session.list'
  | '_agnes/v1/workspace.list'
  | '_agnes/v1/workspace.add'
  | '_agnes/v1/session.setPreset'
  | '_agnes/v1/session.setModel'
  | '_agnes/v1/session.setYolo'
  | '_agnes/v1/approval.decide'
  | '_agnes/v1/participant.join'
  | '_agnes/v1/participant.leave'
  | '_agnes/v1/participant.list'
  | '_agnes/v1/jobs.enqueue'
  | '_agnes/v1/jobs.poll'
  | '_agnes/v1/jobs.cancel'
  | '_agnes/v1/artifact.job.status'
  | '_agnes/v1/ext.ui.response'
  | '_agnes/v1/directory.upsert'
  | '_agnes/v1/apis.list'
  | '_agnes/v1/submit'
  | '_agnes/v1/submit.ack'
  | '_agnes/v1/surfaces.mounts'
  | 'authenticate'
  | 'session/load'
  | 'session/set_mode'
  | '_agnes/v1/session.detach'
  | '_agnes/v1/auth.claim'
  | '_agnes/v1/session.event'
  | '_agnes/v1/session.preview'
  | '_agnes/v1/daemon.notice'

export const METHODS: Record<MethodName, MethodSpec> = {
  ...PACKAGE_ADMIN_METHODS,
  ...RESOURCE_CONTROL_METHODS,
  '_agnes/v1/extension.ack': clientRequest(A.ExtensionAckParams, A.Empty),
  '_agnes/v1/extension.call': clientRequest(A.ExtensionCallParams, A.ExtensionCallResult),
  '_agnes/v1/config.get': clientRequest(A.ConfigEmptyParams, A.ConfigSnapshot),
  '_agnes/v1/config.oauth': clientRequest(A.ConfigOAuthInput, A.ConfigOAuthResult),
  '_agnes/v1/config.providers': clientRequest(A.ConfigEmptyParams, A.ConfigProvidersResult),
  '_agnes/v1/config.test': clientRequest(A.ConfigTestInput, A.ConfigTestResult),
  '_agnes/v1/config.save': clientRequest(A.ConfigSaveInput, A.ConfigSnapshot),
  '_agnes/v1/config.account': clientRequest(A.ConfigAccountInput, A.ConfigSnapshot),
  '_agnes/v1/computerUse.status': clientRequest(A.Empty, A.ComputerUseStatusResult),
  '_agnes/v1/computerUse.permissions.status': clientRequest(A.Empty, A.ComputerUsePermissionsStatusResult),
  '_agnes/v1/computerUse.permissions.grant': clientRequest(A.Empty, A.ComputerUsePermissionsStatusResult),
  '_agnes/v1/computerUse.doctor': clientRequest(A.ComputerUseDoctorParams, A.ComputerUseDoctorResult),
  '_agnes/v1/computerUse.operation.start': clientRequest(
    A.ComputerUseOperationStartParams,
    A.ComputerUseOperationResult,
  ),
  '_agnes/v1/computerUse.operation.status': clientRequest(
    A.ComputerUseOperationStatusParams,
    A.ComputerUseOperationResult,
  ),
  '_agnes/v1/computerUse.operation.cancel': clientRequest(
    A.ComputerUseOperationIdParams,
    A.ComputerUseOperationResult,
  ),
  '_agnes/v1/approvalGrants.list': clientRequest(A.ApprovalGrantListParams, A.ApprovalGrantListResult),
  '_agnes/v1/approvalGrants.revoke': clientRequest(A.ApprovalGrantRevokeParams, A.ApprovalGrantRecord),
  '_agnes/v1/artifact.read': clientRequest(A.ArtifactReadParams, A.ArtifactReadResult),
  initialize: {
    kind: 'request',
    direction: 'c2s',
    params: Acp.InitializeRequest,
    result: Acp.InitializeResponse,
  },
  'session/new': {
    kind: 'request',
    direction: 'c2s',
    params: Acp.NewSessionRequest,
    result: Acp.NewSessionResponse,
  },
  'session/prompt': {
    kind: 'request',
    direction: 'c2s',
    params: Acp.PromptRequest,
    result: Acp.PromptResponse,
  },
  'session/cancel': { kind: 'notification', direction: 'c2s', params: Acp.CancelNotification },
  'session/update': { kind: 'notification', direction: 's2c', params: Acp.SessionNotification },
  'session/request_permission': {
    kind: 'request',
    direction: 's2c',
    params: Acp.RequestPermissionRequest,
    result: Acp.RequestPermissionResponse,
  },
  '_agnes/v1/session.attach': {
    kind: 'request',
    direction: 'c2s',
    params: A.SessionAttachParams,
    result: A.SessionAttachResult,
  },
  '_agnes/v1/session.steer': {
    kind: 'request',
    direction: 'c2s',
    params: A.SessionSteerParams,
    result: A.SessionSteerResult,
  },
  '_agnes/v1/session.budget': {
    kind: 'request',
    direction: 'c2s',
    params: A.SessionIdParams,
    result: A.SessionBudgetResult,
  },
  '_agnes/v1/session.projectUI': {
    kind: 'request',
    direction: 'c2s',
    params: A.SessionProjectUIParams,
    result: A.UITimeline,
  },
  '_agnes/v1/session.projectUIPatch': {
    kind: 'request',
    direction: 'c2s',
    params: A.SessionProjectUIPatchParams,
    result: A.UIProjectionUpdate,
  },
  '_agnes/v1/session.projectUIOpening': {
    kind: 'request',
    direction: 'c2s',
    params: A.SessionProjectUIOpeningParams,
    result: A.UIOpeningResult,
  },
  '_agnes/v1/session.projectUIHistory': {
    kind: 'request',
    direction: 'c2s',
    params: A.SessionProjectUIHistoryParams,
    result: A.UIHistoryPage,
  },
  '_agnes/v1/session.readToolDetail': clientRequest(
    A.SessionReadToolDetailParams,
    A.SessionReadToolDetailResult,
  ),
  '_agnes/v1/session.followUp': {
    kind: 'request',
    direction: 'c2s',
    params: A.SessionSteerParams,
    result: A.SessionSteerResult,
  },
  '_agnes/v1/session.fork': {
    kind: 'request',
    direction: 'c2s',
    params: A.SessionForkParams,
    result: A.SessionIdParams,
  },
  '_agnes/v1/session.rename': clientRequest(A.SessionRenameParams, A.SessionPreferences),
  '_agnes/v1/session.archive': clientRequest(A.SessionArchiveParams, A.SessionPreferences),
  '_agnes/v1/diagnostics.collect': clientRequest(A.DiagnosticsCollectParams, A.DiagnosticsCollectResult),
  '_agnes/v1/diagnostics.events': clientRequest(A.DiagnosticsEventsParams, A.DiagnosticsEventsResult),
  '_agnes/v1/session.list': {
    kind: 'request',
    direction: 'c2s',
    params: A.SessionListParams,
    result: A.PageSessionMeta,
  },
  '_agnes/v1/workspace.list': clientRequest(A.WorkspaceListParams, A.WorkspaceListResult),
  '_agnes/v1/workspace.add': clientRequest(A.WorkspaceAddParams, A.WorkspaceAddResult),
  '_agnes/v1/session.setPreset': {
    kind: 'request',
    direction: 'c2s',
    params: A.SessionSetPresetParams,
    result: A.EffectiveFromResult,
  },
  '_agnes/v1/session.setModel': {
    kind: 'request',
    direction: 'c2s',
    params: A.SessionSetModelParams,
    result: A.EffectiveFromResult,
  },
  '_agnes/v1/session.setYolo': clientRequest(A.SessionSetYoloParams, A.EffectiveFromResult),
  '_agnes/v1/approval.decide': clientRequest(A.ApprovalDecideParams, A.SeqResult),
  '_agnes/v1/participant.join': clientRequest(A.ParticipantParams, A.SeqResult),
  '_agnes/v1/participant.leave': clientRequest(A.ParticipantParams, A.SeqResult),
  '_agnes/v1/participant.list': clientRequest(A.SessionIdParams, A.ParticipantListResult),
  '_agnes/v1/jobs.enqueue': clientRequest(A.JobSpec, A.JobIdResult),
  '_agnes/v1/jobs.poll': clientRequest(A.JobIdParams, A.JobStatus),
  '_agnes/v1/jobs.cancel': clientRequest(A.JobIdParams, A.Empty),
  '_agnes/v1/artifact.job.status': clientRequest(A.JobIdParams, A.ArtifactJob),
  '_agnes/v1/ext.ui.response': clientRequest(A.ExtUiResponseParams, A.SeqResult),
  '_agnes/v1/directory.upsert': clientRequest(A.DirectoryUpsertParams, A.DirectoryUpsertResult),
  '_agnes/v1/apis.list': {
    kind: 'request',
    direction: 'c2s',
    params: A.ApisListParams,
    result: A.ApisListResult,
  },
  '_agnes/v1/submit': { kind: 'request', direction: 'c2s', params: A.SubmitParams, result: A.Ack },
  '_agnes/v1/submit.ack': {
    kind: 'request',
    direction: 'c2s',
    params: A.CommandAckParams,
    result: A.Empty,
  },
  // Read-only Surface mount->endpoint table, consulted by the CLI/Web OS process (`agnes serve`) to
  // bridge createMountProxy's lookup() across the process boundary to `agnesd` (see
  // packages/daemon/src/local/methods/surfaces.ts and packages/cli/launch/web-command.ts). No
  // authKind restriction beyond LocalEndpoint's own initialize gate, same as workspace.list/add.
  '_agnes/v1/surfaces.mounts': clientRequest(A.SurfacesMountsParams, A.SurfacesMountsResult),
  // Pulled forward from I3. daemon's dispatcher answers -32601 from this table before it reaches any
  // handler, so a method daemon registers and this table omits is unreachable rather than merely
  // unvalidated.
  authenticate: {
    kind: 'request',
    direction: 'c2s',
    params: Acp.AuthenticateRequest,
    result: Acp.AuthenticateResponse,
  },
  'session/load': {
    kind: 'request',
    direction: 'c2s',
    params: Acp.LoadSessionRequest,
    result: Acp.LoadSessionResponse,
  },
  'session/set_mode': {
    kind: 'request',
    direction: 'c2s',
    params: Acp.SetSessionModeRequest,
    result: Acp.SetSessionModeResponse,
  },
  '_agnes/v1/session.detach': {
    kind: 'request',
    direction: 'c2s',
    params: A.SessionIdParams,
    result: A.Empty,
  },
  '_agnes/v1/auth.claim': {
    kind: 'request',
    direction: 'c2s',
    params: A.AuthClaimParams,
    result: A.AuthClaimResult,
  },
  // Outbound only. Their params are consulted on both sides: a client validating what it receives
  // reads them, so does the conformance runner, and so does the server before it puts the frame on
  // the wire - daemon's LocalEndpoint refuses an s2c frame this table's schema rejects.
  '_agnes/v1/session.event': { kind: 'notification', direction: 's2c', params: A.SessionEventParams },
  '_agnes/v1/session.preview': { kind: 'notification', direction: 's2c', params: A.SessionPreviewParams },
  '_agnes/v1/daemon.notice': { kind: 'notification', direction: 's2c', params: A.DaemonNotice },
}

export function validateMethod(
  name: MethodName,
  side: 'params' | 'result',
  x: unknown,
): ValidationResult<unknown> {
  if (Object.hasOwn(PACKAGE_ADMIN_METHODS, name))
    return validatePackageAdminCall(name as PackageAdminMethodName, side, x)
  if (Object.hasOwn(RESOURCE_CONTROL_METHODS, name))
    return validateResourceControlCall(name as ResourceControlMethodName, side, x)
  if (name === '_agnes/v1/extension.call') return validateExtensionCall(side, x)
  const spec: MethodSpec = METHODS[name]
  const schema = side === 'params' ? spec.params : spec.result
  if (!schema) return { ok: false, errors: [{ path: '', message: `${name} has no ${side}`, code: 'OTHER' }] }
  return validateAgainst(schema, x)
}
