// DBH INV-002 verification, step 1 (unboundedness). Production entry: waitForPackageOperation
// (packages/cli-tui/src/package-admin.ts:44-60), re-exported at packages/cli/src/tui/package-admin.ts
// and awaited by every package admin command. Asserts the CORRECT behaviour, so a failure here
// reproduces the defect.
//
// Oracle, independent of package-admin.ts: the sibling operation-poller in this same repo,
// packages/resource-control-cli/src/resources.ts:224 `MAX_OPERATION_POLLS = 300`, :236 a bounded
// `for` loop, :253 `throw new ResourceOperationTimeout(receipt.operationId)`. Same problem, same
// wire shape (a durable operation record polled until it reaches a terminal state), one bounded and
// one not. package-admin.ts:45 uses `for (;;)` with no bound, no AbortSignal and no diagnostic
// output; bin.ts:550-562 returns before the signal ladder is installed at bin.ts:661, so this loop
// is not covered by the ladder either.
import type { PackageOperationReceipt } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForPackageOperation } from '../src/tui/package-admin.js'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

function stuckClient(state: string) {
  let polls = 0
  const client = {
    packages: {
      operation: {
        get: async () => {
          polls += 1
          return { operationId: 'op-1', profile: 'local-dev', operation: 'install', state, progress: 10 }
        },
      },
    },
  } as unknown as NodeClient
  return { client, polls: () => polls }
}

const receipt = { profile: 'local-dev', operationId: 'op-1', state: 'received' } as PackageOperationReceipt

describe('DBH INV-002: a package operation stuck in a non-terminal state must not poll forever', () => {
  it('[control] a terminal state settles immediately', async () => {
    const c = stuckClient('completed')
    await expect(waitForPackageOperation(c.client, receipt)).resolves.toMatchObject({ state: 'completed' })
    expect(c.polls()).toBe(1)
  })

  it('gives up after a bounded wait when the daemon keeps reporting `staging`', async () => {
    vi.useFakeTimers()
    const c = stuckClient('staging')
    let settled = false
    const pending = waitForPackageOperation(c.client, receipt).then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    void pending
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled, `polls=${c.polls()} after 60s of virtual time`).toBe(true)
  })
})
