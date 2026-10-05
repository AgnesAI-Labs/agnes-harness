// The renderer context the client host gives one mounted view. Each client call is first held to what
// the view currently offers: its command actions at its current revision, the artifact versions in its
// resources and download actions, and the interactions its actions name. Only then does the call reach
// the caller's services, which still apply the caller's authorization, the plugin's granted
// capabilities and the owner generation. A renderer cannot name another artifact, command or
// interaction to probe the user's other resources, nor read the status of a request or response no
// context of its presenter sent for the view. After dispose every call, including one from an old
// closure, is refused, and the cleanups run once the calls already in flight settle, draining and
// cleanups under one dispose deadline. The registry never builds a context; the client host does, through
// this.
import type {
  DomainView,
  NegotiatedClientCapabilities,
  Outcome,
  RendererContext,
  RuntimeError,
} from '@agnes/extension-api/client'

type Services = Pick<RendererContext, 'commands' | 'interactions' | 'artifacts' | 'locale'>

export interface MountedRendererContext {
  readonly context: RendererContext
  /** Moves the restriction to a newer revision of the same view. */
  update(view: DomainView): Outcome<void>
  /** Open until dispose, then draining until the calls in flight settle, then disposed. */
  state(): 'open' | 'draining' | 'disposed'
  /**
   * Refuses every later call, aborts `context.signal`, lets the calls in flight settle and runs each
   * cleanup once, all within `disposeMs`; the cleanups start at the deadline at the latest. Resolves
   * whether everything finished in time. Idempotent.
   */
  dispose(): Promise<boolean>
}

const refuse = (
  code: 'denied' | 'invalid_input' | 'conflict' | 'quota',
  detailCode: string,
  message: string,
): { ok: false; error: RuntimeError } => ({
  ok: false,
  error: {
    code,
    detailCode,
    message,
    retryAdvice: { kind: 'never' },
    diagnosticId: 'web-client-renderer-context',
  },
})

const outside = (what: string) =>
  refuse('denied', 'outside_view', `${what} is not offered by the mounted view`)
const disposed = () => refuse('denied', 'renderer_disposed', 'the renderer was disposed')
const full = () =>
  refuse('quota', 'client_command_index_full', 'the view holds too many sends that may still change')

/** A structured copy, so a renderer cannot change what was checked before the service reads it. */
function copy<T>(value: T): T | undefined {
  try {
    return structuredClone(value)
  } catch {
    return undefined
  }
}

const artifactKey = (artifactId: unknown, version: unknown) => JSON.stringify([artifactId, version])

function allowedBy(view: DomainView, negotiated: readonly string[]) {
  const commands = new Set<string>()
  const interactions = new Set<string>()
  const artifacts = new Set<string>()
  for (const action of view.actions) {
    // A disabled action is shown to the user but not offered, and neither is one needing a feature this
    // client did not negotiate.
    const usable =
      action.availability === 'enabled' &&
      Array.isArray(action.requiredFeatures) &&
      action.requiredFeatures.every((feature) => negotiated.includes(feature))
    if (!usable) continue
    if (action.kind === 'command') commands.add(action.actionKey)
    else if (action.kind === 'download') artifacts.add(artifactKey(action.artifactId, action.version))
    // An action of a kind this client does not know offers nothing.
    else if (action.kind === 'interaction' || action.kind === 'open-form')
      interactions.add(action.interactionId)
  }
  for (const resource of view.resources) artifacts.add(artifactKey(resource.artifactId, resource.version))
  return { viewId: view.viewId, revision: view.revision, commands, interactions, artifacts }
}

type Sent = 'request' | 'response'

// The answers after which a command or a response can change no more. An accepted, running or
// unknown_effect command and an accepted response still may.
const FINAL = new Set<unknown>(['succeeded', 'failed', 'cancelled', 'not-accepted', 'applied', 'rejected'])
// The refusals of a first send after which it was not accepted; a timeout or a cancel may have reached it.
const UNSENT = new Set<unknown>(['invalid_input', 'denied', 'incompatible', 'conflict', 'quota'])
const PER_VIEW = 128
const PER_INDEX = 1024

/**
 * The request and response ids the contexts of one presenter sent, per view, oldest first. A request id
 * names no view target, so a status read is held to the ids sent for its view through any lease, owner
 * or generation; it grants nothing on the server, which checks each read again. A full view, or a full
 * index, forgets its oldest settled id for a new one, and refuses the new one while every id may change;
 * only the user frees one that may, by archiving an id whose effect stays unknown.
 */
