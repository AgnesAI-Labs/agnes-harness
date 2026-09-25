import { createHash, randomUUID } from 'node:crypto'
import {
  type ChildWorkspaceRuntimePort,
  CoreError,
  type SessionWorkspaceRuntime as CoreSessionWorkspaceRuntime,
  type SandboxSeam,
  type SeamImplementations,
  type Seq,
  type SessionWorkspaceLifecycle,
  type WorkspaceInvocationPort,
} from '@agnes/core'
import type { Actor } from '@agnes/protocol'
import type { FencedFs } from './adapters/fs.js'
import { materializeRoutes, pinPresetRoutes } from './assemble/routes.js'
import type { Assembled } from './assemble.js'
import type { AuditSink } from './audit.js'
import { type CommandRule, checkCommandRule } from './command-policy.js'
import { HostError } from './errors.js'
import type { HostSession } from './host.js'
import { type ResolvedPreset, resolvePreset } from './presets/resolve.js'
import type { ResolvedProfile } from './profile/types.js'
import { replaySwitchesOnOpen } from './session-switch.js'
import type { SessionWorkspaceRuntime, SessionWorkspaceRuntimeTable } from './session-workspace-runtime.js'
import { assertWorkspaceBinding, type WorkspaceBinding } from './workspace-authority.js'

/**
 * What opening a session reported putting right. Taken from the method rather than pinned by name,
 * for the same reason `HostSession` is: core publishes the session, not the shape this returns.
 */
export type SessionRecovery = Awaited<ReturnType<HostSession['resume']>>

export type CreateSessionOptions = {
  key?: string
  preset?: string
  /** Transitional local entry. Authenticated worker opens supply `binding` and cannot override it. */
  cwd?: string
  binding?: WorkspaceBinding
  credential?: unknown
  writerRunId?: string
  lane?: string
  seams?: Partial<Omit<SeamImplementations, 'ledger'>>
  /** Creates a durable immutable-prefix child through Core's existing fork primitive. */
  parent?: { key: string; boundarySeq: Seq }
  /** See core's SessionOptions: a new session opens without `session_start`. In-process only (import). */
  skipSessionStartHooks?: boolean
  /**
   * Called when opening this session had to close out work a dead process left in flight, and only
   * then. Opening a session that ended cleanly does not call it and writes nothing to the ledger, so
   * a caller that is never called opened a ledger that was already sound.
   */
  onRecovered?: (recovery: SessionRecovery) => void
}

export function sessionKey(profile: ResolvedProfile, actor: Actor, cwd: string): string {
  const scope = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  return `agnes:${actor.org || 'local'}:${profile.name}:cli:workspace:${scope}`
}

type HardRequirements = {
  sandbox?: { required?: boolean }
  code_runtime?: { language?: string }
  approval?: { command_policy?: CommandRule[] }
}

/**
 * Everything about a preset that a session open - or a later runtime switch, Task 27a's
 * `validatePresetSwitch` - has to hold against the actual assembly: is it in `presets.allowed`, can
 * this deployment provide the sandbox/runtime it hard-requires, does its routing resolve against the
 * routes this host actually built. A deprecated `command_policy` rule is reported to `audit` and
 * does not refuse; the other checks throw `E_PRESET_UNSUPPORTED`/`E_PRESET_UNRESOLVED`.
 *
 * Takes the whole `ResolvedPreset`, not just its `.view`: the hard-requirement checks below read
 * `resolved.doc` (the raw `PresetDoc`) and the routing check reads `resolved.view` (the `PresetView`
 * core runs on) - two different projections of the one resolved preset, and a caller holding only
 * one of them cannot run both halves of this check.
 */
