/**
 * One generation of the running service, composed in one place: the app with every part built at once, the panel wired
 * with all of them in one call, the process's hook state taken over with Superagent's sessions refused, and the
 * lifecycle that checks the agent environment, starts the app, reconciles the sessions and stops it all again.
 */
import type { BundledAppGrant } from '@agnes/extension-api'
import type { Store } from '../app/store.js'
import { UserError } from '../core/index.js'
import { type Deployment, type Machine, type Probe, resolveDeployment, workerProbe } from '../deployment.js'
import { createRuntimeParts, createSuperagentApp, type Log, type SuperagentApp } from './app.js'
import { agentPaths, verifyDirectory, writeEnvironment } from './environment.js'
import { claimHookState, type HookStateCell, type HookStateHolder } from './hook-state.js'
import { writeTicketInstructions } from './instructions.js'
import {
  createLifecycle,
  type EnvironmentPlan,
  type Lifecycle,
  type LifecycleDeps,
  sdkSessionControl,
} from './lifecycle.js'
import type { PanelParts, PanelWiring } from './panel-host.js'
import { asSdkClient } from './sdk.js'
import { ORCHESTRATOR_KEY, type SessionRegistry } from './sessions.js'

/** Why Superagent's sessions are refused after the service stopped. */
export const STOPPED = 'Superagent is not running; its sessions can use tools again once it runs'

export interface GenerationInput {
  grant: Pick<BundledAppGrant, 'stateDirectory' | 'client'>
  store: Store
  machine: Machine
  holder: HookStateHolder
  /** Aborted when the Host stops the service. */
  lifetime: AbortSignal
  log: Log
  panel: PanelWiring
  /** Replaces dependencies of the lifecycle, for tests; the composition supplies the rest. */
  lifecycle?: Partial<LifecycleDeps>
  /** How the app probes the deployment, for tests; by default the agent's `gh` as worker shells run it. */
  probe?: Probe
}
export interface Generation {
  readonly app: SuperagentApp
  readonly runtime: ReturnType<typeof createRuntimeParts>
  readonly hooks: HookStateCell
  readonly lifecycle: Lifecycle
}

/** The variables of a ticket as `name → value`, for the prepare command and the ticket's instructions file. */
const variables = (list: readonly { key: string; value: string }[]): Record<string, string> =>
  Object.fromEntries(list.map((item) => [item.key, item.value]))

export function composeGeneration(input: GenerationInput): Generation {
  const { grant, store, machine, holder, log } = input
  let app: SuperagentApp | undefined
  let lifecycle: Lifecycle | undefined
  /** The agent account the environment was last written for, which a changed list of blocked commands rewrites. */
  let written: EnvironmentPlan | undefined
  const ticketVariables = (ticket: Parameters<SuperagentApp['parts']['ticketEnvironment']>[0]) =>
    variables(app?.parts.ticketEnvironment(ticket) ?? [])
  const runtime = createRuntimeParts({
    store,
    grant,
    machine,
    lifetime: input.lifetime,
    log,
    environment: ticketVariables,
    verify: (dir) => verifyDirectory(dir),
    instructions: (ticket, dir) => writeTicketInstructions(dir, ticket, ticketVariables(ticket)),
    // No `systemPromptAppend` on the worker session: the daemon answers `session/new` with one from this client with
    // INTERNAL_ERROR. The worker's policy section carries the same execution variables in every request.
  })
  const built = createSuperagentApp({
    store,
    grant,
    // The runtime parts carry the machine settings.
    ...runtime,
    log,
    ...(input.probe ? { probe: input.probe } : {}),
    // The lifecycle re-dispatches what a restart interrupted, after it read each session's real state.
    reconciled: true,
    ticketEnded: (id) => {
      void lifecycle?.ticketEnded(id).catch((error: unknown) => log.warn(String(error)))
    },
    restart: () => lifecycle?.recheck(),
    blockCommands: async (blocked) => {
      if (!written) return
      const { home, shimsDir, ghConfigDir } = agentPaths(written.stateDir)
      written = { ...written, account: { ...written.account, blocked } }
      await writeEnvironment(home, shimsDir, { ...written.account, ghConfigDir })
    },
  })
  app = built
  input.panel.wire(panelParts(built, runtime.registry, () => lifecycle))
  // Until the reconcile has read them, the sessions of earlier runs are refused, each keeping its live note.
  const hooks = claimHookState(holder, built.hookState(new Set()), () => built.stoppedState(STOPPED))
  lifecycle = createLifecycle({
    store,
    sessions: runtime.sessions,
    control: sdkSessionControl(asSdkClient(grant.client)),
    hooks,
    hookState: (ids) => built.hookState(ids),
    registeredSessions: () => runtime.registry.ids(),
    startingState: () => built.hookState(new Set()),
    refusingState: (reason) => built.stoppedState(reason),
    async environment(signal) {
      const settings = store.settings()
      const deployment: Deployment = await resolveDeployment(
        machine,
        settings.sources.github?.config,
        workerProbe(machine.stateDir, machine.stateDir, signal),
      )
      written = {
        stateDir: machine.stateDir,
        account: {
          login: deployment.github.login,
          email: deployment.github.noreply,
          blocked: settings.executor.blockedCommands,
          cli: deployment.github.cli,
        },
      }
      return written
    },
    createApp: () => built,
    log,
    ...input.lifecycle,
  })
  return { app: built, runtime, hooks, lifecycle }
}

