import { homeNavigation } from '@agnes/web-client'
import { tr } from '@agnes/web-foundation/locale-bridge'
import { Button, createExternalStore, Icon, useDocumentLanguage } from '@agnes/web-ui'
import { useSyncExternalStore } from 'react'
import type { ClientReconciler, RosterSource } from './client-modules/reconcile.js'
import { beginPreparationTiming } from './preparation-timing.js'

type Surface = 'conversation' | 'composer'
type Preparation = { conversation: boolean; composer: boolean; failed: boolean; retry?: () => void }
const initial = (): Preparation => ({ conversation: false, composer: false, failed: false })
const preparation = createExternalStore<Preparation>(initial())
let owner = 0

/** Host-owned, inert placeholders. Only an admitted presentation may mount the actual controls. */
export function beginClientUiPreparation() {
  const token = ++owner
  preparation.set(initial())
  const ends = {
    conversation: beginPreparationTiming('conversation_mount'),
    composer: beginPreparationTiming('composer_mount'),
  }
  const update = (patch: Partial<Preparation>) => {
    if (token === owner) preparation.set({ ...preparation.getSnapshot(), ...patch })
  }
  return {
    mounted(surface: Surface, value: boolean) {
      if (token !== owner) return
      update({ [surface]: value })
      if (value) ends[surface]()
    },
    track(reconciler: ClientReconciler, source: RosterSource | undefined): ClientReconciler {
      const read = async (work: () => Promise<void>) => {
        const finish = beginPreparationTiming('client_modules')
        update({ failed: false })
        try {
          await work()
          if (source && (source.available?.() ?? true)) {
            const state = preparation.getSnapshot()
            update({ failed: !state.conversation || !state.composer })
          }
          finish(preparation.getSnapshot().failed ? 'error' : 'ok')
        } catch (error) {
          finish('error')
          update({ failed: true })
          throw error
        }
      }
      update({
        retry: () => {
          void read(() => reconciler.invalidate()).catch(() => {})
        },
      })
      return {
        ...reconciler,
        reconcileNow: () => read(() => reconciler.reconcileNow()),
        invalidate: () => read(() => reconciler.invalidate()),
        reload: (id, revision) => read(() => reconciler.reload(id, revision)),
      }
    },
    dispose() {
      if (token === owner) {
        owner++
        preparation.set(initial())
      }
    },
  }
}

export function ClientUiPreparation() {
  useDocumentLanguage()
  const state = useSyncExternalStore(preparation.subscribe, preparation.getSnapshot)
  const home = useSyncExternalStore(homeNavigation.subscribe, homeNavigation.getSnapshot)
  if ((state.conversation && state.composer) || home) return null
  return (
    <section
      className="client-ui-preparation"
      data-client-ui-preparation="conversation"
      aria-busy={!state.failed}
    >
      <span className="client-ui-preparation-indicator" aria-hidden="true">
        <Icon name={state.failed ? 'refresh-cw' : 'loader-circle'} size={20} />
      </span>
      <div className="client-ui-preparation-copy" role={state.failed ? 'alert' : 'status'}>
        <h2 className="client-ui-preparation-title">
          {tr(state.failed ? 'app.uiPreparation.failed' : 'app.uiPreparation.loading')}
        </h2>
        <p className="client-ui-preparation-hint">
          {tr(state.failed ? 'app.uiPreparation.failedHint' : 'app.uiPreparation.hint')}
        </p>
      </div>
      {state.failed && state.retry && (
        <Button appearance="secondary" onClick={state.retry}>
          {tr('app.uiPreparation.retry')}
        </Button>
      )}
    </section>
  )
}