export function checkPresetHardRequirements(
  profile: ResolvedProfile,
  a: Assembled,
  resolved: ResolvedPreset,
  name: string,
  audit?: AuditSink,
): void {
  const unsupported = (why: string, detail: Record<string, unknown>): never => {
    throw new HostError('E_PRESET_UNSUPPORTED', `preset ${name} ${why}`, {
      detail: { source: name, ...detail },
    })
  }
  if (!profile.presets.allowed.includes(name))
    unsupported('is not in presets.allowed', { capability: 'preset' })

  // hard requirements, checked against what this deployment can actually provide
  const doc = resolved.doc as HardRequirements
  const l1 = a.adapters.platform.capability('sandbox.l1')
  if (doc.sandbox?.required === true && l1.level !== 'full')
    unsupported('requires sandbox L1, which this platform cannot provide', {
      capability: 'sandbox.l1',
      reason: l1.reason,
    })
  // A code preset wants a persistent runtime plus a two-way bridge back into the harness; the remote
  // transport (Task 6's `adapters.transport`, present exactly when this deployment is remote) carries
  // one-shot exec and file copies and nothing else, and the runtime contract also routes its startup
  // argv through confine(), which the remote sandbox seam unconditionally refuses. Say so plainly
  // rather than letting it fail later as "no runtime package provides it" - a package does provide
  // it, this deployment just cannot host it. Checked against the direct `transport` flag Task 6 put
  // on `AdapterBundle`, not by pattern-matching the `sandbox.l1` capability's human-readable `reason`
  // string: a diagnostic string must never become a program-control-flow dependency.
  if (doc.code_runtime?.language !== undefined && a.adapters.transport !== undefined)
    unsupported('needs a code runtime, which a remote sandbox deployment cannot host', {
      capability: `code_runtime.${doc.code_runtime.language}`,
    })
  const lang = doc.code_runtime?.language
  if (lang !== undefined && !(lang in a.runtimes))
    unsupported(`needs code_runtime.${lang}, which no runtime package provides`, {
      capability: `code_runtime.${lang}`,
    })
  // Every rule is checked when the session opens, not when the first approval arrives: a rule that
  // cannot decide anything must not sit in a live preset looking like a policy. A rule written in a
  // spelling that still parses and will stop parsing is not a refusal but is not silence either: it
  // goes to the host's audit, which is the same channel the resolved profile is recorded on and the
  // one an operator already reads to see what this deployment decided.
  for (const rule of doc.approval?.command_policy ?? [])
    for (const d of checkCommandRule(rule))
      audit?.write({
        kind: 'preset.deprecated',
        detail: { capability: 'approval.command_policy', preset: name, ...d },
      })

  // The sentinel again, for a preset that is not the one the host was assembled with. assemble()
  // pinned only the default view, so this one still reads `default`, and core would record a request
  // against a route of that name. It is resolved the same way - and then held to the table the
  // provider was actually built with, because ai resolves a slot from that table and not from the
  // session's preset: a session asking for a route the provider was not given cannot be served, and
  // says so at open rather than in the middle of the first turn.
  const wanted = materializeRoutes(resolved.view, profile)
  for (const [slot, t] of Object.entries(wanted)) {
    const built = (a.routes as Record<string, { route: string; model: string } | undefined>)[slot]
    if (!built || built.route !== t.route || built.model !== t.model)
      throw new HostError(
        'E_PRESET_UNRESOLVED',
        `preset ${name} slot ${slot} wants a route this host did not assemble`,
        {
          detail: { reason: 'route-not-assembled', slot, want: `${t.route}/${t.model}`, preset: name },
        },
      )
  }
}

function workspaceFence(runtime: SessionWorkspaceRuntime): FencedFs {
  if (runtime.fencedFs) return runtime.fencedFs
  throw new HostError('E_WORKSPACE_UNTRUSTED', 'workspace runtime has no fenced filesystem', {
    detail: { reason: 'workspace-fence-missing' },
  })
}

/**
 * The fs adapter enforces the policy the assembly bound after the seams came up: the sandbox seam's
 * own full rule set, pinned by digest. What host owes at every session open - and on every
 * fsPolicy() call, because core re-reads it on every tool path - is that the seam answering right
 * now is still answering that same policy. A per-session sandbox override is checked by the same
 * rule: a digest that differs from the bound one is a different policy, and racing a different
 * policy onto the shared FsOps is refused rather than attempted.
 *
 * Root agreement against the live filesystem is settled once at open; the root string and the digest
 * are re-checked on every call. Delegate every method explicitly so class-backed seams keep their
 * receiver and frozen object seams do not trip Proxy invariants when fsPolicy is guarded.
 */
