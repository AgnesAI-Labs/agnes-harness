import { isUtf8 } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { MemoryEffectAdmission, MemoryFile, MemorySettings, MemorySource } from '@agnes/extension-api'
import { openCanonicalFileSync, renameWriteThroughSync } from '@agnes/system-node'
import {
  defaults,
  fault,
  file,
  hash,
  isPreExistingMatch,
  MemoryFault,
  type PreservedSlice,
  settings,
  storedSettings,
  validateContent,
  validateRemovalContent,
} from './content.js'
import { syncTopicDirectory, unlinkTopic } from './delete-topic.js'
import { MetaStore } from './meta.js'
import { applyParagraphRemovalsWithSlices, verifiedSingleParagraphRemoval } from './paragraphs.js'
import { isMemoryName, missing, name, safe } from './paths.js'
import { forgetProvenance } from './provenance.js'
import { topicLinks } from './topic-links.js'

const MAX_FILE_BYTES = 1024 * 1024
export const MAX_FILES = 128
export class FileCountLimit extends MemoryFault {
  constructor() {
    super('MEMORY_CONSOLIDATION_REQUIRED')
  }
}
function removalSlices(
  before: MemoryFile,
  candidate: MemoryFile,
  verifiedRemoval?: boolean | readonly string[],
) {
  if (candidate.path !== 'MEMORY.md') return undefined
  if (verifiedRemoval === true) return verifiedSingleParagraphRemoval(before.content, candidate.content)
  if (Array.isArray(verifiedRemoval)) {
    const { content, slices } = applyParagraphRemovalsWithSlices(before.content, verifiedRemoval)
    if (content === candidate.content) return slices
  }
  return undefined
}

function validateTopicLinks(
  before: MemoryFile,
  candidate: MemoryFile,
  files: readonly MemoryFile[],
  slices?: readonly PreservedSlice[],
) {
  const prior = slices ? [...topicLinks(before.content)] : []
  for (const link of topicLinks(candidate.content)) {
    if (slices && isPreExistingMatch(link.start, link.end, slices, prior)) continue
    const target = name(link.target)
    if (target !== candidate.path && files.some((entry) => entry.path === target)) continue
    throw fault('MEMORY_MISSING_TOPIC')
  }
}

export class MemoryStore {
  constructor(
    readonly protectedRoot: string,
    readonly root: string,
    private readonly layer: 'workspace' | 'user' = 'workspace',
  ) {}

