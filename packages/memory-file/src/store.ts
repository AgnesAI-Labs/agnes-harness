import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { MemoryFile, MemorySettings, MemorySource } from '@agnes/extension-api'
import { renameWriteThroughSync } from '@agnes/system-node'
import { defaults, fault, file, settings, validateContent } from './content.js'
import { missing, name, safe } from './paths.js'

export class MemoryStore {
  constructor(
    readonly protectedRoot: string,
    readonly root: string,
  ) {}

  ensure(): void {
    safe(this.protectedRoot, this.root)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
  }
  read(path: string): MemoryFile {
    name(path)
    const absolute = join(this.root, path)
    safe(this.protectedRoot, absolute)
    try {
      if (statSync(absolute).size > 1024 * 1024) throw fault('MEMORY_CONSOLIDATION_REQUIRED')
      return file(path, readFileSync(absolute, 'utf8'))
    } catch (error) {
      if (missing(error)) return file(path, '')
      throw error
    }
  }
  files(): MemoryFile[] {
    safe(this.protectedRoot, this.root)
    if (!existsSync(this.root)) return []
    const paths = readdirSync(this.root)
      .filter((path) => path.endsWith('.md'))
      .sort()
    if (paths.length > 128) throw fault('MEMORY_CONSOLIDATION_REQUIRED')
    return paths.map((path) => this.read(path))
  }
  configuration(): MemorySettings {
    const path = join(this.root, 'settings.json')
    safe(this.protectedRoot, path)
    try {
      if (statSync(path).size > 4096) throw fault('MEMORY_INVALID_SETTINGS')
      return settings(JSON.parse(readFileSync(path, 'utf8')))
    } catch (error) {
      if (missing(error)) return defaults
      throw fault('MEMORY_INVALID_SETTINGS')
    }
  }
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
  async locked<T>(action: () => T, signal?: AbortSignal): Promise<T> {
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
          if (![5, 6].includes((error as { errcode?: number }).errcode ?? 0) || performance.now() >= deadline)
            throw fault('MEMORY_BUSY')
          await delay(10, undefined, { signal })
        }
      }
      try {
        const value = action()
        db.exec('COMMIT')
        return value
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
  async commit(
    candidate: MemoryFile,
    baseHash: string,
    source: MemorySource,
    agentMode: false | 'ask' | 'auto',
    signal?: AbortSignal,
  ): Promise<MemoryFile> {
    return this.locked(() => {
      const config = this.configuration()
      if (agentMode && config.mode === 'off') throw fault('MEMORY_DISABLED')
      if (agentMode && config.mode !== agentMode) throw fault('MEMORY_POLICY_CHANGED')
      validateContent(candidate, config, candidate.path === 'MEMORY.md')
      const current = this.read(candidate.path)
      if (current.hash !== baseHash) throw fault('MEMORY_CONFLICT')
      const all = this.files()
      const bytes =
        all.filter((entry) => entry.path !== candidate.path).reduce((n, entry) => n + entry.bytes, 0) +
        candidate.bytes
      if (bytes > config.totalMaxBytes) throw fault('MEMORY_CONSOLIDATION_REQUIRED')
      if (candidate.path === 'MEMORY.md') {
        for (const match of candidate.content.matchAll(
          /\]\(([^)\s]+\.md)(?:#[^)\s]*)?(?:\s+"[^"]*")?\)|\[\[([^\]#]+\.md)(?:#[^\]]*)?\]\]|^\[[^\]]+\]:\s*(\S+\.md)(?:#\S*)?/gm,
        )) {
          const target = name(match[1] ?? match[2] ?? match[3]!)
          if (target === candidate.path || !all.some((entry) => entry.path === target))
            throw fault('MEMORY_MISSING_TOPIC')
        }
      }
      signal?.throwIfAborted()
      this.atomic(join(this.root, candidate.path), candidate.content, () => {
        if (this.read(candidate.path).hash !== baseHash) throw fault('MEMORY_CONFLICT')
      })
      // The file has committed if metadata fails: do not report an unwritten file.
      try {
        this.atomic(join(this.root, 'writer.json'), JSON.stringify(source))
      } catch {
        throw fault('MEMORY_COMMITTED_METADATA_FAILED')
      }
      return candidate
    }, signal)
  }
}
