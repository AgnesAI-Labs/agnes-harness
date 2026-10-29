import { randomUUID } from 'node:crypto'
import type { PersistenceMetadataNamespace } from '@agnes/extension-api'
import { rpcError } from '@agnes/protocol'

type Activation = { integrity: string; revision: string; activationId: string; active: boolean }
/** Durable epochs: disabling and enabling the same code never revives an old grant. */
export class ProfileActivations {
  constructor(private readonly store: PersistenceMetadataNamespace) {}
  publish(rows: readonly { owner: string; revision: string; integrity?: string }[]): void {
    this.store.transaction(() => {
      const next = new Map(rows.map((row) => [row.owner, row]))
      for (const { key, value } of this.store.entries()) {
        const old = value as Activation
        if (old.active && next.get(key)?.revision !== old.revision)
          this.store.set(key, { ...old, activationId: randomUUID(), active: false })
      }
      for (const [owner, row] of next) {
        const old = this.store.get(owner) as Activation | undefined
        if (!old?.active || old.revision !== row.revision)
          this.store.set(owner, {
            revision: row.revision,
            integrity: row.integrity ?? row.revision,
            activationId: randomUUID(),
            active: true,
          })
      }
    })
  }
  require(owner: string, integrity: string, expected?: string, revision?: string): string {
    const row = this.store.get(owner) as Activation | undefined
    if (
      !row?.active ||
      row.integrity !== integrity ||
      (revision !== undefined && row.revision !== revision) ||
      (expected !== undefined && expected !== row.activationId)
    )
      throw rpcError('CAPABILITY_DENIED')
    return row.activationId
  }
}