  ensure(): void {
    safe(this.protectedRoot, this.root)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }
  private readText(path: string, limit: number, limitCode: string, requireUtf8 = false): string | undefined {
    const absolute = join(this.root, path)
    safe(this.protectedRoot, absolute)
    let fd: number | undefined
    try {
      fd = openCanonicalFileSync(absolute)
      const { size, nlink } = fstatSync(fd)
      if (nlink !== 1) throw fault('MEMORY_SCOPE_DENIED')
      if (size > limit) throw fault(limitCode)
      const bytes = Buffer.alloc(size + 1)
      let used = 0
      while (used < bytes.length) {
        const count = readSync(fd, bytes, used, bytes.length - used, null)
        if (!count) break
        used += count
      }
      if (used !== size || (requireUtf8 && !isUtf8(bytes.subarray(0, used)))) throw fault('MEMORY_CONFLICT')
      return bytes.toString('utf8', 0, used)
    } catch (error) {
      if (!missing(error)) throw error
      return undefined
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  read(path: string, requireUtf8 = false): MemoryFile {
    return file(
      path,
      this.readText(name(path), MAX_FILE_BYTES, 'MEMORY_CONSOLIDATION_REQUIRED', requireUtf8) ?? '',
    )
  }
  fileSize(path: string): number | undefined {
    name(path)
    const absolute = join(this.root, path)
    safe(this.protectedRoot, absolute)
    try {
      return statSync(absolute).size
    } catch (error) {
      if (missing(error)) return undefined
      throw error
    }
  }
  files(purpose: 'view' | 'commit' = 'view', allowOverCount = false): MemoryFile[] {
    safe(this.protectedRoot, this.root)
    if (!existsSync(this.root)) return []
    const userView = this.layer === 'user' && purpose === 'view'
    const paths = readdirSync(this.root, { withFileTypes: true })
      .filter((entry) =>
        userView && entry.name !== 'MEMORY.md'
          ? entry.isFile() && isMemoryName(entry.name) && (this.fileSize(entry.name) ?? 0) <= MAX_FILE_BYTES
          : entry.name.endsWith('.md'),
      )
      .map((entry) => entry.name)
      .sort()
    if (paths.length <= MAX_FILES) return paths.map((path) => this.read(path))
    if (!allowOverCount) throw new FileCountLimit()
    // Management can shrink an over-count store. Keep the ordinary enumeration's hard read bound.
    let bytes = 0
    return paths.map((path) => {
      const entry = this.read(path)
      bytes += entry.bytes
      if (bytes > MAX_FILES * MAX_FILE_BYTES) throw fault('MEMORY_CONSOLIDATION_REQUIRED')
      return entry
    })
  }
  settingsText(): string | undefined {
    try {
      return this.readText('settings.json', 4096, 'MEMORY_INVALID_SETTINGS')
    } catch (error) {
      if ((error as { code?: string }).code === 'MEMORY_SCOPE_DENIED') throw error
      throw fault('MEMORY_INVALID_SETTINGS')
    }
  }
  configuration(): MemorySettings {
    const raw = this.settingsText()
    if (raw === undefined) return defaults
    try {
      return storedSettings(JSON.parse(raw))
    } catch {
      throw fault('MEMORY_INVALID_SETTINGS')
    }
  }
  /**
   * writer.json keeps the whole source, including a background run's `maintenance` id. The value
   * returned here becomes the inspection's `lastWriter`, which clients validate against a closed
   * schema; clients that predate `maintenance` refuse unknown fields, so only the original fields
   * are returned.
   */
  writer(): MemorySource | undefined {
    const path = join(this.root, 'writer.json')
    safe(this.protectedRoot, path)
    try {
      if (statSync(path).size > 4096) throw fault('MEMORY_INVALID_METADATA')
      const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<MemorySource>
      if (
        typeof value.sessionKey !== 'string' ||
        value.sessionKey.length > 256 ||
        !Number.isSafeInteger(value.turn) ||
        (value.turn ?? -1) < 0 ||
        (value.toolUseId !== undefined &&
          (typeof value.toolUseId !== 'string' || value.toolUseId.length > 256))
      )
        throw fault('MEMORY_INVALID_METADATA')
      return {
        sessionKey: value.sessionKey,
        turn: value.turn!,
        ...(value.toolUseId ? { toolUseId: value.toolUseId } : {}),
      }
    } catch (error) {
      if (missing(error)) return undefined
      throw fault('MEMORY_INVALID_METADATA')
    }
  }
  /**
   * Hashes of the memory files as this provider last wrote or acknowledged them. Missing or
   * unreadable means no baseline, never a change.
   */
  acknowledged(): Readonly<Record<string, string>> | undefined {
    const path = join(this.root, 'acknowledged.json')
    safe(this.protectedRoot, path)
    try {
      if (statSync(path).size > 64 * 1024) return undefined
      const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; files?: unknown }
      if (value.version !== 1 || typeof value.files !== 'object' || value.files === null) return undefined
      const files = value.files as Record<string, unknown>
      return Object.values(files).every((hash) => typeof hash === 'string')
        ? (files as Record<string, string>)
        : undefined
    } catch {
      return undefined
    }
  }
  private acknowledge(files: Readonly<Record<string, string>>): void {
    this.atomic(join(this.root, 'acknowledged.json'), JSON.stringify({ version: 1, files }))
  }
  /**
   * Names of memory files changed, added or removed outside this provider since it last wrote or
   * acknowledged them, for example by an unconfined shell under full access. The current state is
   * then acknowledged, so each change is reported once. The first observation only records a
   * baseline. This is a notice, not a boundary: whoever can write the files can write the record.
   */
  async externalChanges(observed: readonly MemoryFile[]): Promise<string[]> {
    const known = this.acknowledged()
    if (known ? sameHashes(known, observed) : observed.length === 0) return []
    return this.locked(() => {
      const current = this.files()
      const before = this.acknowledged()
      this.acknowledge(hashes(current))
      if (!before) return []
      const after = hashes(current)
      return [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((path) => before[path] !== after[path])
        .sort()
        .slice(0, 16)
    })
  }
  atomic(path: string, content: string, verify?: () => void): void {
    safe(this.protectedRoot, path)
    const temporary = `${path}.${randomUUID()}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      try {
        writeFileSync(fd, content)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      safe(this.protectedRoot, path)
      verify?.()
      renameWriteThroughSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
  /** SQLite owns the lock across processes and releases it on crash; no stale PID markers. */
  async locked<T>(
    action: () => T | Promise<T>,
    signal?: AbortSignal,
    onLockRefusal?: (error: unknown) => never,
  ): Promise<T> {
    signal?.throwIfAborted()
    this.ensure()
    const path = join(this.root, 'commit.sqlite')
    safe(this.protectedRoot, path)
    const db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    const deadline = performance.now() + 5000
    try {
      db.exec('PRAGMA busy_timeout=0')
      for (;;) {
        signal?.throwIfAborted()
        try {
          db.exec('BEGIN EXCLUSIVE')
          break
        } catch (error) {
          if (![5, 6].includes((error as { errcode?: number }).errcode ?? 0)) throw fault('MEMORY_BUSY')
          if (performance.now() >= deadline) {
            signal?.throwIfAborted()
            const busy = fault('MEMORY_BUSY')
            if (onLockRefusal) onLockRefusal(busy)
            throw busy
          }
          await delay(10, undefined, { signal })
        }
      }
      try {
        const value = action()
        const result = value instanceof Promise ? await value : value
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } finally {
      db.close()
    }
  }
  async configure(input: Partial<MemorySettings>): Promise<void> {
    await this.locked(() => {
      this.atomic(
        join(this.root, 'settings.json'),
        JSON.stringify(settings({ ...this.configuration(), ...input })),
      )
    })
  }
  async deleteFile(
    path: string,
    baseHash: string,
    source: MemorySource,
    agentMode: false | 'ask' | 'auto',
    prepare: (before: MemoryFile, candidate: MemoryFile) => () => void,
    signal?: AbortSignal,
    admission?: MemoryEffectAdmission,
    onPreCommitRefusal?: (error: unknown) => never,
  ): Promise<void> {
    await this.locked(
      async () => {
        const assertActive = () => {
          signal?.throwIfAborted()
          admission?.assertActive()
        }
        await admission?.verify()
        assertActive()
        const absolute = join(this.root, path)
        const validate = () => {
          name(path)
          safe(this.protectedRoot, absolute)
          if (path.toLowerCase() === 'memory.md') throw fault('MEMORY_SCOPE_DENIED')
          const config = this.configuration()
          if (agentMode && config.mode === 'off') throw fault('MEMORY_DISABLED')
          if (agentMode && config.mode !== agentMode) throw fault('MEMORY_POLICY_CHANGED')
          if (this.fileSize(path) === undefined) throw fault('MEMORY_NOT_FOUND')
          const before = this.read(path, true)
          if (before.hash !== baseHash) throw fault('MEMORY_CONFLICT')
          const all = this.files('commit', true)
          // Bind metadata to the actual on-disk spelling on case-insensitive filesystems.
          if (!all.some((entry) => entry.path === path)) throw fault('MEMORY_CONFLICT')
          for (const link of topicLinks(this.read('MEMORY.md').content))
            if (link.target.toLowerCase() === path.toLowerCase()) throw fault('MEMORY_TOPIC_REFERENCED')
          return { all, after: prepare(before, file(path, '')) }
        }
        let checked: ReturnType<typeof validate>
        try {
          checked = validate()
        } catch (error) {
          onPreCommitRefusal?.(error)
          throw error
        }
        assertActive()
        forgetProvenance(new MetaStore(this), path)
        await unlinkTopic(
          absolute,
          (tombstone) => {
            const content = this.readText(basename(tombstone), MAX_FILE_BYTES, 'MEMORY_CONFLICT', true)
            return content !== undefined && hash(content) === baseHash
          },
          assertActive,
        )
        let failed = false
        for (const publish of [
          () => syncTopicDirectory(absolute),
          () => this.atomic(join(this.root, 'writer.json'), JSON.stringify(source)),
          () => {
            const acknowledged = { ...(this.acknowledged() ?? hashes(checked.all)) }
            delete acknowledged[path]
            this.acknowledge(acknowledged)
          },
          checked.after,
        ]) {
          try {
            await publish()
          } catch {
            failed = true
          }
        }
        if (failed) throw fault('MEMORY_COMMITTED_METADATA_FAILED')
      },
      signal,
      onPreCommitRefusal,
    )
  }

  async commit(
    candidate: MemoryFile,
    baseHash: string,
    source: MemorySource,
    agentMode: false | 'ask' | 'auto',
    signal?: AbortSignal,
    admission?: MemoryEffectAdmission,
    prepare?: (before: MemoryFile, candidate: MemoryFile) => () => void,
    onPreCommitRefusal?: (error: unknown) => never,
    verifiedRemoval?: boolean | readonly string[],
  ): Promise<MemoryFile> {
    // Lock acquisition and provider validation precede the file effect and can attest refusals.
    // External admission, publication (including rename), and post-write metadata keep their own failure semantics.
    const checked = <T>(validate: () => T): T => {
      try {
        return validate()
      } catch (error) {
        if (onPreCommitRefusal) onPreCommitRefusal(error)
        throw error
      }
    }
    const validateCandidate = () => {
      const config = this.configuration()
      if (agentMode && config.mode === 'off') throw fault('MEMORY_DISABLED')
      if (agentMode && config.mode !== agentMode) throw fault('MEMORY_POLICY_CHANGED')
      const current = this.read(candidate.path)
      if (current.hash !== baseHash) throw fault('MEMORY_CONFLICT')
      const slices = removalSlices(
        current,
        candidate,
        verifiedRemoval === true && agentMode ? false : verifiedRemoval,
      )
      if (slices) validateRemovalContent(candidate, current, slices)
      else validateContent(candidate, config, candidate.path === 'MEMORY.md')
      const all = this.files('commit', !!slices)
      if (!slices) {
        if (!all.some((entry) => entry.path === candidate.path) && all.length + 1 > MAX_FILES)
          throw fault('MEMORY_CONSOLIDATION_REQUIRED')
        const bytes = all
          .filter((entry) => entry.path !== candidate.path)
          .reduce((n, entry) => n + entry.bytes, candidate.bytes)
        if (bytes > config.totalMaxBytes) throw fault('MEMORY_CONSOLIDATION_REQUIRED')
      }
      if (candidate.path === 'MEMORY.md') validateTopicLinks(current, candidate, all, slices)
      return { current, all, removal: !!slices }
    }
    const commit = () => {
      admission?.assertActive()
      const { current, all, removal } = checked(validateCandidate)
      signal?.throwIfAborted()
      let onCommitted: (() => void) | undefined
      this.atomic(join(this.root, candidate.path), candidate.content, () => {
        onCommitted = checked(() => {
          const observe = prepare?.(current, candidate)
          // A string cut cannot preserve malformed UTF-8 that was decoded with replacement characters.
          if (this.read(candidate.path, removal).hash !== baseHash) throw fault('MEMORY_CONFLICT')
          return observe
        })
        signal?.throwIfAborted()
        admission?.assertActive()
      })
      // The file has committed if metadata fails: do not report an unwritten file.
      let metadataFailed = false
      try {
        this.atomic(join(this.root, 'writer.json'), JSON.stringify(source), admission?.assertActive)
      } catch {
        metadataFailed = true
      }
      try {
        this.acknowledge({
          ...(this.acknowledged() ?? hashes(all)),
          [candidate.path]: candidate.hash,
        })
      } catch {
        metadataFailed = true
      }
      try {
        onCommitted?.()
      } catch {
        metadataFailed = true
      }
      if (metadataFailed) throw fault('MEMORY_COMMITTED_METADATA_FAILED')
      return candidate
    }
    return this.locked(
      admission
        ? async () => {
            await admission.verify()
            admission.assertActive()
            return commit()
          }
        : commit,
      signal,
      onPreCommitRefusal,
    )
  }
}

function hashes(files: readonly MemoryFile[]): Record<string, string> {
  return Object.fromEntries(files.map((entry) => [entry.path, entry.hash]))
}
function sameHashes(known: Readonly<Record<string, string>>, files: readonly MemoryFile[]): boolean {
  return (
    Object.keys(known).length === files.length && files.every((entry) => known[entry.path] === entry.hash)
  )
}
