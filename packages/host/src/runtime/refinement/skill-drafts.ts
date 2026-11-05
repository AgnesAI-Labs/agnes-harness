import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { isSavedSkillName, type SkillDraft } from '@agnes/host-extensions/resources/refinement-skill-install'
import type { SaveInitiator } from '@agnes/host-infrastructure/refinement-registry'
import { AGH_DIR } from '@agnes/protocol'

/** The longest description a saved skill may list in the skill catalogue. */
export const SKILL_DESCRIPTION_MAX = 200
/** How many drafts a workspace keeps; the oldest go first. */
export const SKILL_DRAFTS_KEEP = 20
/** The largest `SKILL.md` a draft quotes as the skill's current text: the install limit for one file. */
const MAX_SKILL_BYTES = 256 * 1024
/** Where the skills of a workspace live, in the order the skill catalogue reads them. */
const WORKSPACE_SKILL_FOLDERS: readonly (readonly string[])[] = [
  [AGH_DIR, 'skills'],
  ['.agents', 'skills'],
  ['.claude', 'skills'],
]

/** A C0 or C1 control character, or DEL: none may stand in a one-line description. */
const hasControl = (text: string) =>
  [...text].some((char) => {
    const code = char.charCodeAt(0)
    return code < 0x20 || (code >= 0x7f && code <= 0x9f)
  })

/**
 * The skill a saved skill entry becomes: one `SKILL.md` whose front matter names the skill after the
 * entry id and describes it with the entry title, and whose body is the entry content. Nothing else:
 * a saved skill holds instructions only. Undefined when the id is not a name a saved skill may have
 * (lower case, no path, no device name) or the title cannot be its one-line description.
 */
export function skillDraftOf(entry: { id: string; title: string; content: string }): SkillDraft | undefined {
  if (!isSavedSkillName(entry.id)) return undefined
  const { title } = entry
  if (!title.trim() || title.length > SKILL_DESCRIPTION_MAX || hasControl(title)) return undefined
  const body = entry.content.endsWith('\n') ? entry.content : `${entry.content}\n`
  return {
    name: entry.id,
    class: 'instructions',
    files: [
      {
        path: 'SKILL.md',
        content: `---\nname: ${entry.id}\ndescription: ${JSON.stringify(title)}\n---\n${body}`,
      },
    ],
  }
}

/**
 * Reads one regular file under `root` without following a link at any step below it, without waiting
 * on a pipe or device, and only up to `MAX_SKILL_BYTES`. Undefined when any of that does not hold.
 */
function readPlain(root: string, parts: readonly string[]): string | undefined {
  let path = root
  for (const part of parts) {
    path = join(path, part)
    try {
      if (lstatSync(path).isSymbolicLink()) return undefined
    } catch {
      return undefined
    }
  }
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) return undefined
    // Never more than the limit, even if the file grows while it is read.
    const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1)
    let length = 0
    for (let read = 1; read > 0 && length < buffer.length; length += read)
      read = readSync(fd, buffer, length, buffer.length - length, null)
    if (length > MAX_SKILL_BYTES) return undefined
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * A skill of this name in one of the workspace's skill folders, found whatever the letter case of its
 * folder, with its `SKILL.md` text (null when it cannot be read safely). Undefined when there is none.
 * `name` must already be a saved skill name; it is never used as a path before that.
 */
export function workspaceSkillText(workspaceRoot: string, name: string): { text: string | null } | undefined {
  if (!isSavedSkillName(name)) return undefined
  for (const folder of WORKSPACE_SKILL_FOLDERS) {
    let entries: string[]
    try {
      entries = readdirSync(join(workspaceRoot, ...folder))
    } catch {
      continue
    }
    const found = entries.find((entry) => {
      const lower = entry.toLowerCase()
      return lower === name || lower === `${name}.md`
    })
    if (found === undefined) continue
    const parts = found.toLowerCase() === name ? [...folder, found, 'SKILL.md'] : [...folder, found]
    return { text: readPlain(workspaceRoot, parts) ?? null }
  }
  return undefined
}

/** Why refinement left a change to a skill for a person instead of writing it. */
export type SkillDraftReason =
  /** Refinement installed the skill, but a person has changed it since: it is theirs now. */
  | 'changed-since'
  /** A person's skill holds the name. */
  | 'human-written'

/**
 * A change to a skill that refinement may not write itself, kept for a person to take or drop: the
 * skill's current `SKILL.md` (null when it could not be read), the one refinement proposes, the
 * whole-file diff between them, why it is a draft, and the evidence it stands on (ids and ledger
 * rows of the session it came from, never their text).
 */
export type SkillChangeDraft = {
  id: string
  name: string
  reason: SkillDraftReason
  base: string | null
  proposed: string
  diff: string
  receiptId: string
  evidence: {
    sessionKey: string
    entryId: string
    entryVersion: number
    contentHash: string
    evidenceSeqs: number[]
    runId?: string
    commandId: string
    initiator: SaveInitiator
  }
  at: number
}

export type SkillDraftStore = Readonly<{
  /** Keeps a draft. The same change to the same text is one draft, carrying the latest request. */
  put(draft: Omit<SkillChangeDraft, 'id' | 'diff'>): SkillChangeDraft
  /** The drafts kept, oldest first. */
  list(): SkillChangeDraft[]
  /** Drops a draft; false when there was none. */
  discard(id: string): boolean
}>

