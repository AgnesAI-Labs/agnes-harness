import type { NodeClient } from '@agnes/sdk'
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { packagesPinsCommand } from '../src/commands/packages-pins.js'

// DBH INV-005 verification. `runRelease` (packages/cli/src/commands/packages-pins.ts:46-57) batches
// destructive pin releases 64 at a time but only calls `io.write` after the loop (:58). When a later
// batch fails, every pin released by the earlier batches is already gone on the daemon while the
// operator is told nothing about them.
// Oracle (independent of this command): a destructive operation that already succeeded must be
// reported. The release results are the only record the operator gets -- the daemon has already
// dropped those pins, and `agnes packages pins inspect` no longer lists them (they are not orphans
// any more). Losing the list means an irreversible action with no receipt.
const RELEASED = Array.from({ length: 64 }, (_, i) => `pin-${i}`)
const REMAINING = Array.from({ length: 6 }, (_, i) => `pin-${64 + i}`)

function fakeClient(calls: string[][]): NodeClient {
  return {
    async clientId() {
      return 'cli-client'
    },
    packages: {
      pins: {
        release: async (params: { pinIds: string[] }) => {
          calls.push(params.pinIds)
          if (calls.length === 1)
            return { results: params.pinIds.map((pinId) => ({ pinId, outcome: 'released' })) }
          // Shape of the daemon-connection loss bin.ts:44-48 already knows about:
          // 'DAEMON_CONNECTION_CLOSED: local Daemon connection closed; retry the command.'
          throw Object.assign(new Error('local Daemon connection closed'), { kind: 'transport-closed' })
        },
      },
    },
  } as unknown as NodeClient
}

describe('DBH INV-005: a mid-batch release failure must still report the pins already released', () => {
  it('reports the 64 pins the first batch destroyed before the second batch fails', async () => {
    const calls: string[][] = []
    const written: string[] = []
    await expect(
      packagesPinsCommand(
        parseArgs(['packages', 'pins', 'release', ...RELEASED, ...REMAINING]),
        fakeClient(calls),
        { write: (text) => written.push(text) },
      ),
    ).rejects.toThrow()

    // Precondition: the first batch really did release all 64 pins.
    expect(calls[0]).toEqual(RELEASED)
    expect(calls).toHaveLength(2)

    const output = written.join('')
    const missing = RELEASED.filter((pinId) => !output.includes(pinId))
    expect(missing).toEqual([])
  })
})
