import type { MemoryFile } from '@agnes/extension-api'
import { fault, hash } from './content.js'
import { META_MAX_BYTES, type MetaStore } from './meta.js'
import { PARAGRAPH_ID, parseParagraphs } from './paragraphs.js'
import type { CommitIntent, CommitObserver, ViewContext } from './pipeline.js'

type Identity = { blockHash: string; id?: string; textHash?: string }
export type MemoryBlock = Identity & { text: string }
type Attribution = { origin: CommitIntent['origin']; at: number }
type RecordBlock = Identity & Attribution
type Provenance = { version: 1; files: Record<string, { blocks: RecordBlock[] }> }

const FILENAME = 'provenance.json'
const digest = /^[0-9a-f]{64}$/
export const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase()

/** Parse managed bodies before splitting the gaps, so blank lines inside a paragraph keep its identity. */
export function memoryBlocks(content: string): MemoryBlock[] {
  const body = content.startsWith('\uFEFF') ? content.slice(1) : content
  const blocks: MemoryBlock[] = []
  function addPlain(gap: string) {
    for (const piece of gap.split(/\r?\n\s*\n/)) {
      // A boundary line break can belong to an adjoining paragraph or the end of the file.
      const text = piece.replace(/^\r?\n|\r?\n$/g, '')
      const normalized = normalize(text)
      if (!normalized) continue
      const blockHash = hash(normalized)
      blocks.push({ text, blockHash, ...(text !== normalized ? { textHash: hash(text) } : {}) })
    }
  }
  let cursor = 0
  for (const { start, end, id, text } of parseParagraphs(body).paragraphs) {
    addPlain(body.slice(cursor, start))
    blocks.push({ text, id, blockHash: `managed:${id}`, textHash: hash(text) })
    cursor = end
  }
  addPlain(body.slice(cursor))
  return blocks
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validRecord(value: unknown): value is RecordBlock {
  if (!object(value) || typeof value.blockHash !== 'string' || !Number.isSafeInteger(value.at)) return false
  if (value.origin !== 'human' && value.origin !== 'host' && value.origin !== 'agent') return false
  if (value.textHash !== undefined && (typeof value.textHash !== 'string' || !digest.test(value.textHash)))
    return false
  if (value.id === undefined) return digest.test(value.blockHash)
  return (
    typeof value.id === 'string' &&
    PARAGRAPH_ID.test(value.id) &&
    value.blockHash === `managed:${value.id}` &&
    value.textHash !== undefined
  )
}

function readProvenance(meta: MetaStore): Provenance {
  const data = meta.readJson<unknown>(FILENAME)
  if (object(data) && data.version === 1 && object(data.files)) {
    const files: Provenance['files'] = Object.create(null)
    for (const [path, value] of Object.entries(data.files)) {
      if (!object(value) || !Array.isArray(value.blocks) || !value.blocks.every(validRecord))
        return { version: 1, files: {} }
      files[path] = { blocks: value.blocks }
    }
    return { version: 1, files }
  }
  return { version: 1, files: {} }
}

export const blockVersion = (block: Identity): string =>
  `${block.blockHash}:${block.textHash ?? block.blockHash}`

/** Consume occurrences individually. When equal copies disappear, keep human ownership first. */
function matchRecords(records: readonly RecordBlock[], blocks: readonly Identity[]) {
  const needed = new Map<string, number>()
  for (const block of blocks) {
    const key = blockVersion(block)
    needed.set(key, (needed.get(key) ?? 0) + 1)
  }
  const byVersion = new Map<string, RecordBlock[]>()
  for (const record of records) {
    const key = blockVersion(record)
    const bucket = byVersion.get(key) ?? []
    bucket.push(record)
    byVersion.set(key, bucket)
  }
  for (const [key, bucket] of byVersion) {
    if (bucket.length > (needed.get(key) ?? 0))
      bucket.sort((a, b) => Number(b.origin === 'human') - Number(a.origin === 'human'))
    bucket.reverse()
  }
  return (block: Identity) => byVersion.get(blockVersion(block))?.pop()
}

export function attributedBlocks(
  file: MemoryFile,
  ctx: ViewContext,
  records?: readonly RecordBlock[],
): Array<MemoryBlock & Attribution> {
  const blocks = memoryBlocks(file.content)
  if (ctx.layer === 'user')
    return blocks.map((block) => ({ ...block, origin: block.id ? 'host' : 'human', at: ctx.now }))
  const prior = matchRecords(records ?? readProvenance(ctx.meta).files[file.path]?.blocks ?? [], blocks)
  return blocks.map((block) => {
    const retained = prior(block)
    return { ...block, origin: retained?.origin ?? 'human', at: retained?.at ?? ctx.now }
  })
}

function nextProvenance(intent: CommitIntent, candidateFile: MemoryFile, ctx: ViewContext): Provenance {
  const data = readProvenance(ctx.meta)
  const present = new Set(ctx.files.map((file) => file.path))
  for (const path of Object.keys(data.files)) {
    if (!present.has(path)) delete data.files[path]
  }
  const candidate = memoryBlocks(candidateFile.content)
  const prior = matchRecords(
    attributedBlocks(intent.before, ctx, data.files[intent.path]?.blocks ?? []),
    candidate,
  )
  const blocks = candidate.map(({ text: _text, ...identity }) => {
    const retained = prior(identity)
    return { ...identity, origin: retained?.origin ?? intent.origin, at: retained?.at ?? ctx.now }
  })
  data.files[intent.path] = { blocks }
  return data
}

const prepared = new WeakMap<CommitIntent, Provenance>()

export function prepareProvenance(intent: CommitIntent, ctx: ViewContext): void {
  const data = nextProvenance(intent, intent.candidate, ctx)
  if (Buffer.byteLength(JSON.stringify(data)) > META_MAX_BYTES) throw fault('MEMORY_CONSOLIDATION_REQUIRED')
  prepared.set(intent, data)
}

export const provenanceObserver: CommitObserver = (intent, committed, ctx) => {
  if (ctx.layer === 'user') return
  const data = prepared.get(intent) ?? nextProvenance(intent, committed, ctx)
  prepared.delete(intent)
  try {
    ctx.meta.writeJson(FILENAME, data)
  } catch (error) {
    // The file already landed. An older origin must never become authoritative again for those bytes.
    ctx.meta.remove(FILENAME)
    throw error
  }
}
