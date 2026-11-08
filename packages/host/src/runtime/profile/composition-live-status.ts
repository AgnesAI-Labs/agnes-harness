import type { BundleCatalog, ResolvedComposition } from '@agnes/host-common/profile/composition'
import type { Host, HostOptions, HostSession } from '../lifecycle/host.js'
import { describeCapabilitySession } from './session-capability-view.js'

type Subscriptions = {
  session: HostSession
  tools?: () => void
  resources?: () => void
  toolsSource?: object
  resourcesSource?: object
  settings?: () => void
  closed?: () => void
}

/**
 * Live composition status, published when one of its inputs changes. Each open session's description
 * is cached as its JSON fragment; a change marks only the affected sessions dirty, and a microtask
 * describes them again and hands every fragment to the writer. Core and the registries swallow
 * listener errors, so a listener only marks a key; all real work and its warnings live in `flush`.
 * Both Hosts publish through it: the composition Host with one container per composition, a legacy
 * Host as its own single container. Each Host marks the changes it alone sees (publications, a
 * failed preset switch, a session its Host bound after the kernel announced it).
 */
export function createCompositionLiveStatus<Container extends { host: Host }>(
  input: Readonly<{
    /** The containers whose kernels hold the published sessions. */
    containers: () => Iterable<Container>
    /** The composition a session of this container is described against. */
    tree: (container: Container, session: HostSession) => ResolvedComposition
    bundles: BundleCatalog | undefined
    writer: { writeFragments(fragments: readonly string[]): void }
    log?: HostOptions['log'] | undefined
    /** A flush found a live session in this container, so its idle period has not started. */
    sessionSeen?: (container: Container) => void
    /** A flush found a session closed or gone; called before any description can fail. */
    onSessionGone?: () => void
  }>,
) {
  const described = new Map<string, string>()
  const dirty = new Set<string>()
  const subscriptions = new Map<string, Subscriptions>()
  const watched = new Map<Container, () => void>()
  /** Sessions whose close completed; a closed session can stay in its kernel's table. */
  const finished = new WeakSet<HostSession>()
  let scheduled = false
  let closed = false
  // A session is listed until its close completes. `closingOrClosed` also covers an idle retirement
  // claim, which reverts when retirement loses its race, so it only keeps out a session never listed:
  // one already closing when first seen has no close notice to wait for.
  const open = () => {
    const sessions = new Map<string, { container: Container; session: HostSession }>()
    for (const container of input.containers())
      for (const session of container.host.kernel.sessions.values())
        if (
          !finished.has(session) &&
          (subscriptions.get(session.key)?.session === session || !session.closingOrClosed)
        )
          sessions.set(session.key, { container, session })
    return sessions
  }
  const describe = ({ container, session }: { container: Container; session: HostSession }) =>
    describeCapabilitySession(container.host, session, input.tree(container, session), input.bundles)
  const markDirty = (keys: Iterable<string>): void => {
    for (const key of keys) dirty.add(key)
    if (scheduled || !dirty.size) return
    scheduled = true
    queueMicrotask(flush)
  }
  const unsubscribe = (key: string) => {
    const entry = subscriptions.get(key)
    for (const off of [entry?.tools, entry?.resources, entry?.settings, entry?.closed]) off?.()
    subscriptions.delete(key)
  }
  // One closure per subscription: a table dedups listeners by identity, and sessions share tables.
  // A preset, tool filter or runtime publication can swap the registry object, so follow the current one.
  const subscribe = (key: string, session: HostSession) => {
    if (subscriptions.get(key)?.session !== session) unsubscribe(key)
    const entry = subscriptions.get(key) ?? { session }
    subscriptions.set(key, entry)
    entry.settings ??= session.onSettingsChanged(() => markDirty([key]))
    entry.closed ??= session.onClosed(() => {
      finished.add(session)
      markDirty([key])
    })
    const tools = session.currentTools()
    if (entry.toolsSource !== tools) {
      entry.tools?.()
      entry.toolsSource = tools
      entry.tools = tools.onChange(() => markDirty([key]))
    }
    const resources = session.currentResources()
    if (entry.resourcesSource !== resources) {
      entry.resources?.()
      entry.resourcesSource = resources
      entry.resources = resources.onChange(() => markDirty([key]))
    }
  }
  // The flush runs in a microtask, where a throw would crash the worker; not even a logger may throw.
  const warn = (message: string, error: unknown, sessionKey?: string) => {
    try {
      input.log?.warn(message, { ...(sessionKey === undefined ? {} : { sessionKey }), error: String(error) })
    } catch {
      // Inspection never changes session admission.
    }
  }
  const flush = (): void => {
    scheduled = false
    if (closed) return
    try {
      const sessions = open()
      let gone = false
      for (const key of new Set([...described.keys(), ...subscriptions.keys(), ...dirty]))
        if (!sessions.has(key)) {
          unsubscribe(key)
          described.delete(key)
          dirty.delete(key)
          gone = true
        }
      if (input.sessionSeen) for (const { container } of sessions.values()) input.sessionSeen(container)
      if (gone) input.onSessionGone?.()
      // Each session on its own: a failure keeps that session's previous fragment and leaves its key
      // dirty for the next change (no new microtask, so a lasting failure cannot spin), and every
      // other session is still subscribed, described and written.
      for (const key of [...dirty]) {
        const found = sessions.get(key)
        try {
          if (found) {
            subscribe(key, found.session)
            described.set(key, JSON.stringify(describe(found)))
          }
          dirty.delete(key)
        } catch (error) {
          warn('Composition live status could not describe a session', error, key)
        }
      }
      input.writer.writeFragments([...described.values()])
    } catch (error) {
      warn('Composition live status could not be written', error)
    }
  }
  return {
    markDirty,
    /** After a publication every session may have changed, including the registries it reads. */
    markAll: () => markDirty([...input.containers()].flatMap(({ host }) => [...host.kernel.sessions.keys()])),
    /** Sessions opened by any path, including role and Core children, which no Host wrapper sees. */
    watch(container: Container): void {
      watched.set(
        container,
        container.host.kernel.onSessionOpened((session) => {
          if (!session.closingOrClosed) markDirty([session.key])
        }),
      )
    },
    /** Drops the listeners of containers that were collected or closed. */
    unwatchClosed(): void {
      const live = new Set(input.containers())
      for (const [container, off] of watched)
        if (!live.has(container)) {
          off()
          watched.delete(container)
        }
    },
    /** The admin read describes on demand; it is rare and must not depend on the published file. */
    sessions: () => [...open().values()].map(describe),
    close(): void {
      closed = true
      for (const off of watched.values()) off()
      watched.clear()
      for (const key of [...subscriptions.keys()]) unsubscribe(key)
    },
  }
}