async function fenceSandbox(
  sandbox: SandboxSeam,
  sessionFs: Pick<FencedFs, 'resolveInside' | 'canonicalize'>,
  boundDigest: () => string,
): Promise<SandboxSeam> {
  const fenced = await sessionFs.resolveInside('.')
  // Captured as its own string, not the live policy object: the seam's fsPolicy() may return the
  // same mutable object on every call, and the per-call check below must compare against the root
  // this session opened with, not whatever that object holds by the time it is asked again.
  const openWorkspaceRoot = sandbox.fsPolicy().workspaceRoot
  // Root agreement is settled once, at open, against the live filesystem. The seam's digest hashes
  // every rule including the workspace allow rule (policy.ts policyDigest), so a root change is a
  // digest change; the string comparison below is the belt to that brace, on every call.
  const claimed = await sessionFs.canonicalize(openWorkspaceRoot).catch(() => openWorkspaceRoot)
  const rootMismatch = (): never => {
    throw new HostError(
      'E_WORKSPACE_UNTRUSTED',
      'the sandbox seam and the fs adapter disagree about the workspace root',
      { detail: { seam: 'sandbox', reason: 'workspace-root-mismatch' } },
    )
  }
  if (claimed !== fenced) rootMismatch()
  const agreedFsPolicy = (): ReturnType<SeamImplementations['sandbox']['fsPolicy']> => {
    const policy = sandbox.fsPolicy()
    if (policy.workspaceRoot !== openWorkspaceRoot) rootMismatch()
    if (policy.digest !== boundDigest())
      throw new HostError(
        'E_WORKSPACE_UNTRUSTED',
        'the sandbox seam answers a policy other than the one the host bound',
        { detail: { seam: 'sandbox', reason: 'sandbox-policy-digest-mismatch' } },
      )
    return policy
  }
  agreedFsPolicy()
  return Object.freeze<SandboxSeam>({
    forWorkspace: (next) => sandbox.forWorkspace(next),
    exec: (command, options) => sandbox.exec(command, options),
    confine: (argv) => sandbox.confine(argv),
    fsPolicy: agreedFsPolicy,
    enforcement: () => sandbox.enforcement(),
  })
}

/**
 * A delegated child is opened by Core, not through createSession, so its reservation carries the
 * sandbox a root session would get for the same runtime: the seam fitted to the reserved workspace,
 * held to that runtime's fence and bound policy. Without it the child would fall back to the
 * Kernel-level seam, which is bound to no workspace.
 */
function childSandboxes(
  a: Assembled,
  port: Pick<SessionWorkspaceRuntimeTable, 'reserve'>,
): ChildWorkspaceRuntimePort {
  return Object.freeze({
    async reserve(parentKey: string, childKey: string) {
      const child = await port.reserve(parentKey, childKey)
      try {
        const { runtime } = child
        const sandbox = await fenceSandbox(
          runtime.seam ?? a.seams.sandbox,
          workspaceFence(runtime),
          () => runtime.policy.digest,
        )
        return Object.freeze({ ...child, sandbox })
      } catch (error) {
        await child.close().catch(() => undefined)
        throw error
      }
    },
  })
}

