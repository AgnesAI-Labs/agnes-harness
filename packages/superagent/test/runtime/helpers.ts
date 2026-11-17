// Shared fixtures of the runtime tests: a store in a temporary directory and tickets.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../../src/app/store.js'
import type { Assignment, Ticket } from '../../src/core/index.js'

export function tempStore(): { store: Store; dir: string; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'superagent-runtime-'))
  const store = openStore(join(dir, 'superagent.sqlite'))
  return {
    store,
    dir,
    close: () => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function ticket(
  id: string,
  fields: Partial<Ticket> & { state?: 'open' | 'ended'; assignment?: Partial<Assignment> } = {},
): Ticket {
  const { state = 'open', assignment = { state: 'running' }, ...rest } = fields
  return {
    id,
    title: `Ticket ${id}`,
    decisionId: '',
    mandate: {
      strength: 'explicit',
      policyVersion: '',
      basis: { via: 'listed' },
      actor: { source: 'github', id: 'alice' },
      scope: '',
    },
    channels: [],
    assignments: [{ id: `${id}-a1`, createdAt: '', state: 'running', ...assignment }],
    inputs: [],
    ...(state === 'ended'
      ? { ended: { at: '', by: 'executor' as const, reason: 'closed', outcome: 'closed' as const } }
      : {}),
    undelivered: [],
    createdAt: '',
    updatedAt: '',
    origin: { triggerId: '', triggerIds: [] },
    ...rest,
  }
}
