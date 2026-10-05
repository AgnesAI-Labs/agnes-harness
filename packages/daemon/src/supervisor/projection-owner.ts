import { createHostProjectionOwner, type HostProjectionOwner, type HostProjectionSources } from '@agnes/host'
import { type DomainStore, type DomainStoreOptions, openDomainStore } from '../runtime/events/outbox.js'
import { nativeConversation } from '../runtime/native-conversation.js'

/** Selected domain facts come from the trusted installer, never from transport authentication. */
export type SupervisorProjectionInstallation = Readonly<{
  store: DomainStoreOptions
  /** Installs commands and reads using these same sources. Omission keeps reads fail closed. */
  createOwner?(sources: HostProjectionSources<DomainStore>): HostProjectionOwner
}>

/** One supervisor store owns both command commits and the Host projection's journal/notifications. */
export function openSupervisorProjectionOwner(
  installation: SupervisorProjectionInstallation,
  context: Parameters<typeof nativeConversation>[0],
): HostProjectionOwner {
  const store = openDomainStore(installation.store)
  let owner: HostProjectionOwner
  try {
    owner = (installation.createOwner ?? createHostProjectionOwner)({
      commandStorage: store,
      journal: async (afterSequence, limit) => store.events(afterSequence, limit),
      subscribeCommitted: store.subscribeCommitted,
      native: nativeConversation(context),
    })
  } catch (error) {
    store.close()
    throw error
  }
  let closing: Promise<void> | undefined
  return {
    installation: owner.installation,
    committed: () => owner.committed(),
    close() {
      closing ??= (async () => {
        try {
          await owner.close()
        } finally {
          store.close()
        }
      })()
      return closing
    },
  }
}
