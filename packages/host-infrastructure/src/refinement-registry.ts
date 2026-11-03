import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import {
  checkedReceipt,
  checkedSource,
  PROMOTION_CONFIRMATIONS,
  type SaveInitiator,
  type SaveKind,
  type SaveReceipt,
  type SaveRefusal,
  type SaveSource,
} from '@agnes/core-ledger/reduce/refinement-save'

export type { SaveInitiator, SaveKind, SaveReceipt, SaveRefusal, SaveSource }
/** How many separate confirmations an automatic save needs (shared with Core, which offers the saves). */
export { PROMOTION_CONFIRMATIONS }

/** How long saved task experience stays in force before it needs a fresh look. */
export const REVIEW_AFTER_MS = 30 * 86_400_000
/** How long a save waiting for approval stays open. */
export const APPROVAL_TTL_MS = 7 * 86_400_000

const MAX_REGISTRY_BYTES = 8 * 1024 * 1024
const MAX_RECEIPTS = 500
const MAX_TEXT = 4096
const EMPTY_REVISION = 'empty'
const VERSION = 1
const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 15_000
const LOCK_POLL_MS = 5

/**
 * The one hash of an entry's content that revocation records and save requests share: surrounding
 * whitespace dropped, runs of whitespace collapsed, letters lower-cased, then SHA-256. Text that differs
 * only in spacing or letter case therefore counts as the same content, so a re-spaced or re-cased copy
 * cannot get past a revocation.
 */
export const normalizedContentHash = (content: string): string =>
  createHash('sha256').update(content.trim().replace(/\s+/g, ' ').toLowerCase()).digest('hex')

export type RegistryParagraph = {
  id: string
  source: SaveSource
  contentHash: string
  reviewAfter: number
  state: 'active' | 'converted' | 'removed'
  fileHash: string
}
export type RegistrySkill = {
  name: string
  resourceId: string
  revision: string
  source: SaveSource
  reviewAfter: number
  state: 'active' | 'review-disabled' | 'uninstalled' | 'rolled-back'
  archive: string[]
}
export type Revocation = {
  sessionKey: string
  kind: SaveKind
  entryId: string
  contentHash: string
  skillName?: string
  action: 'memory-deleted' | 'memory-withdrawn' | 'skill-uninstalled' | 'skill-rolled-back'
  at: number
}
/** The records of one workspace, as a caller reads and edits them. */
export type RegistryRecords = {
  paragraphs: RegistryParagraph[]
  skills: RegistrySkill[]
  revocations: Revocation[]
  receipts: SaveReceipt[]
}
export type RegistrySnapshot = RegistryRecords & { revision: string }

/**
 * Whether `record` bars a save of `source` (and, for a skill, `skillName`): any version of the same
 * source entry in the same session; a skill of the same name, compared ASCII case-insensitively; or a
 * deleted or withdrawn memory paragraph with the same content hash. `revoked` answers with it, and a
 * user's override clears exactly the records it matches.
 */
export function revocationMatches(
  record: Revocation,
  source: Pick<SaveSource, 'sessionKey' | 'kind' | 'entryId' | 'contentHash'>,
  skillName?: string,
): boolean {
  const lineage =
    record.sessionKey === source.sessionKey &&
    record.kind === source.kind &&
    record.entryId === source.entryId
  const name = skillName?.toLowerCase()
  const sameSkill =
    name !== undefined && record.skillName !== undefined && record.skillName.toLowerCase() === name
  const sameContent =
    (source.kind === 'prompt' || source.kind === 'memory') &&
    (record.action === 'memory-deleted' || record.action === 'memory-withdrawn') &&
    record.contentHash === source.contentHash
  return lineage || sameSkill || sameContent
}

const failure = (code: string, extra: object = {}) => Object.assign(new Error(code), { code, ...extra })

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

// The checks below rebuild every record from its known fields, so nothing else (an entry's text, say)
// can ride along into the file, and a file with a wrong shape anywhere is not believed at all.
type Raw = Record<string, unknown>
const obj = (value: unknown): Raw | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : undefined
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT ? value : undefined
const time = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  allowed.find((candidate) => candidate === value)
const list = <T>(value: unknown, item: (entry: unknown) => T | undefined): T[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const out: T[] = []
  for (const entry of value) {
    const clean = item(entry)
    if (clean === undefined) return undefined
    out.push(clean)
  }
  return out
}
const every = (...values: unknown[]): boolean => values.every((value) => value !== undefined)

const KINDS = ['prompt', 'memory', 'skill', 'subagent'] as const

const cleanSource = checkedSource

