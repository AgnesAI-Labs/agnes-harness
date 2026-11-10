import { randomUUID } from 'node:crypto'
import type { CallContext } from '@agnes/daemon-foundation/local/endpoint'
import type { WorkspaceCatalog } from '@agnes/daemon-foundation/storage/workspaces'
import { sessionKey as canonicalSessionKey } from '@agnes/host'
import { parseAgentRef, parseLoopSelection, parseSessionBundles, rpcError } from '@agnes/protocol'
import type { LocalContext } from './methods/acp.js'
import { admitSystemPromptAppend } from './methods/session-prompt-append.js'
import { applyOpenToolFilter, parseOpenToolFilter } from './methods/session-switches.js'
import { throwWorkspaceRpcError } from './methods/workspaces.js'
import { reserveOwnedSession, SessionAdmissionDenied } from './session-admission.js'
import type { SessionEntry } from './sessions.js'

const pocket = (o: unknown): Record<string, unknown> =>
  (o as { _meta?: Record<string, Record<string, unknown>> } | undefined)?._meta?.['ai.agnes.harness'] ?? {}
const SESSION_PERMISSIONS: ReadonlySet<string> = new Set([
  'read-only',
  'workspace-write',
  'full-access',
  'default',
])

export type InternalSessionOrigin = {
  validateWorkspace(
    cwd: string,
    sessionKey: string,
  ): Promise<Awaited<ReturnType<WorkspaceCatalog['validate']>>>
  afterBind(sessionKey: string): void
}

