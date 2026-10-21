import { join } from 'node:path'
import type { CompositeTargetStore } from '@agnes/daemon-foundation/storage/composite-target-store'
import { type ByteFailure, PackageByteVerification, revokePackageByteFailure } from '@agnes/package-manager'
import type { NoticeEmitter, WorkerPool } from './worker-pool.js'

/** Failure notifications never wait on a reader/publication ticket or on worker convergence. */
export class DaemonPluginByteVerification {
  readonly verification: PackageByteVerification
  #stop = () => {}
  #revoke = (_id: string) => {}
  #notice = () => {}
  #faults = Promise.resolve()
  constructor(
    readonly profileDir: string,
    readonly dataDir: string,
    profile: string,
  ) {
    this.verification = new PackageByteVerification({
      profileDir,
      roots: [profileDir, join(dataDir, 'profiles', profile, 'packages')],
      onMismatch: (failure) => this.fail(failure),
    })
  }
  bind(stop: () => void, revoke: (id: string) => void, notice: () => void): void {
    this.#stop = stop
    this.#revoke = revoke
    this.#notice = notice
  }
  bindRuntime(
    pool: Pick<WorkerPool, 'stopPluginExecution'>,
    store: CompositeTargetStore | undefined,
    notices: NoticeEmitter,
    profile: string,
  ): void {
    this.bind(
      () => pool.stopPluginExecution(),
      (id) => store?.revokePackage(id),
      () =>
        notices.emit('packages_changed', {
          detail: {
            profile,
            revision: store?.desired()?.digest ?? `sha256-${'0'.repeat(64)}`,
            reason: 'trust',
          },
        }),
    )
  }
  fail(failure: ByteFailure): void {
    this.verification.invalidate()
    this.#stop()
    this.#faults = this.#faults
      .then(async () => {
        const ids = await revokePackageByteFailure(this.profileDir, this.dataDir, failure)
        for (const id of ids) this.#revoke(id)
        this.#notice()
      })
      .catch(() => {
        this.#stop()
        console.error('Plugin integrity revocation could not be persisted; execution is unavailable')
      })
  }
  async close(): Promise<void> {
    await this.verification.close()
    await this.#faults
  }
}
