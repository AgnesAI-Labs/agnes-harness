import type { SessionPreferencesStore } from '@agnes/daemon-foundation/storage/session-preferences'
import type { WorkspaceCatalog } from '@agnes/daemon-foundation/storage/workspaces'
import type { runQueued } from '@agnes/daemon-rpc/local/command-queue'
import type { ScanRead } from '@agnes/host'
import type {
  EventEnvelope,
  SessionActivityResult,
  SessionRuntimeDescriptor,
  SessionViewResult,
} from '@agnes/protocol'
import { createClient, memoryJournal, type NodeClient } from '@agnes/sdk'
import { ManagedPortsClosed } from './managed-gate-read.js'
import { type ManagedInputEntry, managedInputPorts } from './managed-input-ports.js'
import { hasOpenNativeQuestion } from './managed-question-status.js'
import type { IdleSignal } from './managed-session-idle.js'
import type { ManagedSessionRecords } from './managed-session-records.js'
import type { ManagedSessionCaller, ManagedSessionPorts, ManagedToolDetail } from './managed-sessions.js'

type Entry = ManagedInputEntry & {
  session: ManagedInputEntry['session'] & {
    /** Whether the open session's live policy holds outward calls for a person, read in its worker. */
    outwardCheckpoint(): Promise<boolean>
    /** The principal the deployment resolves a credential to for answering approvals. */
    resolveActor(credential: unknown, surface: 'approval'): Promise<{ id: string }>
  }
}

/**
 * The registered, present workspace root for a path, or a throw. A managed `start`, every `send`, and
 * the owner's grant all resolve paths here, so a grant stores exactly the root they compare against.
 */
export function managedWorkspaceRoot(workspaces: Pick<WorkspaceCatalog, 'validate' | 'list'>) {
  return async (path: string): Promise<string> => {
    const root = (await workspaces.validate(path)).path
    const known = (await workspaces.list()).items
    if (!known.some((entry) => entry.available && entry.path === root)) throw new Error('workspace_missing')
    return root
  }
}

/**
 * Real session facts behind the managed-session contract: the same private local SDK path as chat,
 * webhook and scheduled sessions, so workspace ownership, Bundle review and admission apply unchanged.
 */