/** The authenticated session/new admission path, also used by trusted daemon launchers. */
export async function createSessionWithAdmission(
  cx: LocalContext,
  params: unknown,
  c: CallContext,
  throwSessionOpenRpcError: (error: unknown, sessionId?: string) => never,
  origin?: InternalSessionOrigin,
): Promise<{ sessionId: string }> {
  const denyOwnership = (method: string, sessionId: string): never => {
    throw rpcError('CAPABILITY_DENIED', { method, sessionId, reason: 'session owner unavailable' })
  }
  const p = params as { cwd: string; mcpServers: unknown[]; additionalDirectories?: string[] }
  if (p.mcpServers.length > 0) throw rpcError('SEMANTIC_REJECTED', { reason: 'mcpServers must be empty' })
  if (
    cx.auth.config.transport === 'ws' &&
    cx.auth.config.localWeb !== true &&
    cx.sessionCredentialAuthority !== true
  )
    throw rpcError('CAPABILITY_DENIED', {
      method: 'session/new',
      reason: 'remote session actor authority unavailable',
    })
  const h = pocket(params)
  let agent: string | undefined
  try {
    agent = h.agent === undefined ? undefined : parseAgentRef(h.agent)
  } catch {
    throw rpcError('SEMANTIC_REJECTED', { reason: 'invalid agent ref' })
  }
  let agentDigest = typeof h.agentDigest === 'string' ? h.agentDigest : undefined
  if (
    (agent &&
      (h.loop !== undefined ||
        h.bundles !== undefined ||
        h.preset !== undefined ||
        h.permission !== undefined ||
        h.systemPromptAppend !== undefined)) ||
    (h.agentDigest !== undefined && (!agent || !agentDigest || !/^sha256-[a-f0-9]{64}$/.test(agentDigest)))
  )
    throw rpcError('SEMANTIC_REJECTED', { reason: 'invalid agent selection' })
  if (agent) {
    if (!cx.host.resolveAgent) throw rpcError('CAPABILITY_DENIED', { reason: 'agent resolution unavailable' })
    const plan = await cx.host.resolveAgent(agent)
    if (agentDigest && agentDigest !== plan.digest)
      throw rpcError('SEMANTIC_REJECTED', { reason: 'agent review drift' })
    agentDigest = plan.digest
  }
  let loop: ReturnType<typeof parseLoopSelection> | undefined
  try {
    loop = h.loop === undefined ? undefined : parseLoopSelection(h.loop)
  } catch {
    throw rpcError('SEMANTIC_REJECTED', { reason: 'loop requires { id, version }' })
  }
  let bundles: string[] | undefined
  try {
    bundles = h.bundles === undefined ? undefined : parseSessionBundles(h.bundles)
  } catch {
    throw rpcError('SEMANTIC_REJECTED', { reason: 'invalid session bundle selection' })
  }
  const preset = typeof h.preset === 'string' ? h.preset : undefined
  // A selected bundle may bring its own preset, which only the Host can see at admission; it
  // refuses a name outside the session's allowed list there.
  if (preset && !bundles?.length && !cx.host.profile.presets.allowed.includes(preset))
    throw rpcError('PRESET_SWITCH_REJECTED', { reason: 'not in presets.allowed', preset })
  // Whether the level is allowed for this preset is the Host's admission; only the name is checked.
  const permission = h.permission
  if (permission !== undefined && (typeof permission !== 'string' || !SESSION_PERMISSIONS.has(permission)))
    throw rpcError('SEMANTIC_REJECTED', { reason: 'invalid permission' })
  const toolFilter = parseOpenToolFilter(h.toolFilter)
  let entry: SessionEntry
  let workspace: Awaited<ReturnType<WorkspaceCatalog['validate']>>
  try {
    if (!origin && p.cwd === cx.workspaces.managedChats.legacy)
      throw rpcError('CAPABILITY_DENIED', {
        method: 'session/new',
        reason: 'legacy workspace requires trusted launch',
      })
    workspace = origin
      ? await origin.validateWorkspace(p.cwd, typeof h.sessionKey === 'string' ? h.sessionKey : '')
      : await cx.workspaces.validate(p.cwd)
  } catch (error) {
    throwWorkspaceRpcError(error)
  }
  if (!origin && workspace.path === cx.workspaces.managedChats.legacy)
    throw rpcError('CAPABILITY_DENIED', {
      method: 'session/new',
      reason: 'legacy workspace requires trusted launch',
    })
  // Admitted before any key is reserved, so a refused directory leaves nothing behind.
  const extraRoots = await cx.workspaces.admitExtraRoots(workspace.path, p.additionalDirectories ?? [])
  // Default creation reuses the canonical workspace ledger. An explicit loop needs a fresh
  // ledger because loop identity is immutable; otherwise reuse could silently select the old loop.
  // Session IDs are opaque to storage and ownership. Supplying sessionKey still reuses that exact
  // ledger, including an earlier suffixed ID, and later default creation keeps its canonical key.
  const requestedKey =
    typeof h.sessionKey === 'string'
      ? h.sessionKey
      : `${canonicalSessionKey(
          cx.host.profile,
          await cx.resolveNewSessionActor(c.conn.credential, 'session'),
          workspace.path,
        )}${agent ? `:agent:${randomUUID()}` : loop ? `:loop:${randomUUID()}` : bundles !== undefined ? `:composition:${randomUUID()}` : extraRoots.length ? `:dirs:${randomUUID()}` : ''}`
  const hasSessionFact =
    cx.registry.get(requestedKey) !== undefined ||
    cx.workspaces.sessionPath(requestedKey) !== undefined ||
    cx.hasSessionFact?.(requestedKey) === true
  const systemPromptAppend = await admitSystemPromptAppend(h.systemPromptAppend, {
    existingSession: hasSessionFact,
    context: c,
    configurationReadOnly: cx.configurationReadOnly,
  })
  const ownership = cx.sessionOwnership
  if (!ownership) return denyOwnership('session/new', requestedKey)
  let reservedNew = false
  let binding: Awaited<ReturnType<WorkspaceCatalog['authorizeAndBind']>>
  try {
    const reserved = await reserveOwnedSession({
      ownership,
      workspaces: cx.workspaces,
      principalId: c.conn.principalId,
      sessionKey: requestedKey,
      canonicalRoot: workspace.path,
      extraRoots,
      hasSessionFact,
    })
    reservedNew = reserved.reservedNew
    binding = reserved.envelope
  } catch (error) {
    if (error instanceof SessionAdmissionDenied) denyOwnership('session/new', requestedKey)
    throwSessionOpenRpcError(error, requestedKey)
  }
  try {
    c.signal.throwIfAborted()
    if (origin) {
      origin.afterBind(requestedKey)
      binding = await cx.workspaces.restoreBinding(requestedKey)
    }
    entry = await cx.registry.open({
      cwd: binding.canonicalRoot,
      binding,
      ...(agent ? { agent } : {}),
      ...(agentDigest ? { agentDigest } : {}),
      ...(preset ? { preset } : {}),
      ...(permission ? { permission } : {}),
      ...(bundles !== undefined ? { bundles } : {}),
      ...(systemPromptAppend === undefined ? {} : { systemPromptAppend }),
      ...(loop ? { loop } : {}),
      key: requestedKey,
      ...(c.conn.credential === undefined ? {} : { credential: c.conn.credential }),
    })
    // Before activation: until the owner can reach the session, no prompt can run it unfiltered.
    if (toolFilter) await applyOpenToolFilter(cx, entry.key, toolFilter)
    if (reservedNew && !ownership.activateNew(entry.key, c.conn.principalId))
      denyOwnership('session/new', requestedKey)
  } catch (error) {
    throwSessionOpenRpcError(error, requestedKey)
  }
  return { sessionId: entry.key }
}
