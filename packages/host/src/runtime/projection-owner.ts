import {
  createProjectionProvider,
  type DomainCommandStorage,
  type ProjectionProviderOptions,
} from '@agnes/core'
import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type {
  ClientCallHeader,
  ClientOperationTypes,
  DomainEventRecord,
  RuntimeError,
  UIOpeningResult,
} from '@agnes/protocol/runtime'
import type { HostRuntimeClientCaller, HostRuntimeClientInstallation } from './client-ports.js'
import { captureIdentityContextFence } from './identity/authority.js'

type Operation =
  | 'conversation.open'
  | 'conversation.history'
  | 'conversation.list'
  | 'domain.query'
  | 'domain.commandStatus'
type ReadPort<K extends Operation> = (
  input: ClientOperationTypes[K]['input'],
  context: CallContext,
) => Promise<Outcome<ClientOperationTypes[K]['output']>>

/** The selected provider instance stays in Host; daemon receives only client read adapters. */
export type HostProjectionProvider = Readonly<{
  openConversation: ReadPort<'conversation.open'>
  conversationHistory: ReadPort<'conversation.history'>
  listConversations: ReadPort<'conversation.list'>
  snapshot: ReadPort<'domain.query'>
  commandStatus: ReadPort<'domain.commandStatus'>
  refresh(): Promise<RuntimeError | null>
  close(): void
}>

type Issue = (
  caller: HostRuntimeClientCaller,
  request: Readonly<{ operation: Operation; input: unknown; header: ClientCallHeader }>,
  signal: AbortSignal,
) => Promise<Outcome<CallContext>>

/** Selected domain facts and the original issuer come from trusted deployment assembly. */
export type HostProjectionInstallation = Readonly<
  Omit<ProjectionProviderOptions, 'native' | 'journal' | 'owner'> & {
    owner: Omit<ProjectionProviderOptions['owner'], 'storage'>
    issue?: Issue
    disposeContextIssuer?(): void | Promise<void>
  }
>

/** Trusted assembly inputs; Storage preserves the accepted-command port's concrete type. */
export type HostProjectionSources<Storage> = Readonly<{
  commandStorage: Storage
  journal(afterSequence: number, limit: number): Promise<readonly DomainEventRecord[]>
  subscribeCommitted(listener: () => Promise<RuntimeError | null>): () => void
  native: Readonly<{
    head(sessionId: string): Readonly<{ generation: number; upto: number }>
    page(
      sessionId: string,
      beforeIndex: number | null,
      limit: number,
      context: CallContext,
    ): Promise<Outcome<UIOpeningResult>>
  }>
}>

export type HostProjectionOwner = Readonly<{
  installation: HostRuntimeClientInstallation
  /** Called after a durable commit; a failed refresh does not undo the commit. */
  committed(): Promise<RuntimeError | null>
  close(): Promise<void>
}>

const fault = (detailCode: string, code: RuntimeError['code'] = 'incompatible'): RuntimeError => ({
  code,
  detailCode,
  message: detailCode,
  diagnosticId: 'host-projection-owner',
  retryAdvice: { kind: 'never' },
})
const refuse = (detailCode: string, code?: RuntimeError['code']): Outcome<never> => ({
  ok: false,
  error: fault(detailCode, code),
})