export function managedSessionPorts(deps: {
  socketPath: string
  sessionFactRead?: (sessionId: string) => ScanRead<EventEnvelope>
  serverIdentity: { pid: number; processStartId: string }
  records: ManagedSessionRecords
  authorize(caller: ManagedSessionCaller): Promise<void>
  forkParent(sessionId: string): string | undefined
  workspaces: Pick<WorkspaceCatalog, 'validate' | 'list' | 'restoreBinding'>
  models(): Promise<readonly { route: string; model: string }[]>
  registry: {
    get(key: string): Entry | undefined
    open(o: { key: string; cwd: string; binding: unknown }): Promise<Entry>
  }
  commandQueue: Parameters<typeof runQueued>[0]
  continueTurn(entry: Entry): void
  /** Whether `registry.open` turns outward command rules on for managed sessions and their lineage. */
  opensWithCommandRules: boolean
  /** Whether the platform's sandbox probe reports a full OS boundary; false when it cannot be read. */
  osBoundary(): Promise<boolean>
  /** The daemon's session preferences, where an owner's Web archive is recorded. */
  preferences: Pick<SessionPreferencesStore, 'get'>
  idle: Pick<IdleSignal, 'onIdle'>
  /** The shared worker's agent resolution over the daemon's own link (`sharedWorkerReads`); else through the local SDK. */
  resolveAgent?(bundle: string): Promise<void>
}) {
  const clients = new Set<NodeClient>()
  let closing = false
  const withClient = async <T>(work: (client: NodeClient) => Promise<T>): Promise<T> => {
    if (closing) throw new ManagedPortsClosed()
    const client = createClient({
      transport: {
        kind: 'unix',
        path: deps.socketPath,
        ...(deps.socketPath.startsWith('\\\\.\\pipe\\') ? { serverIdentity: deps.serverIdentity } : {}),
      },
      auth: { kind: 'local' },
      journal: memoryJournal('managed-sessions'),
    })
    clients.add(client)
    try {
      await client.initialize()
      return await work(client)
    } finally {
      // Sessions are durable; closing this transport does not end them.
      await client.close().finally(() => clients.delete(client))
    }
  }
  const view = (sessionId: string) =>
    withClient((client) =>
      client.call<SessionViewResult>('_agnes/v1/session.view', { sessionId, maxNodes: 5000 }),
    )
  const open = async (sessionId: string): Promise<Entry> => {
    const existing = deps.registry.get(sessionId)
    if (existing) return existing
    const binding = await deps.workspaces.restoreBinding(sessionId)
    return deps.registry.open({ key: sessionId, cwd: binding.canonicalRoot, binding })
  }
  const inputs = managedInputPorts({
    open,
    commandQueue: deps.commandQueue,
    continueTurn: deps.continueTurn,
    preferences: deps.preferences,
    ...(deps.sessionFactRead ? { sessionFactRead: deps.sessionFactRead } : {}),
  })
  const ports: ManagedSessionPorts = {
    authorize: deps.authorize,
    records: deps.records,
    forkParent: deps.forkParent,
    workspaceRoot: managedWorkspaceRoot(deps.workspaces),
    resolveAgent:
      deps.resolveAgent ??
      ((bundle) => withClient(async (client) => void (await client.agents.resolve(bundle)))),
    models: deps.models,
    autoReview: () =>
      withClient(
        async (client) =>
          (await client.call<{ enabled?: boolean }>('_agnes/v1/autoReview.get', {})).enabled === true,
      ),
    fullAccess: async () => ({
      outwardCheckpoint: deps.opensWithCommandRules,
      osBoundary: await deps.osBoundary().catch(() => false),
    }),
    sessions: {
      ...inputs,
      onIdle: (listener) => deps.idle.onIdle(listener),
      create: (input) =>
        withClient(async (client) => {
          const { id } = await client.createSession({
            cwd: input.cwd,
            agent: input.agent,
            sessionKey: input.sessionKey,
          })
          // Openers recognise a managed session by this key.
          if (id !== input.sessionKey) throw new Error('managed session opened under another key')
          return id
        }),
      setModel: (sessionId, model) =>
        withClient(async (client) => {
          await client.call('_agnes/v1/session.setModel', {
            sessionId,
            slot: 'primary',
            route: model.route,
            model: model.model,
          })
        }),
      setFullAccess: (sessionId) =>
        withClient(async (client) => {
          await client.call('_agnes/v1/session.setYolo', { sessionId, enabled: true })
        }),
      async policy(sessionId) {
        const entry = await open(sessionId)
        const outwardCheckpoint = await entry.session.outwardCheckpoint().catch(() => false)
        return withClient(async (client) => {
          const { policy } = await client.call<SessionRuntimeDescriptor>('_agnes/v1/session.runtime', {
            sessionId,
          })
          // A session whose policy cannot be read is treated as full access with no boundary.
          if (!policy) return { fullAccess: true, osBoundary: false, outwardCheckpoint }
          return {
            fullAccess: policy.permission?.policy === 'full-access' || policy.toolPolicy === 'full-access',
            osBoundary: policy.sandbox.enforcement?.level === 'full',
            outwardCheckpoint,
          }
        })
      },
      async submit(sessionId, input) {
        const submitted = await inputs.submitInput(sessionId, { ...input, dedupe: true })
        return submitted.state === 'busy' ? 'busy' : 'started'
      },
      loaded: (sessionId) => deps.registry.get(sessionId) !== undefined,
      activity: () =>
        withClient(
          async (client) =>
            (await client.call<SessionActivityResult>('_agnes/v1/session.activity', {})).items,
        ),
      view,
      ...(deps.sessionFactRead
        ? { openQuestion: (sessionId: string) => hasOpenNativeQuestion(deps.sessionFactRead!(sessionId)) }
        : {}),
      async toolDetail(sessionId, callSeq) {
        const node = (await view(sessionId)).timeline.nodes.find(
          (candidate) => candidate.kind === 'tool' && candidate.seq === callSeq,
        )
        if (node?.kind !== 'tool') throw new Error('tool call not found')
        return withClient(async (client) => {
          const session = await client.session.load(sessionId, { history: 'none' })
          return (await session.readToolDetail(callSeq, node.resultSeq)) as unknown as ManagedToolDetail
        })
      },
      async ownerApprover(sessionId) {
        const entry = await open(sessionId)
        return (await entry.session.resolveActor({ kind: 'local' }, 'approval')).id
      },
      cancel: (sessionId) =>
        withClient(async (client) => {
          await (await client.session.load(sessionId, { history: 'none' })).cancel()
        }),
      archive: (sessionId) =>
        withClient(async (client) => {
          await client.call('_agnes/v1/session.archive', { sessionId, archived: true })
        }),
    },
  }
  return {
    ports,
    async close() {
      closing = true
      await Promise.all([...clients].map((client) => client.close()))
    },
  }
}
