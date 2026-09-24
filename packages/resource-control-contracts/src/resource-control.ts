import type { TSchema } from '@sinclair/typebox'
import { Value, type ValueError, ValueErrorType } from '@sinclair/typebox/value'
import * as R from './gen/resource-control.js'

export type ValidationError = {
  path: string
  message: string
  code: 'UNKNOWN_KEY' | 'MISSING' | 'TYPE' | 'ENUM' | 'PATTERN' | 'RANGE' | 'OTHER'
  key?: string
}
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] }

const jsonData = (value: unknown, maxBytes = 1048576): { ok: true; value: unknown } | { ok: false } => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { ok: false }
  const active = new Set<object>()
  const walk = (item: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error('nesting exceeds 32')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
    if (typeof item === 'number') {
      if (Number.isFinite(item)) return item
      throw new Error('non-finite number')
    }
    if (typeof item !== 'object' || active.has(item)) throw new Error('not data')
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype)
      throw new Error('non-plain object')
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (Object.getOwnPropertySymbols(item).length) throw new Error('symbol key')
    active.add(item)
    const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null)
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('non-data property')
      Object.defineProperty(result, key, { value: walk(descriptor.value, depth + 1), enumerable: true })
    }
    active.delete(item)
    return result
  }
  try {
    const snapshot = walk(value, 0)
    return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <= maxBytes
      ? { ok: true, value: snapshot }
      : { ok: false }
  } catch {
    return { ok: false }
  }
}

const classify = (error: ValueError): ValidationError => {
  const key = error.path.split('/').pop() || undefined
  if (error.type === ValueErrorType.ObjectRequiredProperty)
    return {
      path: key ? error.path.slice(0, -key.length - 1) : error.path,
      message: error.message,
      code: 'MISSING',
      ...(key ? { key } : {}),
    }
  const base = { path: error.path, message: error.message, ...(key ? { key } : {}) }
  if (error.type === ValueErrorType.ObjectAdditionalProperties) return { ...base, code: 'UNKNOWN_KEY' }
  if (error.type === ValueErrorType.Union || error.type === ValueErrorType.Literal)
    return { ...base, code: 'ENUM' }
  if (error.type === ValueErrorType.StringPattern || error.type === ValueErrorType.StringFormat)
    return { ...base, code: 'PATTERN' }
  if (
    [
      ValueErrorType.StringMinLength,
      ValueErrorType.StringMaxLength,
      ValueErrorType.NumberMinimum,
      ValueErrorType.NumberMaximum,
      ValueErrorType.IntegerMinimum,
      ValueErrorType.IntegerMaximum,
      ValueErrorType.IntegerExclusiveMinimum,
      ValueErrorType.IntegerExclusiveMaximum,
      ValueErrorType.NumberExclusiveMinimum,
      ValueErrorType.NumberExclusiveMaximum,
      ValueErrorType.ArrayMinItems,
      ValueErrorType.ArrayMaxItems,
    ].includes(error.type)
  )
    return { ...base, code: 'RANGE' }
  if (
    [
      ValueErrorType.Null,
      ValueErrorType.String,
      ValueErrorType.Number,
      ValueErrorType.Integer,
      ValueErrorType.Boolean,
      ValueErrorType.Object,
      ValueErrorType.Array,
    ].includes(error.type)
  )
    return { ...base, code: 'TYPE' }
  return { ...base, code: 'OTHER' }
}

const validate = (schema: TSchema, value: unknown): ValidationResult<unknown> => {
  if (Value.Check(schema, value)) return { ok: true, value }
  const errors = [...Value.Errors(schema, value)].map(classify)
  return { ok: false, errors: errors.length ? errors : [{ path: '', message: 'invalid', code: 'OTHER' }] }
}

export const RESOURCE_CONTROL_PERMISSIONS = Object.freeze([
  'resources.read',
  'resources.skills.write',
  'resources.reconcile',
  'skills.refresh',
  'skills.trust',
  'mcp.read',
  'mcp.tools.read',
  'mcp.manage',
  'mcp.trust',
  'mcp.test',
  'mcp.activate',
  'mcp.reconnect',
  'secrets.use',
] as const)

export type ResourceControlAccessPolicy = Readonly<{
  execution: 'read' | 'effect' | 'unblock'
  permission: R.ResourcePermission
  identity: 'none' | 'principal-client-command'
}>

