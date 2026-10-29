import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'
import type {
  PackageInstalledDescriptor,
  PackageOperation,
  PackageOperationReceipt,
  PackagePreview,
  PackageSource,
} from '@agnes/protocol'
import { pluginFailureHelp } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'

class TuiUsageError extends Error {
  override readonly name = 'UsageError'
}

const TERMINAL_STATES = new Set<PackageOperation['state']>([
  'completed',
  'failed',
  'cancelled',
  'rolled-back',
])
const POLL_INTERVAL_MS = 200
// Bounded like the sibling poller over the same receipt-then-poll wire shape
// (resource-control-cli/src/resources.ts:224): the same 30s ceiling, at this path's interval.
const MAX_OPERATION_POLLS = 150

export function newPackageCommandId(kind: string): string {
  return `${kind}-${randomUUID().replaceAll('-', '')}`
}

/** `base` resolves relative local paths; the TUI passes its session workspace, the CLI keeps process.cwd(). */
export function parsePackageSource(value: string, base: string = process.cwd()): PackageSource {
  if (value.startsWith('npm:')) return { type: 'npm', ref: value }
  if (value.startsWith('file:')) return { type: 'file', ref: value.split(sep).join('/') }
  if (value.startsWith('workspace:')) return { type: 'workspace', ref: value }
  if (value.startsWith('git:')) return { type: 'git', ref: value }
  if (value.startsWith('https://'))
    return {
      type: /\.(?:zip|tgz|tar(?:\.gz)?)(?:$)/i.test(value) ? 'url' : 'git',
      ref: (/\.(?:zip|tgz|tar(?:\.gz)?)(?:$)/i.test(value) ? 'url:' : 'git:') + value,
    }
  if (value.startsWith('url:')) return { type: 'url', ref: value }
  if (value.startsWith('path:')) return { type: 'path', ref: value.split(sep).join('/') }
  if (
    isAbsolute(value) ||
    value.startsWith(`.${sep}`) ||
    value.startsWith(`..${sep}`) ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    /\.(zip|tgz|tar|tar\.gz)$/i.test(value)
  )
    return { type: 'file', ref: `file:${resolve(base, value).split(sep).join('/')}` }
  throw new TuiUsageError('Use a git HTTPS URL, folder/archive path, or npm:package@version')
}

function terminalError(operation: PackageOperation): Error {
  const detail = operation.error?.safeMessage ?? operation.state
  const help = operation.error?.fixHint ? operation.error : pluginFailureHelp(operation.error?.code ?? detail)
  return new Error(`package ${operation.operation} ${detail} ${help.fixHint} ${help.docsUrl}`)
}

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
}

/** Polls the durable operation record so local and remote commands observe the same final state. */
export async function waitForPackageOperation(
  client: NodeClient,
  receipt: PackageOperationReceipt,
): Promise<PackageOperation> {
  for (let poll = 0; poll < MAX_OPERATION_POLLS; poll++) {
    const operation = await client.packages.operation.get({
      profile: receipt.profile,
      operationId: receipt.operationId,
    })
    if (!TERMINAL_STATES.has(operation.state)) {
      await pause()
      continue
    }
    if (operation.state !== 'completed' && operation.state !== 'rolled-back') throw terminalError(operation)
    return operation
  }
  // The record is durable, so giving up here abandons the wait, not the operation: it keeps running
  // and can still be inspected or cancelled by id. Waiting forever instead would hold the command,
  // its daemon connection and (in the TUI) the poll timer open with nothing on screen to say why.
  throw new Error(`package operation ${receipt.operationId} is still running; check or cancel it by id`)
}

export async function inspectPackage(
  client: NodeClient,
  profile: string,
  source: PackageSource,
): Promise<PackagePreview> {
  const receipt = await client.packages.inspect({
    profile,
    clientId: await client.clientId(),
    commandId: newPackageCommandId('inspect'),
    source,
  })
  const operation = await waitForPackageOperation(client, receipt)
  if (!operation.preview) throw new Error('package inspection completed without a preview')
  return operation.preview
}

export async function installPreview(
  client: NodeClient,
  profile: string,
  preview: PackagePreview,
): Promise<PackageOperation> {
  const receipt = await client.packages.install({
    profile,
    clientId: await client.clientId(),
    commandId: newPackageCommandId('install'),
    source: preview.source,
    expectedIntegrity: preview.integrity,
  })
  const operation = await waitForPackageOperation(client, receipt)
  if (
    operation.installed &&
    (operation.installed.trusted || operation.installed.desired !== 'installed-disabled')
  )
    throw new Error('package installation violated the disabled/untrusted default')
  return operation
}

