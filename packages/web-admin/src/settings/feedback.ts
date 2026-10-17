import { tr } from '@agnes/web-foundation/locale-bridge'
import { reportSuccess } from '@agnes/web-ui'

/** Account controller owns the confirmed write and its authoritative effect. */
export function reportAccountSaved(effect: string | undefined): void {
  reportSuccess(
    'model-accounts',
    tr('accounts.saved'),
    effect === 'restart-required'
      ? { kind: 'restart-required', message: tr('settings.saved.restartRequired') }
      : { kind: 'new-sessions', message: tr('settings.saved.newSessionsOnly') },
  )
}
