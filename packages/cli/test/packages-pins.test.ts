import type { NodeClient } from '@agnes/sdk'
import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/args.js'
import { packagesPinsCommand } from '../src/commands/packages-pins.js'
import { CommandError } from '../src/errors.js'

const profile = 'local-dev'

function fakeClient(overrides: {
  inspect?: () => Promise<{ orphans: unknown[] }>
  release?: (pinIds: string[]) => Promise<{ results: unknown[] }>
}): NodeClient {
  return {
    async clientId() {
      return 'cli-client'
    },
    packages: {
      pins: {
        inspect: overrides.inspect ?? (async () => ({ orphans: [] })),
        release: overrides.release
          ? (params: { pinIds: string[] }) => overrides.release?.(params.pinIds)
          : async () => ({ results: [] }),
      },
    },
  } as unknown as NodeClient
}

describe('packagesPinsCommand', () => {
  it('inspect prints an explicit "no orphans" message when the list is empty', async () => {
    const written: string[] = []
    await packagesPinsCommand(
      parseArgs(['packages', 'pins', 'inspect']),
      fakeClient({ inspect: async () => ({ orphans: [] }) }),
      { write: (text) => written.push(text) },
    )
    expect(written.join('\n')).toMatch(/no orphan/i)
  })

  it('inspect prints pinId/purpose/packageId/version for each orphan', async () => {
    const written: string[] = []
    await packagesPinsCommand(
      parseArgs(['packages', '--profile', profile, 'pins', 'inspect']),
      fakeClient({
        inspect: async () => ({
          orphans: [
            {
              pinId: 'pin-1',
              purpose: 'candidate',
              packageId: 'example',
              version: '1.0.0',
              snapshotId: 'snap-1',
              operationId: 'op-1',
            },
          ],
        }),
      }),
      { write: (text) => written.push(text) },
    )
    const output = written.join('')
    expect(output).toContain('pin-1')
    expect(output).toContain('candidate')
    expect(output).toContain('example@1.0.0')
  })

  it('release requires at least one explicit pinId', async () => {
    await expect(
      packagesPinsCommand(parseArgs(['packages', 'pins', 'release']), fakeClient({}), {
        write: () => undefined,
      }),
    ).rejects.toThrow(/pinId/)
  })

  it('release passes through the given pinIds and reports each outcome', async () => {
    const written: string[] = []
    const release = (pinIds: string[]) =>
      Promise.resolve({
        results: pinIds.map((pinId) => ({ pinId, outcome: 'released' as const })),
      })
    let calledWith: string[] | undefined
    await packagesPinsCommand(
      parseArgs(['packages', 'pins', 'release', 'pin-1', 'pin-2']),
      fakeClient({
        release: (pinIds) => {
          calledWith = pinIds
          return release(pinIds)
        },
      }),
      { write: (text) => written.push(text) },
    )
    expect(calledWith).toEqual(['pin-1', 'pin-2'])
    expect(written.join('')).toContain('pin-1\treleased')
    expect(written.join('')).toContain('pin-2\treleased')
  })

  it('release throws when any outcome is failed, after reporting every outcome', async () => {
    const written: string[] = []
    await expect(
      packagesPinsCommand(
        parseArgs(['packages', 'pins', 'release', 'pin-1', 'pin-2']),
        fakeClient({
          release: async (pinIds) => ({
            results: [
              { pinId: pinIds[0], outcome: 'released' as const },
              {
                pinId: pinIds[1],
                outcome: 'failed' as const,
                error: { code: 'E_PACKAGE_STATE', safeMessage: 'pin already released', blockers: [] },
              },
            ],
          }),
        }),
        { write: (text) => written.push(text) },
      ),
    ).rejects.toThrow()
    const output = written.join('')
    expect(output).toContain('pin-1\treleased')
    expect(output).toContain('pin-2\tfailed\tpin already released')
  })

  // PackagePinsReleaseParams.pinIds caps at 64 (packages/protocol/schema/package-admin.json), so a
  // release with more pinIds than that has to be split into multiple client.packages.pins.release
  // calls and the per-call results merged.
  it('release batches more than 64 pinIds into multiple release calls and merges the results', async () => {
    const pinIds = Array.from({ length: 65 }, (_, index) => `pin-${index}`)
    const calls: string[][] = []
    const written: string[] = []
    await packagesPinsCommand(
      parseArgs(['packages', 'pins', 'release', ...pinIds]),
      fakeClient({
        release: async (chunk) => {
          calls.push(chunk)
          return { results: chunk.map((pinId) => ({ pinId, outcome: 'released' as const })) }
        },
      }),
      { write: (text) => written.push(text) },
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]).toHaveLength(64)
    expect(calls[1]).toHaveLength(1)
    const output = written.join('')
    for (const pinId of pinIds) expect(output).toContain(`${pinId}\treleased`)
  })

  // The "one or more pin releases failed" summary is an already-reported outcome (each pin's line
  // was printed above); it must not surface as a raw stack trace to the operator.
  it('release throws a CommandError (not a bare Error) so the CLI prints a clean summary', async () => {
    await expect(
      packagesPinsCommand(
        parseArgs(['packages', 'pins', 'release', 'pin-1']),
        fakeClient({
          release: async (pinIds) => ({
            results: [
              {
                pinId: pinIds[0],
                outcome: 'failed' as const,
                error: { code: 'E_PACKAGE_STATE', safeMessage: 'pin already released', blockers: [] },
              },
            ],
          }),
        }),
        { write: () => undefined },
      ),
    ).rejects.toBeInstanceOf(CommandError)
  })
})
