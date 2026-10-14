import type { FactChainParams, UITimeline } from '@agnes/protocol'
import type { UiSurfaceRecord } from '@agnes/protocol/gen/intelligent-ui'
import {
  factChainLinks,
  type UiExtensionContext,
  type WorkbenchPanelCount,
  workbenchNavigation,
} from '@agnes/web-client'
import { Button, Disclosure, Icon, SettingsState, UiLocaleProvider } from '@agnes/web-ui'
import { useState, useSyncExternalStore } from 'react'
import { ArtifactFile } from './artifact-file.js'
import {
  deliverableVersion,
  type EarlierVersion,
  groupDeliverables,
  type TurnDeliverable,
} from './deliverable-labels.js'
import type { UiPlacementBinding } from './placements.js'
import { surfaceDeliverables } from './turn-deliverables.js'

export const DELIVERABLES_PANEL = 'deliverables'
type Group = 'final' | 'review' | 'other'
const GROUPS: readonly Group[] = ['final', 'review', 'other']
const entryKey = (entry: TurnDeliverable) => `${entry.surfaceId}:${entry.file.artifact.sha256}`

/** Every file the session's file lists hand over, oldest first; a later entry is a newer version. */
export function sessionDeliverables(surfaces: readonly UiSurfaceRecord[]): TurnDeliverable[] {
  return surfaces.flatMap(surfaceDeliverables).sort((a, b) => a.order - b.order)
}

/**
 * The newest version of each file, grouped by the version its description names (最终版 / 审阅稿),
 * and every older version in one folded list.
 */
export function deliverableGroups(entries: readonly TurnDeliverable[]): {
  groups: { group: Group; entries: TurnDeliverable[] }[]
  earlier: (TurnDeliverable & { version: EarlierVersion })[]
} {
  const named = groupDeliverables(entries)
  const groupOf = (entry: TurnDeliverable): Group => {
    const version = deliverableVersion(entry.file.description)
    if (version && 'key' in version) return version.key === 'ui.file.final' ? 'final' : 'review'
    return 'other'
  }
  return {
    groups: GROUPS.map((group) => ({
      group,
      entries: named.map((item) => item.latest).filter((entry) => groupOf(entry) === group),
    })).filter((item) => item.entries.length > 0),
    earlier: named.flatMap((item) => item.earlier),
  }
}

const sessionOf = (context: UiExtensionContext) =>
  (context.data as { session?: { id: string } } | undefined)?.session?.id

/** One count per file name: a new version replaces its file, it does not add one. */
export function deliverablesCount(binding: UiPlacementBinding): WorkbenchPanelCount {
  return {
    subscribe: binding.subscribe,
    read(context) {
      const client = binding.getSnapshot()
      if (!client || client.sessionId !== sessionOf(context)) return undefined
      return groupDeliverables(sessionDeliverables(client.getSnapshot().surfaces)).length
    },
  }
}

/**
 * Where a file came from: the ledger's own artifact record when the timeline has one, otherwise the
 * outermost tool call during which its file list was created. Without either there is no link, never a guess.
 */
export function deliverableSource(
  timeline: UITimeline | undefined,
  entry: TurnDeliverable,
  client: { knownRecord(id: string): UiSurfaceRecord | undefined },
  sessionId: string,
): FactChainParams | undefined {
  const nodes = timeline?.nodes ?? []
  const artifact = nodes.find(
    (node) => node.kind === 'artifact' && node.ref.sha256 === entry.file.artifact.sha256,
  )
  if (artifact?.kind === 'artifact')
    return {
      sessionId,
      laneId: entry.lane,
      anchor: { kind: 'artifact', seq: artifact.seq, ref: artifact.ref },
    }
  const created = client.knownRecord(entry.surfaceId)?.createdSeq
  if (created === undefined) return undefined
  let call: { seq: number; toolUseId: string } | undefined
  for (const node of nodes)
    if (
      node.kind === 'tool' &&
      node.seq <= created &&
      (node.resultSeq === undefined || node.resultSeq >= created) &&
      // The outermost call names the request («present»), not the helper call nested in it.
      (!call || node.seq < call.seq)
    )
      call = node
  return call
    ? { sessionId, laneId: entry.lane, anchor: { kind: 'tool', toolUseId: call.toolUseId } }
    : undefined
}

/** The conversation's deliverable card asks for its preview here when the workbench has the file. */
export const openDeliverablesPanel = () => workbenchNavigation.open(DELIVERABLES_PANEL)

/**
 * The 交付物 tab: the same cards as in the answer, the newest version of each file grouped by version,
 * earlier versions folded. Opening a card previews it right under the card.
 */
export function WorkbenchDeliverables({
  binding,
  context,
}: {
  binding: UiPlacementBinding
  context: UiExtensionContext
}) {
  useSyncExternalStore(binding.subscribe, binding.getVersion)
  const client = binding.getSnapshot()
  const { t } = context
  const sessionId = sessionOf(context)
  const [chosen, setChosen] = useState<string>()
  if (!client || client.sessionId !== sessionId)
    return <SettingsState tone="empty">{t('workbench.deliverables.empty')}</SettingsState>
  const entries = sessionDeliverables(client.getSnapshot().surfaces)
  const { groups, earlier } = deliverableGroups(entries)
  const newest = groups[0]?.entries[0]
  const current = entries.find((entry) => entryKey(entry) === chosen) ?? newest
  const timeline = (context.data as { timeline?: UITimeline } | undefined)?.timeline
  const source = current && sessionId ? deliverableSource(timeline, current, client, sessionId) : undefined
  const card = (entry: TurnDeliverable & { version?: EarlierVersion }) => (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click inside a card only marks it as the one the footer names.
    <li
      key={entryKey(entry)}
      data-chosen={current && entryKey(entry) === entryKey(current)}
      onClickCapture={() => setChosen(entryKey(entry))}
    >
      <ArtifactFile
        file={entry.file}
        laneId={entry.lane}
        resources={binding.resources}
        placement="workbench"
        {...(entry.version ? { earlier: entry.version } : {})}
      />
    </li>
  )
  return (
    <UiLocaleProvider source={binding.locale}>
      <section
        className="workbench-deliverables"
        data-testid="workbench-deliverables"
        aria-label={t('workbench.deliverables.title')}
      >
        <div className="workbench-deliverables-scroll">
          {!entries.length && <SettingsState tone="empty">{t('workbench.deliverables.empty')}</SettingsState>}
          {groups.map(({ group, entries: items }) => (
            <section key={group} className="workbench-deliverables-group" data-group={group}>
              <h4>{t(`workbench.deliverables.group.${group}`)}</h4>
              <ul>{items.map(card)}</ul>
            </section>
          ))}
          {earlier.length > 0 && (
            <Disclosure
              variant="plain"
              className="workbench-deliverables-earlier"
              data-testid="workbench-deliverables-earlier"
              summary={t('workbench.deliverables.earlier', { count: earlier.length })}
            >
              <ul>{earlier.map(card)}</ul>
            </Disclosure>
          )}
        </div>
        {entries.length > 0 && (
          <footer className="workbench-tab-footer">
            <Icon name="info" size={16} />
            <p>{t('workbench.deliverables.sourceHint')}</p>
            {source && (
              <Button
                type="link"
                size="small"
                data-testid="deliverables-source"
                onClick={() => factChainLinks.open(source)}
              >
                {t('workbench.deliverables.source')}
              </Button>
            )}
          </footer>
        )}
      </section>
    </UiLocaleProvider>
  )
}
