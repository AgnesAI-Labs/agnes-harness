import {
  type ExtensionActivationBarrier,
  type Host,
  HostError,
  type HostSession,
  type PresetDoc,
  type ResolvedPreset,
  type ResolvedProfile,
} from '@agnes/host'
import { rpcError } from '@agnes/protocol'
import { workerComputerUseStatusSource } from './service-worker.js'
import type { WorkerPool } from './worker-pool.js'
/**
 * A `Host`-shaped facade for the per-connection `AgnesContext.host` field: the supervisor process
 * holds no kernel at all, so
 * there is no real `Assembled` route/preset table to build a genuine `Host` from without also
 * assembling one (which is exactly what a worker process is for). Grepping every `cx.host.` access
 * in `local/methods/acp.ts` and `local/methods/agnes.ts` shows the RPC handlers only ever touch
 * `.profile` and `.validatePresetSwitch` / `.validateModelSwitch` - `.kernel`, `.provider`,
 * `.createSession` etc. are never read on this path (session lifecycle goes through
 * `SupervisorRegistry` / `WorkerRegistry` / `WorkerPool` instead), so those are stubbed to fail
 * loudly rather than silently if some future change ever reaches them.
 */
export function supervisorHostFacade(
  initial: ResolvedProfile,
  activationBarrier: ExtensionActivationBarrier,
  pool: Pick<WorkerPool, 'acquireSharedWorker'>,
): {
  host: Host
  resolveApplicationAgent(profile: string, ref: string): Promise<import('@agnes/protocol').AgentPlan>
  update(profile: ResolvedProfile): void
  /** Lets a model refusal name a saved configuration that waits for a daemon restart. */
  observeRestartPending(pending: () => boolean): void
} {
  let profile = initial
  let restartPending = () => false
  const facade = {
    activationBarrier,
    async resolveAgent(ref: string): Promise<import('@agnes/protocol').AgentPlan> {
      const link = await pool.acquireSharedWorker()
      return (await link.command('agents.resolve', { ref })) as import('@agnes/protocol').AgentPlan
    },
    get profile() {
      return profile
    },
    get kernel(): never {
      throw new Error('supervisor host facade: kernel is not available (the supervisor holds no kernel)')
    },
    get provider(): never {
      throw new Error('supervisor host facade: provider is not available (the supervisor holds no kernel)')
    },
    providerFingerprint: null,
    runtimes: [] as ResolvedProfile['runtimes'],
    computerUse: initial.computerUse.enabled ? workerComputerUseStatusSource(pool, () => profile) : undefined,
    presets: {} as Record<string, PresetDoc>,
    createSession(): Promise<HostSession> {
      throw new Error(
        'supervisor host facade: createSession is not available - session lifecycle goes through ' +
          'SupervisorRegistry/WorkerRegistry, never cx.host directly',
      )
    },
    extensions: () => [],
    async close() {
      // No-op: this facade owns no resources of its own to release.
    },
    /**
     * Best-effort, profile-only check: the supervisor has the raw `ResolvedProfile` but no assembled
     * preset table. Without a session it can check only deployment `presets.allowed`; a session's
     * pinned bundles may add names the supervisor cannot see. Session switches therefore delegate
     * admission to the worker's `setPreset` case, which calls the real Host's `setSessionPreset`
     * against that session's composition and hard requirements. `resolved.view` is just the preset NAME
     * (not a real `PresetView`): `RemoteSession.setPreset` forwards it as the wire's `preset` field
     * verbatim, and the worker re-derives the real view from that name itself.
     */
    validatePresetSwitch(name: string, sessionKey?: string): ResolvedPreset {
      if (!sessionKey && !profile.presets.allowed.includes(name))
        throw new HostError('E_PRESET_UNSUPPORTED', `preset ${name} is not in presets.allowed`, {
          detail: { preset: name },
        })
      return { view: name, doc: {} as PresetDoc, chain: [], hash: '' } as unknown as ResolvedPreset
    },
    /** The supervisor checks the sealed declaration before forwarding. The worker repeats the full
     * assembled-provider check (including the published catalogue), so this is not the final gate. */
    validateModelSwitch(sel: { route: string; model: string }): void {
      const route = profile.provider.routes?.find((candidate) => candidate.route === sel.route)
      const modelDeclared =
        route?.models === undefined || route.models.some((model) => model.id === sel.model)
      // Route and model go in `detail` only: an account route (`account-acct-<uuid>`) in the message
      // trips HostError's leak check, and the code-less error it throws instead reaches the client
      // as INTERNAL rather than PRESET_SWITCH_REJECTED.
      // A saved account or model change that is not active yet is the likely cause; the fixed reason
      // tells the operator to restart rather than to pick another preset or permission.
      if (!route || !modelDeclared)
        throw new HostError('E_MODEL_UNSUPPORTED', 'the requested model is not declared', {
          detail: {
            route: sel.route,
            model: sel.model,
            ...(restartPending() ? { reason: 'restart-required' } : {}),
          },
        })
    },
  }
  return {
    resolveApplicationAgent: async (requested, ref) => {
      if (requested !== profile.name) throw rpcError('CAPABILITY_DENIED')
      return facade.resolveAgent(ref)
    },
    host: facade as unknown as Host,
    update(next: ResolvedProfile) {
      profile = next
    },
    observeRestartPending(pending: () => boolean) {
      restartPending = pending
    },
  }
}
