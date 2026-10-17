import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ProfileManagedInit, ServiceContext, ToolContext } from '@agnes/extension-api'
import { Value } from '@sinclair/typebox/value'
import {
  boundedCitations,
  type Citation,
  type Config,
  ConfigSchema,
  HistorySchema,
  MAX_DOCUMENT_BYTES,
  type Source,
} from './contracts.js'

export type ReadContext =
  | Pick<ToolContext, 'session' | 'fs' | 'signal'>
  | Pick<ServiceContext, 'session' | 'fs' | 'signal'>
export const hash = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex')
export class KnowledgeError extends Error {
  constructor(readonly code: 'revoked' | 'unavailable' | 'invalid' | 'sensitive') {
    super(code)
  }
}
// Reject common credential material rather than moving it into model results or evidence.
const secret =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|access[_-]?token|password|authorization)\s*[:=]\s*\S+)|\bBearer\s+\S+/i
export function safeText(text: string): void {
  if (secret.test(text)) throw new KnowledgeError('sensitive')
}
export function parseConfig(value: unknown): Config {
  if (!Value.Check(ConfigSchema, value)) throw new KnowledgeError('invalid')
  const ids = new Set<string>()
  for (const source of value.sources) {
    if (
      ids.has(source.id) ||
      !isAbsolute(source.workspaceRoot) ||
      resolve(source.workspaceRoot) !== source.workspaceRoot
    )
      throw new KnowledgeError('invalid')
    ids.add(source.id)
    if (source.kind === 'local') {
      const parts = source.path.split(/[\\/]/)
      if (
        isAbsolute(source.path) ||
        parts.length > 32 ||
        parts.some((part) => !part || part === '..' || part === '.') ||
        source.path.includes('\\')
      )
        throw new KnowledgeError('invalid')
    } else {
      if (Buffer.byteLength(source.text) > MAX_DOCUMENT_BYTES) throw new KnowledgeError('invalid')
      safeText(source.text)
    }
  }
  return value
}
export class KnowledgeResource {
  readonly config: Config
  constructor(private readonly init: ProfileManagedInit) {
    this.config = parseConfig(init.config)
  }
  assertLive(ctx: ReadContext): void {
    ctx.signal.throwIfAborted()
    this.init.signal.throwIfAborted()
    this.init.assertCurrent()
    if (!ctx.session?.key || !ctx.session.workspaceRoot) throw new KnowledgeError('revoked')
  }
  source(id: string, ctx: ReadContext): Source {
    this.assertLive(ctx)
    const source = this.config.sources.find((item) => item.id === id)
    if (
      !source?.enabled ||
      source.workspaceRoot !== ctx.session?.workspaceRoot ||
      !source.sessionKeys.includes(ctx.session.key)
    )
      throw new KnowledgeError('revoked')
    return source
  }
  catalog(ctx: ReadContext) {
    this.assertLive(ctx)
    return this.config.sources
      .filter((source) => {
        try {
          this.source(source.id, ctx)
          return true
        } catch {
          return false
        }
      })
      .map(({ id, kind }) => ({ id, kind }))
  }
  async read(id: string, ctx: ReadContext) {
    const source = this.source(id, ctx)
    let text: string
    let revision: string
    let locator: string
    if (source.kind === 'local') {
      const path = resolve(source.workspaceRoot, source.path)
      if (relative(source.workspaceRoot, path).startsWith('..')) throw new KnowledgeError('revoked')
      try {
        // Stat each named parent too, so a configured source cannot opt into symlink traversal.
        const parts = source.path.split('/')
        for (let count = 1; count < parts.length; count++) {
          const parent = await ctx.fs.stat(resolve(source.workspaceRoot, ...parts.slice(0, count)))
          this.source(id, ctx)
          if (parent.kind !== 'dir') throw new KnowledgeError('unavailable')
        }
        // Host filesystem ports independently enforce their live fence on the actual read.
        const info = await ctx.fs.stat(path)
        if (info.kind !== 'file' || info.size > MAX_DOCUMENT_BYTES) throw new KnowledgeError('unavailable')
        this.source(id, ctx)
        const bytes = await ctx.fs.read(path, { limit: MAX_DOCUMENT_BYTES + 1 })
        if (bytes.length > MAX_DOCUMENT_BYTES) throw new KnowledgeError('unavailable')
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      } catch {
        throw new KnowledgeError('unavailable')
      }
      revision = `sha256:${hash(text)}`
      locator = source.path
    } else {
      // Offline API boundary: no endpoint, headers, credential values or arbitrary methods.
      if (!source.available) throw new KnowledgeError('unavailable')
      text = source.text
      revision = source.revision
      locator = `synthetic:${source.id}`
    }
    this.source(id, ctx)
    safeText(text)
    return { text, revision, locator, contentHash: hash(text), kind: source.kind }
  }
  private key(ctx: ReadContext): string {
    this.assertLive(ctx)
    return `citations/${hash(JSON.stringify([ctx.session?.workspaceRoot, ctx.session?.key]))}`
  }
  history(ctx: ReadContext): Citation[] {
    const value = this.init.store.get(this.key(ctx))
    if (value === undefined) return []
    if (!Value.Check(HistorySchema, value)) throw new KnowledgeError('unavailable')
    return value
  }
  remember(citation: Citation, ctx: ReadContext): void {
    this.source(citation.sourceId, ctx)
    const key = this.key(ctx)
    this.init.store.transaction(() => {
      const rows = this.history(ctx).filter((row) => row.id !== citation.id)
      this.init.store.set(key, boundedCitations([...rows, citation]))
    })
  }
}
export async function startKnowledge(init: ProfileManagedInit): Promise<KnowledgeResource> {
  const resource = new KnowledgeResource(init)
  init.onShutdown(async () => ({ state: 'settled' }))
  init.ready()
  return resource
}