const cleanParagraph = (value: unknown): RegistryParagraph | undefined => {
  const raw = obj(value)
  if (!raw) return undefined
  const id = text(raw.id)
  const source = cleanSource(raw.source)
  const contentHash = text(raw.contentHash)
  const reviewAfter = time(raw.reviewAfter)
  const state = oneOf(raw.state, ['active', 'converted', 'removed'] as const)
  const fileHash = text(raw.fileHash)
  if (!every(id, source, contentHash, reviewAfter, state, fileHash)) return undefined
  return {
    id: id as string,
    source: source as SaveSource,
    contentHash: contentHash as string,
    reviewAfter: reviewAfter as number,
    state: state as RegistryParagraph['state'],
    fileHash: fileHash as string,
  }
}

const cleanSkill = (value: unknown): RegistrySkill | undefined => {
  const raw = obj(value)
  if (!raw) return undefined
  const name = text(raw.name)
  const resourceId = text(raw.resourceId)
  const revision = text(raw.revision)
  const source = cleanSource(raw.source)
  const reviewAfter = time(raw.reviewAfter)
  const state = oneOf(raw.state, ['active', 'review-disabled', 'uninstalled', 'rolled-back'] as const)
  const archive = list(raw.archive, text)
  if (!every(name, resourceId, revision, source, reviewAfter, state, archive)) return undefined
  return {
    name: name as string,
    resourceId: resourceId as string,
    revision: revision as string,
    source: source as SaveSource,
    reviewAfter: reviewAfter as number,
    state: state as RegistrySkill['state'],
    archive: archive as string[],
  }
}

const cleanRevocation = (value: unknown): Revocation | undefined => {
  const raw = obj(value)
  if (!raw) return undefined
  const sessionKey = text(raw.sessionKey)
  const kind = oneOf(raw.kind, KINDS)
  const entryId = text(raw.entryId)
  const contentHash = text(raw.contentHash)
  const skillName = raw.skillName === undefined ? undefined : text(raw.skillName)
  const action = oneOf(raw.action, [
    'memory-deleted',
    'memory-withdrawn',
    'skill-uninstalled',
    'skill-rolled-back',
  ] as const)
  const at = time(raw.at)
  if (!every(sessionKey, kind, entryId, contentHash, action, at)) return undefined
  if (raw.skillName !== undefined && skillName === undefined) return undefined
  return {
    sessionKey: sessionKey as string,
    kind: kind as SaveKind,
    entryId: entryId as string,
    contentHash: contentHash as string,
    ...(skillName === undefined ? {} : { skillName }),
    action: action as Revocation['action'],
    at: at as number,
  }
}

const cleanReceipt = checkedReceipt

/**
 * A receipt that still waits on something: an approval not yet answered, or a save's intent whose
 * result is not known yet. Trimming one would lose the person's answer or the record of a written
 * paragraph, so only settled receipts are trimmed.
 */
const unsettled = (receipt: SaveReceipt): boolean =>
  receipt.outcome === 'awaiting-approval' || (receipt.outcome === 'unknown' && receipt.reason === undefined)

/**
 * The receipts kept: the newest `MAX_RECEIPTS`, made up by dropping the oldest settled ones only. When
 * the unsettled ones alone are more than that, all of them stay (they settle within days).
 */
function trimReceipts(receipts: SaveReceipt[]): SaveReceipt[] {
  let drop = receipts.length - MAX_RECEIPTS
  if (drop <= 0) return receipts
  return receipts.filter((receipt) => {
    if (drop <= 0 || unsettled(receipt)) return true
    drop--
    return false
  })
}

const cleanRecords = (value: Raw): RegistryRecords | undefined => {
  const paragraphs = list(value.paragraphs, cleanParagraph)
  const skills = list(value.skills, cleanSkill)
  const revocations = list(value.revocations, cleanRevocation)
  const receipts = list(value.receipts, cleanReceipt)
  if (!paragraphs || !skills || !revocations || !receipts) return undefined
  return { paragraphs, skills, revocations, receipts: trimReceipts(receipts) }
}

const UUID = /^[0-9a-f-]{36}$/
const emptyRecords = (): RegistryRecords => ({ paragraphs: [], skills: [], revocations: [], receipts: [] })

export type RegistryOptions = {
  /** How old a lock file must be before it is taken over as abandoned. */
  lockStaleMs?: number
  /** How long a writer waits for another writer's lock before giving up. */
  lockWaitMs?: number
}

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
const missing = (error: unknown): boolean => (error as { code?: string } | null)?.code === 'ENOENT'
const exists = (error: unknown): boolean => (error as { code?: string } | null)?.code === 'EEXIST'

