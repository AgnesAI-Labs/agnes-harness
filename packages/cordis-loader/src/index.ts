export { normalizePluginRuntime } from './config.js'
export type { EntryRow, MountIdentity, MountIdentityInput, NormalizedPluginRuntime } from './entry-row.js'
export {
  createEntryTreeHostTransaction,
  type EntryMountAdapter,
  EntryTree,
  EntryTreeError,
  type EntryTreeErrorCode,
  type EntryTreeHostTransaction,
  EntryTreeTransactionError,
  type EntryTreeTransactionJournal,
  type EntryTreeTransactionOperation,
  type EntryTreeTransactionOperationKind,
  type EntryTreeTransactionPrepareOptions,
  type EntryTreeTransactionStep,
  type InstallationUpdateResult,
  type PreparedEntryTreeTransaction,
} from './entry-tree.js'
export type { EntryImporter } from './loader.js'
export { buildMountIdentity } from './mount-identity.js'