/**
 * Everything the panel services read and call, from the app's parts and the lifecycle, wired in one call before the
 * app starts. Setup fields are getters, read on each use: the lifecycle's problem (an agent environment that fails its
 * check) comes first, then the app's.
 */
function panelParts(
  app: SuperagentApp,
  registry: Pick<SessionRegistry, 'id'>,
  lifecycle: () => Lifecycle | undefined,
): PanelParts {
  const { parts } = app
  const lifecycleProblem = () => {
    const status = lifecycle()?.status()
    return status && 'problem' in status ? status.problem : undefined
  }
  return {
    sourceLinks: parts.sourceLinks,
    sources: parts.sources,
    prompts: parts.prompts,
    sessions: {
      status: () => ({
        ...parts.binding.status(app.executor.sessionIds()),
        notificationPending: parts.effects.pending('notice', 'prompts'),
      }),
      notify: (...notice) => parts.notices.notify(...notice),
      delivery: (name) => parts.notices.delivery(name),
    },
    settings: parts.settings,
    engine: parts.engine,
    executor: app.executor,
    get health() {
      return parts.health as PanelParts['health']
    },
    machine: parts.machine,
    masterId: ORCHESTRATOR_KEY,
    get deployment() {
      const deployment = parts.deployment()
      if (!deployment) throw new Error('Superagent is waiting for setup')
      return deployment
    },
    get setupProblem() {
      return lifecycleProblem() ?? parts.setupProblem()
    },
    feishuProblem: undefined,
    configured: () => parts.deployment() !== undefined && lifecycleProblem() === undefined,
    links() {
      const deployment = parts.deployment()
      const links = deployment
        ? { repository: deployment.repository, ...(deployment.feishu ? { feishu: deployment.feishu } : {}) }
        : {}
      return (channel) => parts.sources.link(channel, links)
    },
    workerSessionId: (ticketId) => registry.id({ kind: 'worker', ticketId }),
    ticketEnvironment: (ticket) => parts.ticketEnvironment(ticket),
    checkSetup() {
      const current = lifecycle()
      // As the setup check always did: nothing to check once everything is set up.
      if (current?.status().state === 'running' && !parts.setupProblem()) throw new UserError('setupComplete')
      current?.recheck()
    },
    requestPass: () => parts.passes.request(),
    async models() {
      // A role's provider is the AGH route its model is reached through.
      const catalog = await parts.models()
      return {
        ...(catalog.default
          ? { default: { provider: catalog.default.route, model: catalog.default.model } }
          : {}),
        groups: catalog.groups,
      }
    },
  }
}