/** A whole-file diff: every line under review is shown, nothing is cut. */
export function skillDraftDiff(base: string | null, proposed: string): string {
  const lines = (text: string) => (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
  return [
    '--- current',
    '+++ proposed',
    ...(base === null ? [] : lines(base).map((line) => `-${line}`)),
    ...lines(proposed).map((line) => `+${line}`),
  ].join('\n')
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const DRAFT_FILE = /^[a-f0-9]{32}\.json$/
const REASONS: readonly SkillDraftReason[] = ['changed-since', 'human-written']
const INITIATORS: readonly SaveInitiator[] = ['auto', 'user', 'model']

/** A draft rebuilt from its known fields, or undefined when the stored file is not one. */
function checkedDraft(value: unknown): SkillChangeDraft | undefined {
  const raw = value as Partial<SkillChangeDraft> | null
  const evidence = raw?.evidence as Partial<SkillChangeDraft['evidence']> | undefined
  const str = (item: unknown): item is string => typeof item === 'string'
  if (
    !raw ||
    !str(raw.id) ||
    !str(raw.name) ||
    !isSavedSkillName(raw.name) ||
    !REASONS.includes(raw.reason as SkillDraftReason) ||
    !(raw.base === null || str(raw.base)) ||
    !str(raw.proposed) ||
    !str(raw.diff) ||
    !str(raw.receiptId) ||
    typeof raw.at !== 'number' ||
    !evidence ||
    !str(evidence.sessionKey) ||
    !str(evidence.entryId) ||
    typeof evidence.entryVersion !== 'number' ||
    !str(evidence.contentHash) ||
    !Array.isArray(evidence.evidenceSeqs) ||
    !evidence.evidenceSeqs.every((seq) => Number.isSafeInteger(seq)) ||
    !(evidence.runId === undefined || str(evidence.runId)) ||
    !str(evidence.commandId) ||
    !INITIATORS.includes(evidence.initiator as SaveInitiator)
  )
    return undefined
  return {
    id: raw.id,
    name: raw.name,
    reason: raw.reason as SkillDraftReason,
    base: raw.base,
    proposed: raw.proposed,
    diff: raw.diff,
    receiptId: raw.receiptId,
    evidence: {
      sessionKey: evidence.sessionKey,
      entryId: evidence.entryId,
      entryVersion: evidence.entryVersion,
      contentHash: evidence.contentHash,
      evidenceSeqs: [...evidence.evidenceSeqs],
      ...(evidence.runId === undefined ? {} : { runId: evidence.runId }),
      commandId: evidence.commandId,
      initiator: evidence.initiator as SaveInitiator,
    },
    at: raw.at,
  }
}

/**
 * Drafts of skill changes for a person, kept per workspace in the data directory
 * (`<dataDir>/refinement/skill-drafts/<sha256(workspaceRoot)>/`), which the agent cannot reach. Each
 * draft is its own file, written whole and renamed into place, so processes never see half a draft;
 * at most `SKILL_DRAFTS_KEEP` are kept.
 */
export function createSkillDraftStore(dataDir: string) {
  return (workspaceRoot: string): SkillDraftStore => {
    const dir = join(dataDir, 'refinement', 'skill-drafts', sha256(workspaceRoot))
    const read = (file: string): SkillChangeDraft | undefined => {
      try {
        const path = join(dir, file)
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.size > 4 * MAX_SKILL_BYTES) return undefined
        const draft = checkedDraft(JSON.parse(readFileSync(path, 'utf8')))
        return draft && `${draft.id}.json` === file ? draft : undefined
      } catch {
        return undefined
      }
    }
    const list = (): SkillChangeDraft[] => {
      let files: string[]
      try {
        files = readdirSync(dir).filter((file) => DRAFT_FILE.test(file))
      } catch {
        return []
      }
      return files
        .map(read)
        .filter((draft): draft is SkillChangeDraft => draft !== undefined)
        .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    }
    const remove = (id: string) => {
      try {
        rmSync(join(dir, `${id}.json`))
        return true
      } catch {
        return false
      }
    }
    return Object.freeze({
      put(input) {
        const id = sha256(
          `${input.name}\0${input.base ?? ''}\0${input.base === null}\0${input.proposed}`,
        ).slice(0, 32)
        const draft: SkillChangeDraft = { ...input, id, diff: skillDraftDiff(input.base, input.proposed) }
        mkdirSync(dir, { recursive: true })
        const tmp = join(dir, `.${id}.${randomUUID()}.tmp`)
        try {
          writeFileSync(tmp, JSON.stringify(draft), { flag: 'wx' })
          renameSync(tmp, join(dir, `${id}.json`))
        } catch (error) {
          rmSync(tmp, { force: true })
          throw error
        }
        const kept = list()
        for (const old of kept.slice(0, Math.max(0, kept.length - SKILL_DRAFTS_KEEP))) remove(old.id)
        return draft
      },
      list,
      discard: (id) => /^[a-f0-9]{32}$/.test(id) && remove(id),
    })
  }
}