/**
 * The record of what refinement saved into one workspace: the memory paragraphs it wrote, the skills it
 * installed, the saves a user took back, and a receipt for each save. It is the one authority for when saved
 * content falls due for a fresh look and for what a user has revoked, and it lives beside the profile's
 * data, never in the memory file. Only structure and hashes are kept, never the text of an entry.
 *
 * Reading is fail-closed. A missing file reads as empty. A file that exists but cannot be believed (a bad
 * record, an unknown version, an unreadable disk) also reads as empty, so no paragraph in it is ever `valid`,
 * and `revoked` then blocks every save; but it is never overwritten: `update` throws `REGISTRY_UNREADABLE`
 * until `quarantine` sets the file aside.
 *
 * Writes may come from several processes. Each `update` holds an exclusive lock file
 * (`<file>.lock`, created with `wx`) around read, compare and rename, takes over a lock older than
 * `lockStaleMs`, and gives up with `REGISTRY_LOCK_TIMEOUT` after `lockWaitMs`. The file is replaced in one
 * rename, so a reader never sees half a write.
 *
 * The file is `<dataDir>/refinement/workspaces/<sha256(workspaceRoot)>.json`; `workspaceRoot` is the same
 * string the memory provider is opened with.
 */
export class RefinementRegistry {
  private readonly dir: string
  private readonly file: string
  private readonly clock: () => number
  private readonly lockStaleMs: number
  private readonly lockWaitMs: number
  constructor(dataDir: string, workspaceRoot: string, clock: () => number, options: RegistryOptions = {}) {
    this.clock = clock
    this.dir = join(dataDir, 'refinement', 'workspaces')
    this.file = join(this.dir, `${sha256(workspaceRoot)}.json`)
    this.lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS
    this.lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS
  }

  /** A copy of the records and the revision to hand back to `update`. */
  read(): RegistrySnapshot {
    return structuredClone(this.inspect().snapshot)
  }

  /**
   * Edits the records while the stored revision is still `expectedRevision`; otherwise throws
   * `REGISTRY_REVISION_CONFLICT` without running `mutate` or writing. Every save gets a revision never seen
   * before, even one that changes nothing. A `mutate` that throws, or leaves a record malformed
   * (`REGISTRY_INVALID`), writes nothing. An existing file that cannot be believed is left alone
   * (`REGISTRY_UNREADABLE`).
   */
  update(mutate: (draft: RegistryRecords) => void, expectedRevision: string): { revision: string } {
    return this.transact(mutate, expectedRevision)
  }

  /**
   * Whether the model may be given a paragraph at `now`: `valid` while its `reviewAfter` is still ahead,
   * `expired` from `reviewAfter` on, and `unknown` for any id the registry does not hold as an active
   * paragraph (including one a person converted or removed, whose marker should be gone).
   */
  validity(paragraphId: string, now: number): 'valid' | 'expired' | 'unknown' {
    const found = this.inspect().snapshot.paragraphs.find(
      (paragraph) => paragraph.id === paragraphId && paragraph.state === 'active',
    )
    if (!found) return 'unknown'
    return now < found.reviewAfter ? 'valid' : 'expired'
  }

  /**
   * The newest revocation that bars this save, if any. Three things match: any version of the same source
   * entry in the same session; a skill of the same name (compared ASCII case-insensitively, because the
   * folder a skill installs into is case-insensitive on some platforms); and a deleted or withdrawn memory
   * paragraph with the same content hash (use `normalizedContentHash`). While the stored file cannot be
   * believed nothing can be ruled out, so the answer is a blocking record for this very save.
   */
  revoked(
    source: Pick<SaveSource, 'sessionKey' | 'kind' | 'entryId' | 'contentHash'>,
    skillName?: string,
  ): Revocation | undefined {
    const { snapshot, unreadable } = this.inspect()
    if (unreadable) {
      return {
        sessionKey: source.sessionKey,
        kind: source.kind,
        entryId: source.entryId,
        contentHash: source.contentHash,
        ...(skillName === undefined ? {} : { skillName }),
        action: source.kind === 'skill' ? 'skill-uninstalled' : 'memory-withdrawn',
        at: this.clock(),
      }
    }
    let newest: Revocation | undefined
    for (const record of snapshot.revocations)
      if (revocationMatches(record, source, skillName) && (!newest || record.at >= newest.at)) newest = record
    return newest ? structuredClone(newest) : undefined
  }

  /**
   * True when a stored file is there that cannot be believed: it reads as empty, every `update` throws
   * `REGISTRY_UNREADABLE`, and `revoked` blocks every save until `quarantine` sets it aside.
   */
  unreadable(): boolean {
    return this.inspect().unreadable
  }

  /**
   * Starts a new review period (`REVIEW_AFTER_MS` from now) for a paragraph or an installed skill. It writes
   * the registry only; no memory file is touched. An unknown paragraph, a removed or converted one, or a skill
   * that is uninstalled or rolled back throws `REGISTRY_ENTRY_NOT_RENEWABLE`.
   */
  renew(target: { paragraphId: string } | { skillName: string }): void {
    const reviewAfter = this.clock() + REVIEW_AFTER_MS
    this.transact((draft) => {
      const record =
        'paragraphId' in target
          ? draft.paragraphs.find((p) => p.id === target.paragraphId && p.state === 'active')
          : draft.skills.find(
              (s) => s.name === target.skillName && (s.state === 'active' || s.state === 'review-disabled'),
            )
      if (!record) throw failure('REGISTRY_ENTRY_NOT_RENEWABLE')
      record.reviewAfter = reviewAfter
    })
  }

