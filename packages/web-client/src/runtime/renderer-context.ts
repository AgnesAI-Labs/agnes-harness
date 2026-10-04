// The renderer context the client host gives one mounted view. Each client call is first held to what
// the view currently offers: its command actions at its current revision, the artifact versions in its
// resources and download actions, and the interactions its actions name. Only then does the call reach
// the caller's services, which still apply the caller's authorization, the plugin's granted
// capabilities and the owner generation. A renderer cannot name another artifact, command or
// interaction to probe the user's other resources, and after dispose every call, including one from an
// old closure, is refused. The registry never builds a context; the client host does, through this.
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
  /** Refuses every later call, aborts `context.signal` and runs each cleanup once. Idempotent. */
  dispose(): Promise<void>
}

const refuse = (
  code: 'denied' | 'invalid_input' | 'conflict',
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

/** A structured copy, so a renderer cannot change what was checked before the service reads it. */
function copy<T>(value: T): T | undefined {
  try {
    return structuredClone(value)
  } catch {
    return undefined
  }
}

const artifactKey = (artifactId: unknown, version: unknown) => JSON.stringify([artifactId, version])

function allowedBy(view: DomainView) {
  const commands = new Set<string>()
  const interactions = new Set<string>()
  const artifacts = new Set<string>()
  for (const action of view.actions) {
    // A disabled action is shown to the user but not offered.
    if (action.availability !== 'enabled') continue
    if (action.kind === 'command') commands.add(action.actionKey)
    else if (action.kind === 'download') artifacts.add(artifactKey(action.artifactId, action.version))
    else interactions.add(action.interactionId)
  }
  for (const resource of view.resources) artifacts.add(artifactKey(resource.artifactId, resource.version))
  return { viewId: view.viewId, revision: view.revision, commands, interactions, artifacts }
}

export function createRendererContext(input: {
  clientInstanceId: string
  ownerToken: string
  capabilities: NegotiatedClientCapabilities
  services: Services
  view: DomainView
}): MountedRendererContext {
  const { services } = input
  let allowed = allowedBy(input.view)
  // Status reads are limited to requests this context sent, since a request id names no view target.
  const requests = new Set<string>()
  const responses = new Set<string>()
  const controller = new AbortController()
  const cleanups: (() => void | Promise<void>)[] = []
  let closed = false
  let closing: Promise<void> | undefined

  /** Runs `call` with a copy of `args` when the context is open and `admits` the copy. */
  function guarded<A extends [unknown, ...unknown[]], R>(
    what: string,
    args: A,
    admits: (...values: NoInfer<A>) => boolean,
    call: (...values: NoInfer<A>) => R,
  ): R | { ok: false; error: RuntimeError } {
    if (closed) return disposed()
    const values = copy(args)
    if (values === undefined || !admits(...values)) return outside(what)
    return call(...values)
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
          (value) => {
            requests.add(value.requestId)
            return services.commands.submit(value)
          },
        ),
      commandStatus: async (requestId) =>
        guarded(
          'the request',
          [requestId],
          (id) => requests.has(id),
          (id) => services.commands.commandStatus(id),
        ),
    },
    interactions: {
      // ponytail: listing pending interactions reaches past the view, so it is refused outright; a
      // renderer reads the interactions its actions name. Filter by those ids if a renderer needs it.
      pending: async () => (closed ? disposed() : outside('listing interactions')),
      read: async (interactionId) =>
        guarded('the interaction', [interactionId], hasInteraction, (id) => services.interactions.read(id)),
      respond: async (request) =>
        guarded(
          'the interaction',
          [request],
          (value) => hasInteraction(value?.interactionId) && typeof value.responseId === 'string',
          (value) => {
            responses.add(value.responseId)
            return services.interactions.respond(value)
          },
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
          (id) => responses.has(id),
          (id) => services.interactions.responseStatus(id),
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
      if (closed)
        void Promise.resolve()
          .then(cleanup)
          .catch(() => {})
      else cleanups.push(cleanup)
    },
  }

  return {
    context,
    update(view) {
      if (closed) return disposed()
      if (view?.viewId !== allowed.viewId) return refuse('invalid_input', 'view_mismatch', 'another view')
      if (!(view.revision >= allowed.revision))
        return refuse('conflict', 'stale_view', 'the view is older than the mounted revision')
      allowed = allowedBy(view)
      return { ok: true, value: undefined }
    },
    dispose() {
      closed = true
      closing ??= (async () => {
        controller.abort()
        // Newest first, like a stack of acquired resources. Each starts without waiting for the one
        // before, so a failing or hung cleanup stops none of the rest.
        const running = cleanups
          .splice(0)
          .reverse()
          .map(async (cleanup) => cleanup())
        await Promise.allSettled(running)
      })()
      return closing
    },
  }
}