/**
 * Brings the reviewed `preview` live over the installed `previous`: one atomic update with activation
 * when the bytes differ, otherwise only the missing trust/enable steps. `reenable` also retries enable
 * for a package that is desired-enabled but not running. Returns the last operation, if any ran.
 */
export async function activateReviewedPackage(
  client: NodeClient,
  profile: string,
  preview: PackagePreview,
  previous: PackageInstalledDescriptor,
  options: { reenable?: boolean } = {},
): Promise<PackageOperation | undefined> {
  if (!preview.capabilityHash)
    throw new Error('Preview has no capability hash; update the daemon and inspect again.')
  const base = { profile, clientId: await client.clientId(), id: preview.id }
  if (previous.integrity !== preview.integrity)
    return waitForPackageOperation(
      client,
      await client.packages.update({
        ...base,
        commandId: newPackageCommandId('update'),
        source: preview.source,
        expectedIntegrity: preview.integrity,
        activation: {
          expectedInstalledIntegrity: previous.integrity,
          expectedActiveIntegrity:
            previous.actual === 'running' ? (previous.actualIntegrity ?? previous.integrity) : null,
          trust: { integrity: preview.integrity, capabilityHash: preview.capabilityHash },
        },
      }),
    )
  let last: PackageOperation | undefined
  if (!previous.trusted)
    last = await waitForPackageOperation(
      client,
      await client.packages.trust({
        ...base,
        commandId: newPackageCommandId('trust'),
        expectedIntegrity: preview.integrity,
        capabilityHash: preview.capabilityHash,
      }),
    )
  if (previous.desired !== 'enabled' || (options.reenable && previous.actual !== 'running'))
    last = await waitForPackageOperation(
      client,
      await client.packages.enable({
        ...base,
        commandId: newPackageCommandId('enable'),
        expectedInstalledIntegrity: preview.integrity,
      }),
    )
  return last
}

// ponytail: numeric major.minor.patch only; a prerelease tag is ignored, so 1.0.0-rc.1 vs 1.0.0 reads as equal.
function isDowngrade(from: string, to: string): boolean {
  const core = (version: string) => version.split(/[-+]/)[0]?.split('.').map(Number) ?? []
  const [a, b] = [core(from), core(to)]
  for (let i = 0; i < 3; i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0]
    if (x !== y) return y < x
  }
  return false
}

function diffLine(diff: PackagePreview['capabilityDiff']): string {
  const parts = [
    diff.added.length ? `capabilities added: ${diff.added.join(', ')}` : '',
    diff.removed.length ? `capabilities removed: ${diff.removed.join(', ')}` : '',
  ].filter(Boolean)
  return parts.join('; ') || 'capabilities unchanged'
}

export function formatPreview(
  preview: PackagePreview,
  options: { activate?: boolean; installedVersion?: string; repair?: boolean } = {},
): string {
  const contributions =
    [...new Set([...(preview.provides ?? []), ...preview.contributions.map((item) => item.kind)])].join(
      ', ',
    ) || 'none'
  const warnings = preview.warnings.map((warning) => warning.safeMessage).join('; ') || 'none'
  return [
    `Preview ${preview.id}@${preview.version}`,
    `integrity ${preview.integrity}`,
    ...(preview.preflight ? [`preflight ${preview.preflight.level}: ${preview.preflight.next}`] : []),
    `capabilityHash ${preview.capabilityHash}`,
    `declared capabilities ${preview.declaredCapabilities === undefined ? 'not declared' : JSON.stringify(preview.declaredCapabilities)}`,
    `blockers ${preview.blockers.map((b) => b.references.join(', ')).join('; ') || 'none'}`,
    `contributions ${contributions}`,
    `warnings ${warnings}`,
    ...(options.installedVersion === undefined
      ? []
      : [
          `update ${preview.id} ${options.installedVersion} → ${preview.version}${isDowngrade(options.installedVersion, preview.version) ? ' (downgrade)' : ''}`,
          diffLine(preview.capabilityDiff),
        ]),
    options.activate
      ? `Confirmation will ${options.repair ? '' : `${options.installedVersion === undefined ? 'install' : 'update'}, `}trust and enable this reviewed version.`
      : 'Installation will remain disabled and untrusted.',
  ].join('\n')
}

/** A terminal operation is the only durable outcome a TUI may report after reconnecting. */
export function formatPackageOperation(operation: PackageOperation): string {
  const installed = operation.installed
  return [
    `${operation.operation} ${operation.state} (${operation.progress}%)`,
    ...(installed
      ? [
          `${installed.id}@${installed.version}`,
          `desired ${installed.desired}; actual ${installed.actual}; trusted ${String(installed.trusted)}`,
        ]
      : []),
  ].join('\n')
}