export function createViewIndex() {
  // An open id may still change, a settled one cannot, and an unknown one may have taken effect unseen.
  const entries = new Map<string, { viewId: string; state: 'open' | 'settled' | 'unknown' }>()
  const key = (viewId: string, kind: Sent, id: string) => JSON.stringify([viewId, kind, id])
  return {
    has: (viewId: string, kind: Sent, id: string) => entries.has(key(viewId, kind, id)),
    /** Records `id` before it is sent: new, resent, or full when there is no room for it. */
    add(viewId: string, kind: Sent, id: string): 'new' | 'resent' | 'full' {
      const known = entries.get(key(viewId, kind, id))
      // A resend may be accepted this time, so the id may change again; it takes no new entry.
      if (known !== undefined) {
        known.state = 'open'
        return 'resent'
      }
      let inView = 0
      for (const entry of entries.values()) if (entry.viewId === viewId) inView++
      if (inView >= PER_VIEW || entries.size >= PER_INDEX) {
        // A full view forgets one of its own ids, a full index one of any view.
        const own = inView >= PER_VIEW
        const oldest = [...entries].find(
          ([, entry]) => entry.state === 'settled' && (!own || entry.viewId === viewId),
        )
        if (oldest === undefined) return 'full'
        entries.delete(oldest[0])
      }
      entries.set(key(viewId, kind, id), { viewId, state: 'open' })
      return 'new'
    },
    /**
     * Notes what a send or status read of `id` answered. A refusal leaves the entry as it was, unless it
     * ends a first send: refused outright, it was never accepted; otherwise it may have reached the server.
     */
    saw(viewId: string, kind: Sent, id: string, outcome: unknown, first = false) {
      const entry = entries.get(key(viewId, kind, id))
      const answer = outcome as
        | { ok?: unknown; value?: { status?: unknown }; error?: { code?: unknown } }
        | undefined
      if (entry === undefined) return
      const status = answer?.value?.status
      if (answer?.ok === true)
        entry.state = FINAL.has(status) ? 'settled' : status === 'unknown_effect' ? 'unknown' : 'open'
      else if (first) entry.state = UNSENT.has(answer?.error?.code) ? 'settled' : 'unknown'
    },
    /**
     * Forgets `id` when its effect stays unknown, once the user chose to archive it after being told it
     * loses the local follow-up. Only this local entry goes: the server keeps the command, its
     * deduplication and its audit, and the id can still be read with fresh authentication.
     */
    archive(viewId: string, kind: Sent, id: string): boolean {
      const at = key(viewId, kind, id)
      return entries.get(at)?.state === 'unknown' && entries.delete(at)
    },
  }
}

export type ViewIndex = ReturnType<typeof createViewIndex>

