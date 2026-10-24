import type { TuiApp } from './app.js'
import type { SessionChoice } from './commands.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'

/** One listed session, as far as the tree needs it. An older daemon sends no `parent` or `forkAt`. */
export type TreeItem = {
  sessionId: string
  createdAt: string
  lastMessageAt?: string
  lastSeq: number
  preset: string | null
  title?: string
  cwd?: string
  parent?: string
  forkAt?: number
}

const PAGE = 500
const MAX_SESSIONS = 2000

const at = (i: TreeItem): number => {
  const t = Date.parse(i.lastMessageAt ?? i.createdAt)
  return Number.isFinite(t) ? t : 0
}

/**
 * Depth-first rows: roots newest first, forks of one parent in fork order. A parent that is not in
 * `items` (archived, other workspace, beyond the cap, or a daemon without lineage) makes its child a
 * root. `turnOf` names the turn a fork point belongs to; without an answer the row shows `@seq`.
 */
export function treeChoices(
  items: readonly TreeItem[],
  currentId: string,
  turnOf: (parent: string, forkAt: number) => number | undefined,
  locale: string,
): SessionChoice[] {
  const ids = new Set(items.map((i) => i.sessionId))
  const kids = new Map<string, TreeItem[]>()
  const roots: TreeItem[] = []
  for (const item of items) {
    const parent = item.parent
    if (parent && parent !== item.sessionId && ids.has(parent))
      kids.set(parent, [...(kids.get(parent) ?? []), item])
    else roots.push(item)
  }
  for (const list of kids.values()) list.sort((a, b) => (a.forkAt ?? 0) - (b.forkAt ?? 0) || at(a) - at(b))
  roots.sort((a, b) => at(b) - at(a) || b.sessionId.localeCompare(a.sessionId))
  const out: SessionChoice[] = []
  const seen = new Set<string>()
  const visit = (item: TreeItem, depth: number): void => {
    if (seen.has(item.sessionId)) return
    seen.add(item.sessionId)
    const turn = item.parent && item.forkAt !== undefined ? turnOf(item.parent, item.forkAt) : undefined
    const note =
      item.forkAt === undefined
        ? ''
        : ` (${turn === undefined ? tt('tree.forkSeq', locale, { seq: item.forkAt }) : tt('tree.forkTurn', locale, { turn })})`
    // Leading marks are not whitespace: the picker trims a title.
    const lead = depth > 0 ? `${'│ '.repeat(depth - 1)}└ ` : ''
    const mark = item.sessionId === currentId ? '● ' : ''
    const title = oneLine(item.title ?? '') || tt('tree.untitled', locale)
    out.push({
      sessionId: item.sessionId,
      createdAt: item.createdAt,
      ...(item.lastMessageAt ? { lastMessageAt: item.lastMessageAt } : {}),
      lastSeq: item.lastSeq,
      preset: item.preset,
      title: `${lead}${mark}${title}${note}`,
    })
    for (const kid of kids.get(item.sessionId) ?? []) visit(kid, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  // Only a parent cycle leaves rows unvisited; show them rather than lose them.
  for (const item of items) visit(item, 0)
  return out
}

/** Pages the daemon's list (500 per page, 2000 in all) and arranges this workspace's sessions as a tree. */
export async function sessionTree(app: TuiApp): Promise<SessionChoice[]> {
  const s = app.session
  const items: TreeItem[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  while (items.length < MAX_SESSIONS) {
    const page = await s.client.session.list({ limit: PAGE, ...(cursor ? { cursor } : {}) })
    items.push(...(page.items as TreeItem[]))
    if (!page.next) break
    if (cursors.has(page.next)) throw new Error('session listing cursor did not advance')
    cursors.add(page.next)
    cursor = page.next
  }
  // Same workspace rule as /resume: the daemon refuses to load a session from another workspace.
  const here = items.find((i) => i.sessionId === s.id)?.cwd ?? app.cwd
  const scoped = items.slice(0, MAX_SESSIONS).filter((i) => (i.cwd ?? here) === here)
  // Turn numbers come only from the timeline this process already holds (the open session's).
  const turns = scoped.some((i) => i.parent === s.id)
    ? (await s.projectUIOpening({ surface: 'tui' })).timeline.turns
    : []
  return treeChoices(
    scoped,
    s.id,
    (parent, forkAt) => (parent === s.id ? turns.find((t) => t.endSeq === forkAt)?.turn : undefined),
    app.locale,
  )
}
