import type { UITurn, UiSurfaceRecord } from '@agnes/protocol'
import { rendersInAnswer, UiLocaleProvider } from '@agnes/web-ui'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { BoundSurface, type UiPlacementBinding } from './placements.js'

/** The session's placement binding, set while the intelligent UI is mounted. */
let active: UiPlacementBinding | undefined
let generation = 0
const listeners = new Set<() => void>()
const notify = () => {
  generation++
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const version = () => `${generation}:${active?.getVersion() ?? 0}`

export function attachIntelligentBinding(binding: UiPlacementBinding): () => void {
  active = binding
  const stop = binding.subscribe(notify)
  notify()
  return () => {
    stop()
    if (active === binding) active = undefined
    notify()
  }
}

/** The mounted session's placement binding and client, re-read whenever either changes. */
export function useIntelligentBinding(): {
  binding: UiPlacementBinding | undefined
  client: ReturnType<UiPlacementBinding['getSnapshot']>
  version: string
} {
  const current = useSyncExternalStore(subscribe, version)
  return { binding: active, client: active?.getSnapshot(), version: current }
}

/**
 * The views a turn produced and still shows inline: those the session lists, created while the turn
 * ran, plus the ones the turn's ui_render results name (a closed view is read back by id).
 */
export function turnSurfaceIds(
  surfaces: readonly UiSurfaceRecord[],
  turn: Pick<UITurn, 'startSeq' | 'endSeq'>,
  named: readonly string[],
  known: (id: string) => UiSurfaceRecord | undefined,
): string[] {
  const listed = surfaces
    .filter(
      (record) =>
        record.createdSeq >= turn.startSeq && (turn.endSeq === undefined || record.createdSeq <= turn.endSeq),
    )
    .map((record) => record.surface.id)
  const ids = [...new Set([...named, ...listed])]
  return ids
    .flatMap((id) => {
      const record = known(id)
      return record && rendersInAnswer(record.surface) ? [record] : []
    })
    .sort((a, b) => a.createdSeq - b.createdSeq)
    .map((record) => record.surface.id)
}

export function TurnViews({ turn, surfaceIds = [] }: { turn: UITurn; surfaceIds?: readonly string[] }) {
  const { binding, client, version: current } = useIntelligentBinding()
  const named = surfaceIds.join('\n')
  useEffect(() => {
    if (!client) return
    for (const id of named ? named.split('\n') : []) void client.lookup(id)
  }, [client, named])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `current` is the store version the list reads through.
  const views = useMemo(
    () =>
      client
        ? turnSurfaceIds(client.getSnapshot().surfaces, turn, named ? named.split('\n') : [], (id) =>
            client.knownRecord(id),
          )
        : [],
    [client, current, named, turn.startSeq, turn.endSeq],
  )
  if (!binding || !client || !views.length) return null
  return (
    <UiLocaleProvider source={binding.locale}>
      {views.map((id) => (
        <BoundSurface
          key={`${id}:${client.knownRecord(id)?.surface.revision}:${client.knownRecord(id)?.status}`}
          binding={binding}
          client={client}
          id={id}
          placement="inline"
          inAnswer={true}
        />
      ))}
    </UiLocaleProvider>
  )
}
