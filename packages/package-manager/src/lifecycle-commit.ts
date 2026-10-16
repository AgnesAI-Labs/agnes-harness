import { PackageError } from './errors.js'
import { exampleParentBlockers } from './example-parent.js'
import { readInventory } from './inventory.js'
import { commitPackage as commit } from './store.js'

/** Every activation path, including composite update/rollback, checks the current parent. */
export function commitPackage(...args: Parameters<typeof commit>): void {
  const [store, lock, , entry] = args
  if (entry?.state.enabled && entry.metadata?.exampleOf) {
    const blockers = exampleParentBlockers(entry, readInventory(lock, store).packages)
    if (blockers.length)
      throw new PackageError('E_API_RANGE', 'Example requires an enabled, trusted parent package.', {
        detail: { blockers },
      })
  }
  commit(...args)
}
