export const LEXICAL_SEARCH_VERSION = '1' as const
export { type AliasMap, loadAliases, technicalAliases } from './aliases.js'
export {
  type Chunk,
  ensureIndex,
  type IndexedChunk,
  listChunks,
  rebuildAll,
  removeDoc,
  type SearchDocument,
  search,
  transaction,
  upsertDoc,
} from './fts.js'
export { bestPerDoc, fitHits, fuse } from './fuse.js'
export { buildQuery } from './query.js'
export { cjkTokens, normalize, tokenize, tokenizerVersion } from './tokenize.js'
