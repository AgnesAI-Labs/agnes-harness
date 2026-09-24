import { randomUUID } from 'node:crypto'
import type {
  PackageOperation,
  PackageOperationReceipt,
  PackagePreview,
  PackageSource,
} from '@agnes/protocol'
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

export function parsePackageSource(value: string): PackageSource {
  if (value.startsWith('npm:')) return { type: 'npm', ref: value }
  if (value.startsWith('file:')) return { type: 'file', ref: value }
  if (value.startsWith('workspace:')) return { type: 'workspace', ref: value }
  if (value.startsWith('git:')) return { type: 'git', ref: value }
  throw new TuiUsageError('package source must begin with npm:, file:, workspace:, or git:')
}

function terminalError(operation: PackageOperation): Error {
  const detail = operation.error?.safeMessage ?? operation.state
  return new Error(`package ${operation.operation} ${detail}`)
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

export function formatPreview(preview: PackagePreview): string {
  const contributions = preview.contributions.map((contribution) => contribution.kind).join(', ') || 'none'
  const warnings = preview.warnings.map((warning) => warning.safeMessage).join('; ') || 'none'
  return [
    `Preview ${preview.id}@${preview.version}`,
    `integrity ${preview.integrity}`,
    `contributions ${contributions}`,
    `warnings ${warnings}`,
    'Installation will remain disabled and untrusted.',
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