/** Host-internal assembly seam. Test fixtures can supply a provider before a deployment installs one. */
export function assembleHostProjectionOwner(
  options: Readonly<{
    provider?: HostProjectionProvider
    issue?: Issue
    /** Releases only the issuer connection owned by this installation, after reads drain. */
    disposeContextIssuer?(): void | Promise<void>
    unavailable?: string
    /** The store owner invokes this only after commit, never from inside its transaction. */
    subscribeCommitted?(listener: () => Promise<RuntimeError | null>): () => void
  }>,
): HostProjectionOwner {
  let closed = false
  const lifetime = new AbortController()
  let refreshing: Promise<RuntimeError | null> = Promise.resolve(null)
  const active = new Set<Promise<unknown>>()
  const track = <T>(work: Promise<T>): Promise<T> => {
    active.add(work)
    void work.then(
      () => active.delete(work),
      () => active.delete(work),
    )
    return work
  }
  const committed = (): Promise<RuntimeError | null> => {
    if (closed) return Promise.resolve(fault('projection_owner_closed'))
    if (!options.provider)
      return Promise.resolve(fault(options.unavailable ?? 'projection_provider_unavailable'))
    const provider = options.provider
    refreshing = refreshing.then(async () => {
      try {
        return await provider.refresh()
      } catch {
        return fault('projection_refresh_failed', 'internal')
      }
    })
    return track(refreshing)
  }
  const via =
    <K extends Operation>(operation: K, port: ReadPort<K> | undefined) =>
    (
      input: ClientOperationTypes[K]['input'],
      header: ClientCallHeader,
      caller: HostRuntimeClientCaller,
    ): Promise<Outcome<ClientOperationTypes[K]['output']>> =>
      track(
        (async () => {
          if (closed) return refuse('projection_owner_closed')
          if (!port) return refuse(options.unavailable ?? 'projection_provider_unavailable')
          if (!options.issue) return refuse('projection_context_issuer_unavailable', 'denied')
          let issued: Outcome<CallContext>
          try {
            issued = await options.issue(caller, { operation, input, header }, lifetime.signal)
          } catch {
            return refuse('projection_context_issuance_failed', 'denied')
          }
          if (!issued.ok) return issued
          const context = issued.value
          // Recapture after each await so the issuer rechecks dynamic source/role revocation too.
          const current = () => captureIdentityContextFence(context)?.() === true
          if (context.signal !== lifetime.signal || !current())
            return refuse('projection_context_not_current', 'denied')
          const error = await refreshing
          if (closed) return refuse('projection_owner_closed')
          if (error) return { ok: false, error }
          if (context.signal.aborted) return refuse('cancelled', 'cancelled')
          if (!current()) return refuse('projection_context_not_current', 'denied')
          const result = await port(input, context)
          if (closed) return refuse('projection_owner_closed')
          if (!current()) return refuse('projection_context_not_current', 'denied')
          return result
        })(),
      )
  const installation: HostRuntimeClientInstallation = {
    // Issuance and original C14 current-fence checks occur inside every query, before backend access.
    authorize: async () => ({ ok: true, value: true }),
    queries: {
      'conversation.open': via(
        'conversation.open',
        options.provider?.openConversation.bind(options.provider),
      ),
      'conversation.history': via(
        'conversation.history',
        options.provider?.conversationHistory.bind(options.provider),
      ),
      'conversation.list': via(
        'conversation.list',
        options.provider?.listConversations.bind(options.provider),
      ),
      'domain.query': via('domain.query', options.provider?.snapshot.bind(options.provider)),
      'domain.commandStatus': via(
        'domain.commandStatus',
        options.provider?.commandStatus.bind(options.provider),
      ),
    },
  }
  let unsubscribe: (() => void) | undefined
  try {
    unsubscribe = options.provider ? options.subscribeCommitted?.(committed) : undefined
  } catch (error) {
    lifetime.abort()
    options.provider?.close()
    throw error
  }
  let closing: Promise<void> | undefined
  return {
    installation,
    committed,
    close() {
      if (closing) return closing
      closed = true
      closing = (async () => {
        try {
          unsubscribe?.()
        } finally {
          lifetime.abort()
          await Promise.allSettled([...active])
          try {
            await options.disposeContextIssuer?.()
          } finally {
            options.provider?.close()
          }
        }
      })()
      return closing
    },
  }
}

/** Construct the selected Core provider over the command owner's original committed sources. */
export function createHostProjectionOwner<Storage extends DomainCommandStorage>(
  sources?: HostProjectionSources<Storage>,
  installation?: HostProjectionInstallation,
): HostProjectionOwner {
  if (!sources || !installation)
    return assembleHostProjectionOwner({ unavailable: 'projection_provider_installation_unavailable' })
  const { issue, disposeContextIssuer, owner, ...selected } = installation
  const provider = createProjectionProvider({
    ...selected,
    owner: { ...owner, storage: sources.commandStorage },
    native: sources.native,
    journal: sources.journal,
  })
  return assembleHostProjectionOwner({
    provider,
    ...(issue ? { issue } : {}),
    ...(disposeContextIssuer ? { disposeContextIssuer } : {}),
    subscribeCommitted: sources.subscribeCommitted,
  })
}
