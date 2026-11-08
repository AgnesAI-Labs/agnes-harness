import type { BundleCatalog } from '@agnes/host-common/profile/composition'
import type { HostOptions, HostSession } from '../lifecycle/host.js'
import type { CompositionContainer as Container } from './composition-selection.js'
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
 * listener errors, so a listener only marks a key; all real work and its warning live in `flush`.
 */
export function createCompositionLiveStatus(
  input: Readonly<{
    containers: ReadonlyMap<string, Container>
    writer: { writeFragments(fragments: readonly string[]): void }
    bundles: BundleCatalog | undefined
    log: HostOptions['log']
    /** A flush found a live session in this container, so its idle period has not started. */
    sessionSeen: (container: Container) => void
    /** A flush found a session closed or gone; called before any description can fail. */
    onSessionGone: () => void
  }>,
) {
  const described = new Map<string, string>()
  const dirty = new Set<string>()
  const subscriptions = new Map<string, Subscriptions>()
  const watched = new Map<Container, () => void>()
  let scheduled = false
  let closed = false
  // A session that started closing no longer counts as open, even before its Host removes it.
  const open = () => {
    const sessions = new Map<string, { container: Container; session: HostSession }>()
    for (const container of input.containers.values())
      for (const session of container.host.kernel.sessions.values())
        if (!session.closingOrClosed) sessions.set(session.key, { container, session })
    return sessions
  }
  const describe = ({ container, session }: { container: Container; session: HostSession }) =>
    describeCapabilitySession(container.host, session, container.tree, input.bundles)
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
    entry.closed ??= session.onClosed(() => markDirty([key]))
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
      for (const { container } of sessions.values()) input.sessionSeen(container)
      if (gone) input.onSessionGone()
      // A key leaves the dirty set only once described, so a failure is retried on the next change.
      for (const key of dirty) {
        const found = sessions.get(key)
        if (found) {
          subscribe(key, found.session)
          described.set(key, JSON.stringify(describe(found)))
        }
        dirty.delete(key)
      }
      input.writer.writeFragments([...described.values()])
    } catch (error) {
      input.log.warn('Composition live status could not be written', { error: String(error) })
    }
  }
  return {
    markDirty,
    /** After a publication every session may have changed, including the registries it reads. */
    markAll: () =>
      markDirty([...input.containers.values()].flatMap(({ host }) => [...host.kernel.sessions.keys()])),
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
      const live = new Set(input.containers.values())
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
