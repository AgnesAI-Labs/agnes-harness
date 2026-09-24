import type { RuntimePinDescriptor, RuntimePinReleaseResult } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { CommandError, UsageError } from '../errors.js'
import { newPackageCommandId } from '../tui/package-admin.js'
import type { ParsedArgs } from '../types.js'

export type PackagesPinsIO = {
  write(text: string): void
}

const USAGE = 'usage: agh packages pins inspect | agh packages pins release <pinId...>'
// Must match PackagePinsReleaseParams.pinIds maxItems in packages/protocol/schema/package-admin.json.
// An operator can pass more pinIds than one release call accepts, so this batches.
const PIN_RELEASE_BATCH_SIZE = 64

function formatInspectLine(pin: RuntimePinDescriptor): string {
  return `${pin.pinId}\t${pin.purpose}\t${pin.packageId}@${pin.version}`
}

function formatReleaseLine(result: RuntimePinReleaseResult): string {
  if (result.outcome === 'failed')
    return `${result.pinId}\t${result.outcome}\t${result.error?.safeMessage ?? 'unknown error'}`
  return `${result.pinId}\t${result.outcome}`
}

async function runInspect(client: NodeClient, profile: string, io: PackagesPinsIO): Promise<void> {
  const { orphans } = await client.packages.pins.inspect({ profile })
  if (orphans.length === 0) {
    io.write('No orphaned pins found.\n')
    return
  }
  io.write(`${orphans.map(formatInspectLine).join('\n')}\n`)
}

async function runRelease(
  client: NodeClient,
  profile: string,
  pinIds: string[],
  io: PackagesPinsIO,
): Promise<void> {
  // Explicit pinIds only: silently releasing "everything inspect just listed" would let a stale
  // inspect snapshot turn into a destructive action without the operator looking at it again.
  if (pinIds.length === 0) throw new UsageError('agh packages pins release requires at least one pinId')
  const clientId = await client.clientId()
  const results: RuntimePinReleaseResult[] = []
  // Batched: PackagePinsReleaseParams.pinIds caps at 64 (packages/protocol/schema/package-admin.json),
  // but an operator can legitimately pass more pinIds than that in one command invocation.
  for (let offset = 0; offset < pinIds.length; offset += PIN_RELEASE_BATCH_SIZE) {
    const chunk = pinIds.slice(offset, offset + PIN_RELEASE_BATCH_SIZE)
    const response = await client.packages.pins.release({
      profile,
      clientId,
      commandId: newPackageCommandId('pins-release'),
      pinIds: chunk,
    })
    results.push(...response.results)
    // Report each batch before starting the next. A release is irreversible, so a later batch
    // throwing -- a dropped daemon connection is the modelled case (bin.ts:44-48), and that handler
    // tells the operator to retry -- must not take down the receipt for the pins already destroyed.
    io.write(`${response.results.map(formatReleaseLine).join('\n')}\n`)
  }
  // Every pinId was reported above, so a partial failure stays visible to the caller; only the
  // process exit code still needs to reflect that something went wrong. CommandError (not a bare
  // Error) gets clean stack-free handling in bin.ts's catch-all.
  if (results.some((result) => result.outcome === 'failed'))
    throw new CommandError('one or more pin releases failed')
}

/** `agh packages pins inspect|release`. All packages-pins argument parsing lives here, not in bin.ts. */
export async function packagesPinsCommand(
  p: ParsedArgs,
  client: NodeClient,
  io: PackagesPinsIO,
): Promise<void> {
  const profile = p.profile ?? 'local-dev'
  const [group, action, ...rest] = p.positional
  if (group !== 'pins') throw new UsageError(USAGE)

  if (action === 'inspect') return runInspect(client, profile, io)
  if (action === 'release') return runRelease(client, profile, rest, io)
  throw new UsageError(USAGE)
}