export async function createSession(
  profile: ResolvedProfile,
  a: Assembled,
  opts: CreateSessionOptions,
  audit?: AuditSink,
  workspace?: Readonly<{
    runtime: CoreSessionWorkspaceRuntime & SessionWorkspaceRuntime
    lifecycle: SessionWorkspaceLifecycle
    children: Pick<SessionWorkspaceRuntimeTable, 'reserve'>
    invocation: WorkspaceInvocationPort
  }>,
): Promise<HostSession> {
  // 1 preset. The allowed-list check runs before resolvePreset, not folded into
  // checkPresetHardRequirements's own copy of it: resolvePreset raises its own E_PRESET_UNSUPPORTED
  // (capability `preset:${name}`, for a name that is in neither `allowed` nor `a.presets`) when a
  // name cannot be found at all, and that error must not pre-empt the plainer "is not in
  // presets.allowed" refusal a name outside the allow-list gets regardless of whether it resolves.
  const parentSession = opts.parent ? a.kernel.get(opts.parent.key) : undefined
  if (opts.parent && !parentSession)
    throw new HostError('E_DEP_MISSING', 'fork parent session is not open', {
      detail: { reason: 'fork-parent-not-open' },
    })
  if (opts.binding) {
    assertWorkspaceBinding(opts.binding)
    if (opts.key !== undefined && opts.binding.sessionKey !== opts.key)
      throw new HostError('E_WORKSPACE_UNTRUSTED', 'workspace binding belongs to another session', {
        detail: { reason: 'binding-session-mismatch' },
      })
    if (opts.cwd !== undefined && opts.cwd !== opts.binding.canonicalRoot)
      throw new HostError('E_WORKSPACE_UNTRUSTED', 'cwd cannot override the authoritative workspace', {
        detail: { reason: 'binding-cwd-override' },
      })
  }
  const cwd = workspace?.runtime.root ?? opts.binding?.canonicalRoot ?? opts.cwd ?? parentSession?.d.cwd
  if (!cwd)
    throw new HostError('E_WORKSPACE_REQUIRED', 'session has no authoritative workspace', {
      detail: { reason: 'workspace-binding-required' },
    })
  const name = parentSession?.preset.name ?? opts.preset ?? profile.presets.default
  if (!profile.presets.allowed.includes(name))
    throw new HostError('E_PRESET_UNSUPPORTED', `preset ${name} is not in presets.allowed`, {
      detail: { source: name, capability: 'preset' },
    })
  const preset = resolvePreset(name, a.presets, a.sessionPresetLimits())

  // 2 hard requirements, checked against what this deployment can actually provide.
  // checkPresetHardRequirements repeats the allowed-list check above - harmless here since `name`
  // already passed it - because validatePresetSwitch (session-switch.ts) calls it with no such
  // pre-check of its own.
  checkPresetHardRequirements(profile, a, preset, name, audit)

  // The fs adapter is fenced at the workspace root this host was assembled with, so a session opened
  // somewhere else would read and write through a fence that is not its own. v0.1 refuses; one host
  // serves one workspace.
  //
  // The fence is asked, not re-implemented. A second comparison here would be a second answer to the
  // same question, and it was already wrong once: it compared `resolve(cwd)` against the adapter's
  // realpathed root, so on any machine whose temp or home directory is a symlink - macOS, and every
  // container that bind-mounts one - a cwd inside the workspace was refused as outside it. The path
  // is not put in the message: it is the caller's and has no business in an error string.
  const sessionFs = workspace ? workspaceFence(workspace.runtime) : a.adapters.fs
  try {
    await sessionFs.resolveInside(cwd)
  } catch {
    // The code is the code, not a word in the message: a filter matching on codes would never have
    // seen the E_FS_DENIED this used to spell out inside an E_SEAM_INIT, and a reader would have
    // believed it did. A cwd outside the workspace is a workspace refusal, not a seam that failed
    // to initialise.
    throw new HostError('E_WORKSPACE_UNTRUSTED', 'cwd is not inside the workspace this host serves', {
      detail: { seam: 'sandbox', reason: 'cwd-outside-workspace' },
    })
  }

  // Recomputed rather than threaded out of `checkPresetHardRequirements`: that call above already
  // refused if this preset's routing does not resolve against what this host assembled, so by this
  // point `materializeRoutes` is known to succeed and this is just fetching its answer back to pin
  // into the view core runs on.
  const wanted = materializeRoutes(preset.view, profile)
  const view = parentSession?.preset ?? pinPresetRoutes(preset.view, wanted)

  if (workspace && opts.seams?.sandbox)
    throw new HostError('E_SEAM_IMMUTABLE', 'the sandbox seam cannot override a workspace runtime', {
      detail: { seam: 'sandbox' },
    })
  const sandbox = workspace?.runtime.seam ?? opts.seams?.sandbox ?? a.seams.sandbox
  if (!sandbox)
    throw new HostError('E_SANDBOX_WORKSPACE', 'workspace runtime has no fitted sandbox seam', {
      detail: { reason: 'workspace-sandbox-missing' },
    })
  const guardedSandbox = await fenceSandbox(
    sandbox,
    sessionFs,
    () => workspace?.runtime.policy.digest ?? a.adapters.fs.fence().digest,
  )

  // 3 the opener's Actor - host is the only caller of principals.resolve
  const actor = await a.seams.principals.resolve(opts.credential ?? { kind: 'local' }, 'session')
  if (parentSession) {
    const sameActor =
      parentSession.d.actor.id === actor.id &&
      parentSession.d.actor.role === actor.role &&
      parentSession.d.actor.org === actor.org
    if (!sameActor)
      throw new HostError('E_WORKSPACE_UNTRUSTED', 'fork parent belongs to another actor', {
        detail: { reason: 'fork-parent-actor-mismatch' },
      })
    if (parentSession.d.cwd !== cwd)
      throw new HostError('E_WORKSPACE_UNTRUSTED', 'fork child must use its parent workspace', {
        detail: { reason: 'fork-parent-workspace-mismatch' },
      })
    if (parentSession.op())
      throw new CoreError('E_LANE_BUSY', 'fork requires an idle parent', {
        parent: parentSession.key,
      })
  }

  // 4 key and per-session overrides
  if (opts.seams && 'ledger' in opts.seams)
    throw new HostError('E_SEAM_IMMUTABLE', 'the ledger seam cannot be overridden per session', {
      detail: { seam: 'ledger' },
    })
  const key = opts.key ?? sessionKey(profile, actor, cwd)
  if (opts.binding && opts.binding.sessionKey !== key)
    throw new HostError(
      'E_WORKSPACE_UNTRUSTED',
      'workspace binding does not match the resolved session key',
      {
        detail: { reason: 'binding-session-mismatch' },
      },
    )

  // 5 open: core takes the writer lease and writes session/start. `writerRunId` is required and
  // nothing upstream mints it, so it is minted here when the caller did not bring one.
  const session = await a.kernel.session(key, {
    actor,
    preset: view,
    resolvedProfileHash: profile.hash,
    cwd,
    writerRunId: opts.writerRunId ?? randomUUID(),
    ...(opts.parent ? { parent: opts.parent } : {}),
    ...(opts.lane ? { lane: opts.lane } : {}),
    ...(opts.skipSessionStartHooks ? { skipSessionStartHooks: true } : {}),
    ...(workspace
      ? {
          workspaceRuntime: workspace.runtime,
          workspaceIdentity: workspace.runtime.binding,
          workspaceInvocation: workspace.invocation,
          workspaceLease: workspace.lifecycle,
          childWorkspaceRuntime: childSandboxes(a, workspace.children),
        }
      : {}),
    seams: { ...opts.seams, sandbox: guardedSandbox },
  })
  // 6 what comes back is the zero-privilege session, and a sound one.
  //
  // A process that died mid-answer leaves a step nothing closed, and the next turn on that ledger is
  // refused for it. The kernel can put that right and nothing was asking it to, so opening the
  // session is what asks: every entry - the TUI, `-p`, `--mode acp`, a chat adapter - opens one, and
  // an entry that has to remember a separate call is an entry that will forget.
  //
  // The cost is that opening a session is no longer purely a read. It is bounded to the case that
  // needs it: `resume()` on a ledger whose turn ended reads one in-memory register, returns idle and
  // writes nothing, so an ordinary open is indistinguishable from what it was. Two processes cannot
  // both do this to one ledger - the writer lease is taken inside `kernel.session` above, and the
  // second opener is refused there with E_WRITER_LEASE before it reaches this line - so recovery
  // inherits the serialisation the lease already provides rather than adding a second one.
  //
  // Inside one process the same guarantee comes from one line up rather than from a check here. The
  // seams passed above always carry the fenced sandbox, and the kernel refuses to refit seams onto a
  // session it already holds - so a second open of a live session is E_LANE_BUSY and never reaches
  // this line. That matters: resuming underneath a turn already running on that session would be two
  // writers to one program counter, which no lease is watching for.
  const recovery = await session.resume()
  // `resumed` alone is not news - it says a turn was open, which a parked session is too. What the
  // caller is told about is work that was actually settled, which is what makes the report honest on
  // a second open that found nothing left to do.
  if (recovery.actions.length > 0) {
    audit?.write({
      kind: 'session.recovered',
      detail: {
        sessionKey: key,
        ...(recovery.phase ? { phase: recovery.phase } : {}),
        actions: recovery.actions.map((x) => x.action),
      },
    })
    opts.onRecovered?.(recovery)
  }
  // A graceful endpoint close records cancel_requested before the log is torn down. Resume settles
  // the interrupted inference but leaves the turn in failure_drain; the next prompt would then
  // observe that abort as its own outcome. Drain the cancelled turn here so the session is idle and
  // the caller's next turn is a new one.
  const leftover = session.op()
  if (
    leftover &&
    (leftover.control.status === 'cancel_requested' || leftover.phase.kind === 'failure_drain')
  ) {
    await session.step()
  }
  // core's setPreset/setModel (Task 32/32a) take effect in memory only, recorded as an ignorable
  // audit row - nothing about a live switch survives a fresh process opening the same ledger except
  // that row, so every open reads it back and replays whatever it last settled on before the session
  // is handed to the caller. A session that never switched, or one that already agrees with its own
  // ledger (the common in-process case - Kernel.session() hands back the live instance, and this
  // runs again), does no work; see session-switch.ts for the guard.
  await replaySwitchesOnOpen(session, profile, a)
  return session
}
