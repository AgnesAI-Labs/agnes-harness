import type { EntryRow } from './entry-row.js'

/** Resolve one normalized row into the opaque input expected by its mount adapter. */
export type EntryImporter<TImported> = (row: Readonly<EntryRow>) => TImported | PromiseLike<TImported>
