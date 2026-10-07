import { definePersistenceProvider, PERSISTENCE_EFFECT, type PersistenceProvider } from '@agnes/extension-api'
import { openJsonlStore } from './jsonl.js'

export { openJsonlStore } from './jsonl.js'

/** File-backed provider. Selecting it, or leaving it, takes effect on the next process start. */
export const persistenceProvider: PersistenceProvider = definePersistenceProvider({
  id: 'jsonl',
  version: '1',
  state: { effect: PERSISTENCE_EFFECT },
  open: openJsonlStore,
})
