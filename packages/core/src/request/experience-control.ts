import type { SurfaceNode } from '@agnes/core-ledger/project/surface'
import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import { EXPERIENCE_PREFIX } from './experience-guidance.js'

/**
 * Control lines for entries that stopped holding, derived from what the model can see. The surface
 * is the only state: an entry is announced as expired, or as withdrawn when it is gone (deleted,
 * rolled back), when a visible task-experience note delivered it and no visible control note after
 * that note has withdrawn it (by name, or by the reset or switched-off notice that voids everything
 * before it). Nothing is written to remember an announcement, so a reopened session or a fork decides
 * the same, a restart loses no pending notice and sends none twice, and a compaction that masked the
 * delivery masks the need too.
 */

export const CONTROL_FORMAT_LINE = 'Task experience control, format 1.'
/** Sent instead of a list of withdrawals that does not fit the control budget. */
export const EXPERIENCE_RESET_NOTICE =
  'No task-experience note before this one applies any longer; only experience given after this notice is valid.'
/** Sent once when refinement is switched off after the model was given task experience. */
export const EXPERIENCE_OFF_NOTICE =
  'Task experience is switched off: no task-experience note before this one applies any longer, and none follows until it is switched on again.'

/**
 * Begins the header line of a snapshot or update naming the task-level entries held back from it
 * because their task could not be read: once it can, they are owed to the model. Entries a snapshot
 * leaves out on purpose (past the top three, over the budget) are never named here.
 */
export const HELD_LINE = 'Held until their task can be read:'
/** How many held entries the line names; the rest are counted. */
export const HELD_NAMED = 32
const SAFE_REF = /^(prompt|memory|skill|subagent)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const HELD_MORE = / and (\d+) more$/u
/**
 * The held line for these `kind/id` refs, in order: Core's own words, naming only refs of a known kind
 * and a well-formed id, the first `HELD_NAMED` of them, then how many more (no closing stop: an id
 * may end with one). '' when there is nothing to name.
 */