const contract = (
  params: TSchema,
  result: TSchema,
  execution: ResourceControlAccessPolicy['execution'],
  permission: R.ResourcePermission,
) =>
  Object.freeze({
    kind: 'request' as const,
    direction: 'c2s' as const,
    params,
    result,
    administration: Object.freeze({
      execution,
      permission,
      identity: execution === 'read' ? ('none' as const) : ('principal-client-command' as const),
    }),
  })

export const RESOURCE_CONTROL_METHODS = Object.freeze({
  '_agnes/v1/resources.list': contract(R.ResourceListParams, R.ResourceListResult, 'read', 'resources.read'),
  '_agnes/v1/resources.get': contract(R.ResourceGetParams, R.ResourceDescriptor, 'read', 'resources.read'),
  '_agnes/v1/resources.desired.set': contract(
    R.ResourceDesiredSetParams,
    R.ResourceOperationReceipt,
    'effect',
    'resources.skills.write',
  ),
  '_agnes/v1/resources.operation.get': contract(
    R.ResourceOperationGetParams,
    R.ResourceOperation,
    'read',
    'resources.read',
  ),
  '_agnes/v1/resources.operation.cancel': contract(
    R.ResourceOperationCancelParams,
    R.ResourceOperationReceipt,
    'unblock',
    'resources.reconcile',
  ),
  '_agnes/v1/skills.refresh': contract(
    R.SkillRefreshParams,
    R.ResourceOperationReceipt,
    'effect',
    'skills.refresh',
  ),
  '_agnes/v1/skills.remove': contract(
    R.SkillRemoveParams,
    R.ResourceOperationReceipt,
    'effect',
    'resources.skills.write',
  ),
  '_agnes/v1/skills.priority.set': contract(
    R.SkillPrioritySetParams,
    R.ResourceOperationReceipt,
    'effect',
    'resources.skills.write',
  ),
  '_agnes/v1/skills.trust.set': contract(
    R.SkillTrustSetParams,
    R.ResourceOperationReceipt,
    'effect',
    'skills.trust',
  ),
  '_agnes/v1/mcp.servers.list': contract(R.McpServerListParams, R.McpServerListResult, 'read', 'mcp.read'),
  '_agnes/v1/mcp.servers.get': contract(R.McpServerGetParams, R.McpServerDescriptor, 'read', 'mcp.read'),
  '_agnes/v1/mcp.servers.status': contract(R.McpServerGetParams, R.McpStatus, 'read', 'mcp.read'),
  '_agnes/v1/mcp.servers.tools.list': contract(
    R.McpToolsListParams,
    R.McpToolCatalogPage,
    'read',
    'mcp.tools.read',
  ),
  '_agnes/v1/mcp.servers.create': contract(
    R.McpServerCreateParams,
    R.ResourceOperationReceipt,
    'effect',
    'mcp.manage',
  ),
  '_agnes/v1/mcp.servers.update': contract(
    R.McpServerUpdateParams,
    R.ResourceOperationReceipt,
    'effect',
    'mcp.manage',
  ),
  '_agnes/v1/mcp.servers.remove': contract(
    R.McpServerRemoveParams,
    R.ResourceOperationReceipt,
    'effect',
    'mcp.manage',
  ),
  '_agnes/v1/mcp.servers.trust.set': contract(
    R.McpTrustSetParams,
    R.ResourceOperationReceipt,
    'effect',
    'mcp.trust',
  ),
  '_agnes/v1/mcp.servers.test': contract(
    R.McpServerTestParams,
    R.ResourceOperationReceipt,
    'effect',
    'mcp.test',
  ),
  '_agnes/v1/mcp.servers.enable': contract(
    R.McpServerEnableParams,
    R.ResourceOperationReceipt,
    'effect',
    'mcp.activate',
  ),
  '_agnes/v1/mcp.servers.disable': contract(
    R.McpServerDisableParams,
    R.ResourceOperationReceipt,
    'effect',
    'mcp.activate',
  ),
  '_agnes/v1/mcp.servers.reconnect': contract(
    R.McpServerReconnectParams,
    R.ResourceOperationReceipt,
    'effect',
    'mcp.reconnect',
  ),
  // Pure durable-journal read: mirrors '_agnes/v1/mcp.servers.status' exactly (same params type,
  // same 'read'/'mcp.read' pairing) - it is the same kind of operation, just projecting a narrower
  // slice (authorizationStatus/lastSafeError) of the same descriptor mcp.servers.get already
  // returns in full. See McpResourceStore.call() in resource-control-store for the read path.
  '_agnes/v1/mcp.servers.oauth.status': contract(
    R.McpServerGetParams,
    R.McpOAuthStatusResult,
    'read',
    'mcp.read',
  ),
  // Durable write, closing the gap the mcp-oauth-authorization plan's Task 4 deliberately left open
  // (oauth-http-handler.ts's `onAuthorizationStatus` hook): the daemon HTTP callback endpoint runs
  // in a different process than the daemon that owns this journal, so it cannot write
  // authorizationStatus directly - it calls this method over the same private Unix-socket transport
  // every other mcp.servers.* method already uses. 'mcp.manage' (not a new permission) because this
  // mutates the same server-level configuration surface create/update/remove already gate behind
  // it. Params deliberately omit clientId/commandId/expectedRevision: unlike trust.set/enable/
  // disable, this is never a browser-initiated, replay-sensitive command - its only caller is the
  // trusted local launcher process reporting the outcome of a flow it alone drove end to end, once,
  // synchronously after a real token exchange. See McpResourceStore's direct (non-effect()-pipeline)
  // dispatch for why it is still labelled 'effect' despite that: it genuinely mutates durable state,
  // which is what this label - and excluding it from the resource-admin BFF's read-only recovery
  // mode - is actually for; the unused 'principal-client-command' identity metadata is the one part
  // of the sibling convention this method does not literally satisfy, and administration.identity is
  // not read by any runtime code today (verified: only .execution and .permission are consumed).
  '_agnes/v1/mcp.servers.oauth.status.set': contract(
    R.McpOAuthStatusSetParams,
    R.McpOAuthStatusResult,
    'effect',
    'mcp.manage',
  ),
})
export type ResourceControlMethodName = keyof typeof RESOURCE_CONTROL_METHODS

