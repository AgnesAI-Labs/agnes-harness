import type { MemoryFile } from '@agnes/extension-api'
import { omissionLine } from './content.js'
import { expiryNextExpiry, expiryViewFilter } from './expiry-annotation.js'
import type { MemoryPipeline, ViewContext } from './pipeline.js'
import { refViewFilter } from './ref-filter.js'
import { topicLinksObserver, topicLinksViewFilter } from './topic-links.js'
import { buildView, type MemoryView } from './view.js'

const lifecyclePipelines = new WeakSet<MemoryPipeline>()

export function registerLifecycle(pipeline: MemoryPipeline): void {
  if (lifecyclePipelines.has(pipeline)) return
  lifecyclePipelines.add(pipeline)
  pipeline.addViewFilter(expiryViewFilter)
  pipeline.addNextExpiry(expiryNextExpiry)
  pipeline.addViewFilter(topicLinksViewFilter)
  pipeline.addObserver(topicLinksObserver)
  pipeline.addViewFilter(refViewFilter)
}

export function formatLifecycleOmission(group: string, count: number): string {
  if (group === 'managed') return omissionLine(count)
  if (group === 'ref-withdrawn')
    return `[${count} ${count === 1 ? 'line' : 'lines'} referencing withdrawn or expired memory hidden]`
  return ''
}

type Chunk = Readonly<{ path: string; lineStart: number; lineEnd: number; text: string }>
type IndexInspection = {
  readIndexedChunks: () => readonly Chunk[] | Promise<readonly Chunk[]>
  /** The index owner's chunker, including its exclusion of synthetic notice segments. */
  chunkView: (file: MemoryFile, view: MemoryView) => readonly Chunk[]
}
type Inspection = Readonly<{
  pipeline: MemoryPipeline
  context: ViewContext
  /** Workspace index contribution to the turn, excluding the envelope and before budget truncation. */
  injectedIndex: string
  /** Observed R2 views of the workspace at the same turn boundary. */
  readViews: ReadonlyMap<string, MemoryView>
}> &
  (IndexInspection | { readIndexedChunks?: undefined; chunkView?: undefined })

function sameView(expected: MemoryView, observed: MemoryView | undefined): boolean {
  return (
    observed !== undefined &&
    observed.path === expected.path &&
    observed.content === expected.content &&
    observed.hidden === expected.hidden &&
    expected.segments.length === observed.segments.length &&
    expected.segments.every((seg, i) => {
      const other = observed.segments[i]
      return (
        other !== undefined && seg.raw === other.raw && seg.view === other.view && seg.length === other.length
      )
    }) &&
    expected.omitted.length === observed.omitted.length &&
    expected.omitted.every((id, i) => observed.omitted[i] === id)
  )
}

/** Compare complete chunk multisets (including duplicates and coordinates), independent of SQL row order. */
function chunksByFile(chunks: readonly Chunk[]): Map<string, string[]> {
  const files = new Map<string, string[]>()
  for (const { path, lineStart, lineEnd, text } of chunks) {
    const values = files.get(path) ?? []
    values.push(JSON.stringify([lineStart, lineEnd, text]))
    files.set(path, values)
  }
  for (const values of files.values()) values.sort()
  return files
}

/** Internal workspace turn-boundary check. Note-only filters intentionally give the two views different text. */
export async function inspectConsistency(
  args: Inspection,
): Promise<{ ok: boolean; mismatches: readonly string[] }> {
  const { context, pipeline } = args
  const mismatches: string[] = []
  const chunks: Chunk[] = []
  const extraReads = new Set(args.readViews.keys())
  let expectedIndex = ''
  for (const entry of context.files) {
    extraReads.delete(entry.path)
    const ranges = pipeline.collectHideRanges(entry, context)
    const read = buildView(entry, ranges, 'read', formatLifecycleOmission)
    const repeated = pipeline.collectHideRanges(entry, context)
    if (JSON.stringify(ranges) !== JSON.stringify(repeated)) mismatches.push(`filter: ${entry.path}`)
    if (!sameView(read, args.readViews.get(entry.path))) mismatches.push(`read: ${entry.path}`)
    if (entry.path === 'MEMORY.md')
      expectedIndex = buildView(entry, ranges, 'note', formatLifecycleOmission).content
    if (args.chunkView) {
      for (const chunk of args.chunkView(entry, read)) chunks.push(chunk)
    }
  }
  for (const path of extraReads) mismatches.push(`read: ${path}`)
  if (expectedIndex !== args.injectedIndex) mismatches.push('injection: MEMORY.md')
  if (args.readIndexedChunks) {
    const actual = chunksByFile(await args.readIndexedChunks())
    const expected = chunksByFile(chunks)
    for (const path of new Set([...actual.keys(), ...expected.keys()])) {
      const left = expected.get(path) ?? []
      const right = actual.get(path) ?? []
      if (left.length !== right.length || left.some((chunk, i) => chunk !== right[i]))
        mismatches.push(`index: ${path}`)
    }
  }
  return { ok: mismatches.length === 0, mismatches }
}

/** The index owner rebuilds from current filtered views and owns the transaction and connection. */
export async function rebuildConsistencyIndex(rebuilder: () => void | Promise<void>): Promise<void> {
  await rebuilder()
}
