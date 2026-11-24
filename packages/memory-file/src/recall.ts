import type { MemoryRecallHit, MemoryRecallQuery } from '@agnes/extension-api'
import { fitHits } from '@agnes/lexical-search'
import { chunkView } from './chunker.js'
import { fault, omissionLine } from './content.js'
import type { MetaStore } from './meta.js'
import { managedParagraphRanges } from './paragraphs.js'
import type { MemoryPipeline, RecallEnvironment } from './pipeline.js'
import { readDocuments, SearchIndex } from './search-index.js'
import { buildView } from './view.js'

function cap(value: number | undefined, fallback: number, maximum: number) {
  return value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(0, Math.min(Math.floor(value), maximum))
}

function recall(
  query: MemoryRecallQuery,
  env: RecallEnvironment,
  indexFor: (meta: MetaStore) => SearchIndex,
) {
  const hits: MemoryRecallHit[] = []
  const settings = env.meta.store.configuration()
  const collect = (layer: 'workspace' | 'user') => {
    const files = layer === 'workspace' ? env.workspaceFiles : env.userFiles
    const views = layer === 'workspace' ? env.workspaceViews : env.userViews
    const index = indexFor(layer === 'workspace' ? env.meta : env.userMeta)
    const docs = readDocuments(files, views, settings)
    const byPath = new Map(docs.map((doc) => [doc.file.path, doc]))
    const chunks = new Map<string, ReturnType<typeof chunkView>>()
    for (const hit of index.query(query.query, files, docs)) {
      const doc = byPath.get(hit.doc)
      if (!doc || doc.fingerprint !== hit.fingerprint) continue
      const visible = chunks.get(hit.doc) ?? chunkView(doc.file, doc.view)
      chunks.set(hit.doc, visible)
      const part = visible[hit.ord]
      if (part && part.text === hit.text) hits.push({ layer, ...part, score: hit.score })
    }
  }
  collect('workspace')
  if (query.includeUser && env.userEnabled && settings.userEnabled) collect('user')
  hits.sort((a, b) => b.score - a.score)
  const fitted = fitHits(hits, cap(query.limit, 8, 32), cap(query.maxBytes, 6144, 16384))
  return {
    revision: env.revision,
    truncated: fitted.truncated,
    hits: fitted.hits.map((hit) => ({
      ...hit,
      lineEnd: hit.lineStart + hit.text.replace(/\n$/, '').split('\n').length - 1,
    })),
  }
}

export function registerRetrieval(pipeline: MemoryPipeline): void {
  let closed = false
  const indexes = new Map<MetaStore, SearchIndex>()
  const indexFor = (meta: MetaStore) => {
    if (closed) throw fault('MEMORY_RECALL_UNAVAILABLE')
    let index = indexes.get(meta)
    if (!index) {
      index = new SearchIndex(meta)
      indexes.set(meta, index)
    }
    return index
  }
  // Phase 0's default managed-paragraph filter covers workspace memory. Apply the
  // same registry-backed read rules to the optional user index.
  pipeline.addViewFilter((file, ctx) =>
    ctx.layer === 'user' && file.path === 'MEMORY.md'
      ? managedParagraphRanges(file.content, ctx.validity).ranges
      : [],
  )
  pipeline.addObserver((_intent, _committed, ctx) => {
    const views = new Map(
      ctx.files.map((file) => [
        file.path,
        buildView(file, pipeline.collectHideRanges(file, ctx), 'read', (group, count) =>
          group === 'managed' ? omissionLine(count) : '',
        ),
      ]),
    )
    indexFor(ctx.meta).committed(readDocuments(ctx.files, views, ctx.meta.store.configuration()))
  })
  pipeline.setRecall(async (query, env) => recall(query, env, indexFor))
  pipeline.addCloseHook(() => {
    closed = true
    for (const index of indexes.values()) index.close()
    indexes.clear()
  })
}