/**
 * The method table holds only the primary permission. Daemon must additionally require
 * `secrets.use` for create/update/test when the persisted or submitted definition binds a SecretRef;
 * this helper intentionally cannot decide that payload-dependent condition.
 * Authority is authenticated server context; callers cannot place permissions in JSON params.
 */
export function canAccessResourceControl(
  method: ResourceControlMethodName,
  authority: { audience: string; permissions: readonly string[] },
): boolean {
  return (
    authority.audience === 'admin' &&
    Object.hasOwn(RESOURCE_CONTROL_METHODS, method) &&
    authority.permissions.includes(RESOURCE_CONTROL_METHODS[method].administration.permission)
  )
}

/**
 * Every resource DTO this package validates standalone. Spelled out rather than derived from the
 * mapping below: the inferred object type of that table exceeded TypeScript's declaration-emit
 * serialization ceiling (TS7056) once it grew, while a mapped Record over an explicit union stays
 * short — and annotating it also makes a missing entry a compile error.
 */
export type ResourceControlDataName =
  | 'ResourcePermission'
  | 'ProfileId'
  | 'ResourceId'
  | 'ServerId'
  | 'Revision'
  | 'CommandId'
  | 'ClientId'
  | 'SourceScope'
  | 'SkillRootKey'
  | 'SkillRootStatus'
  | 'WorkspaceId'
  | 'SkillSourceIdentity'
  | 'SkillResolution'
  | 'TrustState'
  | 'DesiredState'
  | 'ActualState'
  | 'SafeError'
  | 'SkillDescriptor'
  | 'McpEnvName'
  | 'McpStdioTransport'
  | 'McpHttpTransport'
  | 'McpSecretBinding'
  | 'McpToolPolicy'
  | 'McpServerDefinitionInput'
  | 'McpServerDescriptor'
  | 'McpServerListResult'
  | 'McpStatus'
  | 'McpTool'
  | 'McpToolCatalogPage'
  | 'ResourceOperationReceipt'
  | 'ResourceOperation'
  | 'ResourceDescriptor'
  | 'ResourceListParams'
  | 'ResourceListResult'
  | 'ResourceGetParams'
  | 'ResourceDesiredSetParams'
  | 'ResourceOperationGetParams'
  | 'ResourceOperationCancelParams'
  | 'SkillRefreshParams'
  | 'SkillTrustSetParams'
  | 'SkillRemoveParams'
  | 'SkillPrioritySetParams'
  | 'McpServerListParams'
  | 'McpServerGetParams'
  | 'McpServerCreateParams'
  | 'McpServerUpdateParams'
  | 'McpServerRemoveParams'
  | 'McpTrustSetParams'
  | 'McpServerTestParams'
  | 'McpServerEnableParams'
  | 'McpServerDisableParams'
  | 'McpServerReconnectParams'
  | 'McpToolsListParams'
  | 'McpOAuthStatusSetParams'
  | 'McpOAuthStatusResult'