export function createRendererContext(input: {
  clientInstanceId: string
  ownerToken: string
  capabilities: NegotiatedClientCapabilities
  services: Services
  view: DomainView
  /** The presenter's index of what its contexts sent per view. */
  index: ViewIndex
  /** The one deadline dispose holds draining and the cleanups to. */
  disposeMs: number
}): MountedRendererContext {
  const { services, index } = input
  // A capability set without a feature list negotiated none.
  const negotiated: readonly string[] = Array.isArray(input.capabilities?.features)
    ? [...input.capabilities.features]
    : []
  let allowed = allowedBy(input.view, negotiated)
  const controller = new AbortController()
  const cleanups: (() => void | Promise<void>)[] = []
  // Each service call this context made, until it settles.
  const inflight = new Set<Promise<unknown>>()
  let phase: 'open' | 'draining' | 'disposed' = 'open'
  let closing: Promise<boolean> | undefined

  /** Runs `call` with a copy of `args` when the context is open and `admits` the copy. */
  function guarded<A extends [unknown, ...unknown[]], R>(
    what: string,
    args: A,
    admits: (...values: NoInfer<A>) => boolean,
    call: (...values: NoInfer<A>) => R,
  ): R | { ok: false; error: RuntimeError } {
    if (phase !== 'open') return disposed()
    const values = copy(args)
    if (values === undefined || !admits(...values)) return outside(what)
    const result = call(...values)
    if (result instanceof Promise) {
      const settled: Promise<unknown> = result.catch(() => {}).then(() => inflight.delete(settled))
      inflight.add(settled)
    }
    return result
  }

  /** Hands an answer about `id` on as it is, after noting in the index whether it is final. */
  const noted =
    (kind: Sent, id: string, first = false) =>
    <O>(outcome: O): O => {
      index.saw(allowed.viewId, kind, id, outcome, first)
      return outcome
    }
  /** Sends `id` through `send` once the index has room for it. */
  const sent = <O>(kind: Sent, id: string, send: () => Promise<O>) => {
    const added = index.add(allowed.viewId, kind, id)
    return added === 'full' ? full() : send().then(noted(kind, id, added === 'new'))
  }

  const hasArtifact = (artifactId: unknown, version: unknown) =>
    allowed.artifacts.has(artifactKey(artifactId, version))
  const byArtifact = <Q extends { artifactId: string; version: number }, R>(
    request: Q,
    call: (value: Q) => R,
  ) => guarded('the artifact', [request], (value) => hasArtifact(value?.artifactId, value?.version), call)
  const hasInteraction = (interactionId: unknown) =>
    typeof interactionId === 'string' && allowed.interactions.has(interactionId)

  const context: RendererContext = {
    clientInstanceId: input.clientInstanceId,
    ownerToken: input.ownerToken,
    signal: controller.signal,
    capabilities: structuredClone(input.capabilities),
    commands: {
      submit: async (request) =>
        guarded(
          'the action',
          [request],
          (value) =>
            value?.action?.viewId === allowed.viewId &&
            value.action.viewRevision === allowed.revision &&
            allowed.commands.has(value.action.actionKey) &&
            typeof value.requestId === 'string',
          (value) => sent('request', value.requestId, () => services.commands.submit(value)),
        ),
      commandStatus: async (requestId) =>
        guarded(
          'the request',
          [requestId],
          (id) => index.has(allowed.viewId, 'request', id),
          (id) => services.commands.commandStatus(id).then(noted('request', id)),
        ),
    },
    interactions: {
      // ponytail: listing pending interactions reaches past the view, so it is refused outright; a
      // renderer reads the interactions its actions name. Filter by those ids if a renderer needs it.
      pending: async () => (phase !== 'open' ? disposed() : outside('listing interactions')),
      read: async (interactionId) =>
        guarded('the interaction', [interactionId], hasInteraction, (id) => services.interactions.read(id)),
      respond: async (request) =>
        guarded(
          'the interaction',
          [request],
          (value) => hasInteraction(value?.interactionId) && typeof value.responseId === 'string',
          (value) => sent('response', value.responseId, () => services.interactions.respond(value)),
        ),
      formLink: async (interactionId, expectedVersion) =>
        guarded(
          'the interaction',
          [interactionId, expectedVersion],
          (id, _version) => hasInteraction(id),
          (id, version) => services.interactions.formLink(id, version),
        ),
      responseStatus: async (responseId) =>
        guarded(
          'the response',
          [responseId],
          (id) => index.has(allowed.viewId, 'response', id),
          (id) => services.interactions.responseStatus(id).then(noted('response', id)),
        ),
    },
    artifacts: {
      describe: async (artifactId, version) =>
        guarded('the artifact', [artifactId, version], hasArtifact, (id, at) =>
          services.artifacts.describe(id, at),
        ),
      openDownload: async (request) => byArtifact(request, (value) => services.artifacts.openDownload(value)),
      readRange: async (request) => byArtifact(request, (value) => services.artifacts.readRange(value)),
      openStream: async (request) => byArtifact(request, (value) => services.artifacts.openStream(value)),
      followDownload: (ticket) => byArtifact(ticket, (value) => services.artifacts.followDownload(value)),
    },
    // Formatting reads no user resource, so locale calls pass through.
    locale: services.locale,
    onDispose(cleanup) {
      if (typeof cleanup !== 'function') return
      if (phase === 'disposed')
        void Promise.resolve()
          .then(cleanup)
          .catch(() => {})
      else cleanups.push(cleanup)
    },
  }

  return {
    context,
    state: () => phase,
    update(view) {
      if (phase !== 'open') return disposed()
      if (view?.viewId !== allowed.viewId) return refuse('invalid_input', 'view_mismatch', 'another view')
      if (!(view.revision >= allowed.revision))
        return refuse('conflict', 'stale_view', 'the view is older than the mounted revision')
      allowed = allowedBy(view, negotiated)
      return { ok: true, value: undefined }
    },
    dispose() {
      if (phase === 'open') phase = 'draining'
      closing ??= (async () => {
        controller.abort()
        let timer: ReturnType<typeof setTimeout> | undefined
        const late = new Promise<false>((resolve) => {
          timer = setTimeout(resolve, input.disposeMs, false)
        })
        // The calls in flight settle first, so their results reach the renderer as they are before its
        // cleanups run; draining and the cleanups share the deadline, and none gets time of its own.
        const drained = await Promise.race([Promise.allSettled(inflight).then(() => true), late])
        phase = 'disposed'
        // Newest first, like a stack of acquired resources. Each starts without waiting for the one
        // before, so a failing or hung cleanup stops none of the rest.
        const running = cleanups
          .splice(0)
          .reverse()
          .map(async (cleanup) => cleanup())
        const done = drained && (await Promise.race([Promise.allSettled(running).then(() => true), late]))
        clearTimeout(timer)
        return done
      })()
      return closing
    },
  }
}
