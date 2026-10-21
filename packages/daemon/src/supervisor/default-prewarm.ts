import {
  type PackageAdminAuthorityResolver,
  type PackageAdminService,
  registerPackageAdmin,
} from '@agnes/daemon-admin/packages/index'
import type { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { DaemonNotice } from '@agnes/protocol'
import type { WorkerLink } from './worker-link.js'
import type { NoticeEmitter } from './worker-pool.js'

/** Profile-scoped hints schedule work without gating the successful publishing request. */
export function defaultPrewarmNotifier(
  pool: { prewarmSharedWorker(): Promise<Pick<WorkerLink, 'command'>> },
  profile: string,
  notices: NoticeEmitter,
) {
  const prewarm = () => {
    void Promise.resolve()
      .then(() => pool.prewarmSharedWorker())
      .then((link) => link.command('runtime.prewarm', {}))
      .catch(() => {
        console.warn('Default composition prewarm request failed')
      })
  }
  return {
    applicationChanged: prewarm,
    registerAdmin(
      endpoint: LocalEndpoint,
      service: PackageAdminService,
      authority: PackageAdminAuthorityResolver,
    ) {
      registerPackageAdmin(endpoint, service, authority, prewarm)
    },
    changed(event: Extract<DaemonNotice, { kind: 'packages_changed' }>['detail']) {
      notices.emit('packages_changed', { detail: event })
      if (event.profile === profile) prewarm()
    },
  }
}