const DATA_SCHEMAS: Record<ResourceControlDataName, TSchema> = {
  ResourcePermission: R.ResourcePermission,
  ProfileId: R.ProfileId,
  ResourceId: R.ResourceId,
  ServerId: R.ServerId,
  Revision: R.Revision,
  CommandId: R.CommandId,
  ClientId: R.ClientId,
  SourceScope: R.SourceScope,
  SkillRootKey: R.SkillRootKey,
  SkillRootStatus: R.SkillRootStatus,
  WorkspaceId: R.WorkspaceId,
  SkillSourceIdentity: R.SkillSourceIdentity,
  SkillResolution: R.SkillResolution,
  TrustState: R.TrustState,
  DesiredState: R.DesiredState,
  ActualState: R.ActualState,
  SafeError: R.SafeError,
  SkillDescriptor: R.SkillDescriptor,
  McpEnvName: R.McpEnvName,
  McpStdioTransport: R.McpStdioTransport,
  McpHttpTransport: R.McpHttpTransport,
  McpSecretBinding: R.McpSecretBinding,
  McpToolPolicy: R.McpToolPolicy,
  McpServerDefinitionInput: R.McpServerDefinitionInput,
  McpServerDescriptor: R.McpServerDescriptor,
  McpServerListResult: R.McpServerListResult,
  McpStatus: R.McpStatus,
  McpTool: R.McpTool,
  McpToolCatalogPage: R.McpToolCatalogPage,
  ResourceOperationReceipt: R.ResourceOperationReceipt,
  ResourceOperation: R.ResourceOperation,
  ResourceDescriptor: R.ResourceDescriptor,
  ResourceListParams: R.ResourceListParams,
  ResourceListResult: R.ResourceListResult,
  ResourceGetParams: R.ResourceGetParams,
  ResourceDesiredSetParams: R.ResourceDesiredSetParams,
  ResourceOperationGetParams: R.ResourceOperationGetParams,
  ResourceOperationCancelParams: R.ResourceOperationCancelParams,
  SkillRefreshParams: R.SkillRefreshParams,
  SkillTrustSetParams: R.SkillTrustSetParams,
  SkillRemoveParams: R.SkillRemoveParams,
  SkillPrioritySetParams: R.SkillPrioritySetParams,
  McpServerListParams: R.McpServerListParams,
  McpServerGetParams: R.McpServerGetParams,
  McpServerCreateParams: R.McpServerCreateParams,
  McpServerUpdateParams: R.McpServerUpdateParams,
  McpServerRemoveParams: R.McpServerRemoveParams,
  McpTrustSetParams: R.McpTrustSetParams,
  McpServerTestParams: R.McpServerTestParams,
  McpServerEnableParams: R.McpServerEnableParams,
  McpServerDisableParams: R.McpServerDisableParams,
  McpServerReconnectParams: R.McpServerReconnectParams,
  McpToolsListParams: R.McpToolsListParams,
  McpOAuthStatusSetParams: R.McpOAuthStatusSetParams,
  McpOAuthStatusResult: R.McpOAuthStatusResult,
}
function check(schema: TSchema, value: unknown): ValidationResult<unknown> {
  const inspected = jsonData(value, 1048576)
  return inspected.ok
    ? validate(schema, inspected.value)
    : { ok: false, errors: [{ path: '', code: 'TYPE', message: 'expected bounded strict JSON data' }] }
}
export function validateResourceControlData(
  name: ResourceControlDataName,
  value: unknown,
): ValidationResult<unknown> {
  return check(DATA_SCHEMAS[name], value)
}
export function validateResourceControlCall(
  name: ResourceControlMethodName,
  side: 'params' | 'result',
  value: unknown,
): ValidationResult<unknown> {
  return check(RESOURCE_CONTROL_METHODS[name][side], value)
}