  /**
   * Sets aside a stored file that cannot be believed, by renaming it to `<file>.corrupt-<time>`, so the
   * registry starts empty and can be written again. Returns the new path, or undefined when there was
   * nothing wrong to set aside.
   */
  quarantine(): string | undefined {
    return this.locked(() => {
      if (!this.inspect().unreadable) return undefined
      const moved = `${this.file}.corrupt-${Date.now()}`
      renameSync(this.file, moved)
      return moved
    })
  }

  private transact(
    mutate: (draft: RegistryRecords) => void,
    expectedRevision?: string,
  ): { revision: string } {
    return this.locked(() => {
      const { snapshot, unreadable } = this.inspect()
      if (unreadable) throw failure('REGISTRY_UNREADABLE')
      if (expectedRevision !== undefined && snapshot.revision !== expectedRevision)
        throw failure('REGISTRY_REVISION_CONFLICT')
      const draft: RegistryRecords = structuredClone({
        paragraphs: snapshot.paragraphs,
        skills: snapshot.skills,
        revocations: snapshot.revocations,
        receipts: snapshot.receipts,
      })
      mutate(draft)
      const clean = cleanRecords(draft)
      if (!clean) throw failure('REGISTRY_INVALID')
      const revision = randomUUID()
      const body = JSON.stringify({ version: VERSION, revision, ...clean })
      if (Buffer.byteLength(body) > MAX_REGISTRY_BYTES) throw failure('REGISTRY_TOO_LARGE')
      this.write(body)
      return { revision }
    })
  }

  /** What is stored, and whether a file is there that could not be believed. */
  private inspect(): { snapshot: RegistrySnapshot; unreadable: boolean } {
    const empty = { revision: EMPTY_REVISION, ...emptyRecords() }
    try {
      if (statSync(this.file).size > MAX_REGISTRY_BYTES) return { snapshot: empty, unreadable: true }
      const value = obj(JSON.parse(readFileSync(this.file, 'utf8')))
      if (!value || value.version !== VERSION) return { snapshot: empty, unreadable: true }
      if (typeof value.revision !== 'string' || !UUID.test(value.revision))
        return { snapshot: empty, unreadable: true }
      const records = cleanRecords(value)
      return records
        ? { snapshot: { revision: value.revision, ...records }, unreadable: false }
        : { snapshot: empty, unreadable: true }
    } catch (error) {
      return { snapshot: empty, unreadable: !missing(error) }
    }
  }

  private write(body: string): void {
    // Under the lock no write is in flight, so any temporary file here was left by a crash.
    const prefix = `${basename(this.file)}.`
    for (const name of readdirSync(this.dir)) {
      if (name.startsWith(prefix) && name.endsWith('.tmp')) {
        try {
          unlinkSync(join(this.dir, name))
        } catch {
          // already gone
        }
      }
    }
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.file)
    } finally {
      try {
        unlinkSync(temporary)
      } catch {
        // already renamed away
      }
    }
  }

  /** Runs `section` while holding the lock file; the lock is always released. */
  private locked<T>(section: () => T): T {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const lock = `${this.file}.lock`
    const token = randomUUID()
    const deadline = Date.now() + this.lockWaitMs
    for (;;) {
      try {
        const handle = openSync(lock, 'wx', 0o600)
        try {
          writeFileSync(handle, token)
        } finally {
          closeSync(handle)
        }
        break
      } catch (error) {
        if (!exists(error)) throw error
        if (this.takeOverIfAbandoned(lock)) continue
        if (Date.now() >= deadline) throw failure('REGISTRY_LOCK_TIMEOUT')
        sleep(LOCK_POLL_MS)
      }
    }
    try {
      return section()
    } finally {
      try {
        // Release only our own lock: if it was taken over as abandoned, it is no longer ours.
        if (readFileSync(lock, 'utf8') === token) unlinkSync(lock)
      } catch {
        // already gone
      }
    }
  }

  /** Removes a lock nobody has touched for `lockStaleMs`; true when the lock is gone and a retry may win it. */
  private takeOverIfAbandoned(lock: string): boolean {
    try {
      if (Date.now() - statSync(lock).mtimeMs < this.lockStaleMs) return false
      // Rename first, so two takers cannot both remove a lock that the first one's retry has just made.
      const aside = `${lock}.${randomUUID()}.stale`
      renameSync(lock, aside)
      unlinkSync(aside)
      return true
    } catch (error) {
      return missing(error)
    }
  }
}
