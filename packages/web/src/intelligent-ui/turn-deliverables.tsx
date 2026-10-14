import type { UITurn } from '@agnes/protocol'
import { validateAgainst } from '@agnes/protocol'
import type { UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
import { UiArtifactFileData } from '@agnes/protocol/gen/intelligent-ui'
import {
  Disclosure,
  INTELLIGENT_UI_NAMESPACE,
  intelligentUiCatalog,
  isDeliverableList,
  UiLocaleProvider,
  useUiText,
} from '@agnes/web-ui'
import { useMemo, useSyncExternalStore } from 'react'
import { ArtifactFile } from './artifact-file.js'
import { groupDeliverables, type TurnDeliverable } from './deliverable-labels.js'
import type { UiPlacementBinding } from './placements.js'

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

export function attachTurnDeliverables(binding: UiPlacementBinding): () => void {
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

/** The files a turn produced: every file-list surface the session created while the turn ran. */
export function turnDeliverables(
  surfaces: readonly UiSurfaceRecord[],
  turn: Pick<UITurn, 'startSeq' | 'endSeq'>,
): TurnDeliverable[] {
  return surfaces.flatMap((record) => {
    const { surface } = record
    if (
      !isDeliverableList(surface) ||
      !surface.placement.inline ||
      record.createdSeq < turn.startSeq ||
      (turn.endSeq !== undefined && record.createdSeq > turn.endSeq)
    )
      return []
    return surface.components.flatMap((component, index) => {
      if (!('dataKey' in component)) return []
      const parsed = validateAgainst<UiArtifactFileData>(UiArtifactFileData, surface.data[component.dataKey])
      return parsed.ok
        ? [
            {
              file: parsed.value,
              surfaceId: surface.id,
              revision: surface.revision,
              lane: record.lane,
              workbench: surface.placement.workbench,
              order: record.createdSeq * 1000 + index,
            },
          ]
        : []
    })
  })
}

/** Files shown inside the answer that produced them, one quiet card each. */
export function TurnDeliverables({ turn }: { turn: UITurn }) {
  const { binding, client, version: current } = useIntelligentBinding()
  // biome-ignore lint/correctness/useExhaustiveDependencies: `current` is the store version the list reads through.
  const entries = useMemo(
    () => (client ? turnDeliverables(client.getSnapshot().surfaces, turn) : []),
    [client, current, turn.startSeq, turn.endSeq],
  )
  if (!binding || !client || !entries.length) return null
  return (
    <UiLocaleProvider source={binding.locale}>
      <DeliverableGroup binding={binding} entries={entries} />
    </UiLocaleProvider>
  )
}

function DeliverableGroup({
  binding,
  entries,
}: {
  binding: UiPlacementBinding
  entries: readonly TurnDeliverable[]
}) {
  const { t } = useUiText(INTELLIGENT_UI_NAMESPACE, intelligentUiCatalog)
  const groups = groupDeliverables(entries)
  const card = (entry: TurnDeliverable) => (
    <ArtifactFile
      key={`${entry.surfaceId}:${entry.file.artifact.sha256}`}
      file={entry.file}
      laneId={entry.lane}
      resources={binding.resources}
      placement="inline"
      {...(entry.workbench
        ? { onShowInWorkbench: () => binding.expand(entry.surfaceId, entry.revision) }
        : {})}
    />
  )
  return (
    <section className="turn-deliverables" data-testid="turn-deliverables" aria-label={t('ui.deliverables')}>
      {groups.length > 1 && (
        <p className="turn-deliverables-head">{t('ui.deliverables.count', { count: groups.length })}</p>
      )}
      <ul className="turn-deliverables-list">
        {groups.map(({ latest, earlier }) => (
          <li key={latest.file.name} className="turn-deliverable">
            {card(latest)}
            {earlier.length > 0 && (
              <Disclosure
                variant="plain"
                className="turn-deliverable-earlier"
                data-testid="turn-deliverable-earlier"
                summary={t('ui.file.earlier', { count: earlier.length })}
              >
                <ul className="turn-deliverables-list">
                  {earlier.map((entry) => (
                    <li key={`${entry.surfaceId}:${entry.file.artifact.sha256}`}>{card(entry)}</li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