export function heldLine(refs: readonly string[]): string {
  const safe = refs.filter((ref) => SAFE_REF.test(ref))
  if (safe.length === 0) return ''
  const more = safe.length - HELD_NAMED
  return `${HELD_LINE} ${safe.slice(0, HELD_NAMED).join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}
const HELD = /(prompt|memory|skill|subagent)\/([A-Za-z0-9][A-Za-z0-9._-]*)/gu

const DELIVERED = /^- \[(prompt|memory|skill|subagent)\/([A-Za-z0-9][A-Za-z0-9._-]*) v(\d+)\]/gmu
const ENDED = /\[(prompt|memory|skill|subagent)\/([A-Za-z0-9][A-Za-z0-9._-]*) v\d+\] (?:expired|withdrawn):/gu

/** The text of one content block, or '' when it is not text. */
function block(content: unknown, at: number): string {
  const part = Array.isArray(content) ? (content[at] as { type?: unknown; text?: unknown } | null) : null
  return part?.type === 'text' && typeof part.text === 'string' ? part.text : ''
}

/** The control line that withdraws an expired task-level entry. */
export const expiredLine = (e: Pick<HarnessEntry, 'kind' | 'id' | 'version'>): string =>
  `- [${e.kind}/${e.id} v${e.version}] expired: the task it was learned for has ended; do not follow it any longer.`

/** The control line that withdraws an entry that is gone: deleted, or undone by a rollback. */
export const withdrawnLine = (ref: string, version: number): string =>
  `- [${ref} v${version}] withdrawn: it was removed; do not follow it any longer.`

/**
 * The control line for an entry handed off to the workspace: it now lives as a workspace skill of the
 * same name, which the skill catalogue lists. Read as a withdrawal, so it is said once.
 */
export const handedOffLine = (ref: string, version: number): string =>
  `- [${ref} v${version}] withdrawn: installed as the workspace skill ${ref.slice(ref.indexOf('/') + 1)}; use that skill instead.`

/** Whether a note's header is a control note that voids every note before it. */
const voidsAll = (body: string) =>
  body.includes(EXPERIENCE_RESET_NOTICE) || body.includes(EXPERIENCE_OFF_NOTICE)

/**
 * What the visible notes say of each entry, by `kind/id`: `delivered`, given and not withdrawn since,
 * with the version given; `withdrawn`, given and then withdrawn (named as expired or withdrawn, or
 * voided by a reset or switched-off notice) and not given again since. An entry in force again after
 * a withdrawal, or voided by a reset and not yet re-sent (an update has a budget), is owed to the
 * model. `off` says the newest control note is the switched-off notice and nothing was given after it.
 * `held` are entries a visible note named as held back while their task could not be read, and that
 * no visible note has given since: they are owed once in force. `heldMore` says the newest snapshot or
 * update held back more entries than it could name.
 */
export function surfaceRefs(surface: readonly SurfaceNode[]): {
  delivered: Map<string, number>
  withdrawn: Set<string>
  held: Set<string>
  heldMore: boolean
  off: boolean
} {
  const delivered = new Map<string, number>()
  const withdrawn = new Set<string>()
  const held = new Set<string>()
  let heldMore = false
  let off = false
  for (const node of surface) {
    if (node.kind !== 'user' || node.event.type !== 'user/message' || node.event.origin !== 'system') continue
    const data = node.event.data as { kind?: unknown; content?: unknown }
    if (data.kind !== 'runtime_context') continue
    // A note is read by its first block, Core's own words; entry text only ever rides the second.
    const head = block(data.content, 0)
    if (!head.startsWith(EXPERIENCE_PREFIX)) continue
    const body = head.slice(EXPERIENCE_PREFIX.length)
    if (body.split('\n', 1)[0] === CONTROL_FORMAT_LINE) {
      const gone = voidsAll(body)
        ? [...delivered.keys()]
        : [...body.matchAll(ENDED)].map(([, kind, id]) => `${kind}/${id}`)
      for (const ref of gone) {
        delivered.delete(ref)
        withdrawn.add(ref)
      }
      off = body.includes(EXPERIENCE_OFF_NOTICE)
      continue
    }
    off = false
    const named = body.split('\n').find((line) => line.startsWith(HELD_LINE))
    const listed = named?.slice(HELD_LINE.length).replace(HELD_MORE, '')
    for (const [, kind, id] of listed?.matchAll(HELD) ?? []) held.add(`${kind}/${id}`)
    heldMore = named !== undefined && HELD_MORE.test(named)
    for (const [, kind, id, version] of block(data.content, 1).matchAll(DELIVERED)) {
      delivered.set(`${kind}/${id}`, Number(version))
      withdrawn.delete(`${kind}/${id}`)
      held.delete(`${kind}/${id}`)
    }
  }
  return { delivered, withdrawn, held, heldMore, off }
}

/** The `kind/id` of every entry a visible note delivered and no later visible control note withdrew. */
export const deliveredRefs = (surface: readonly SurfaceNode[]): Set<string> =>
  new Set(surfaceRefs(surface).delivered.keys())

const byRef = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const refOf = (e: Pick<HarnessEntry, 'kind' | 'id'>) => `${e.kind}/${e.id}`

/**
 * The control lines owed now, in `kind/id` order: each expired entry the model was given and has not
 * been told about, and each entry it was given that is gone (in none of `present`: not in force, not
 * expired, not held while its task cannot be read). An entry gone because it was handed off to the
 * workspace (`handedOff`) is said to be installed as a skill rather than removed.
 */
export function controlLines(
  delivered: ReadonlyMap<string, number>,
  expired: readonly { entry: HarnessEntry }[],
  present: ReadonlySet<string>,
  handedOff: ReadonlySet<string> = new Set(),
): string[] {
  const lines = new Map<string, string>()
  for (const { entry } of expired)
    if (delivered.has(refOf(entry))) lines.set(refOf(entry), expiredLine(entry))
  for (const [ref, version] of delivered)
    if (!present.has(ref))
      lines.set(ref, handedOff.has(ref) ? handedOffLine(ref, version) : withdrawnLine(ref, version))
  return [...lines.keys()].sort(byRef).map((ref) => lines.get(ref) as string)
}

/** The expiry lines owed now: each expired entry the model was given and has not been told about. */
export function expiryLines(
  delivered: { has(ref: string): boolean },
  expired: readonly { entry: HarnessEntry }[],
): string[] {
  return expired
    .map((view) => view.entry)
    .filter((entry) => delivered.has(refOf(entry)))
    .sort((a, b) => byRef(refOf(a), refOf(b)))
    .map(expiredLine)
}
