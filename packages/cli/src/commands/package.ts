import type { PackageInstalledDescriptor, PackageOperation, PackagePreview } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { UsageError } from '../errors.js'
import {
  formatPreview,
  inspectPackage,
  installPreview,
  newPackageCommandId,
  parsePackageSource,
  waitForPackageOperation,
} from '../tui/package-admin.js'
import type { ParsedArgs } from '../types.js'

export {
  formatPreview,
  inspectPackage,
  installPreview,
  newPackageCommandId,
  parsePackageSource,
  waitForPackageOperation,
} from '../tui/package-admin.js'

export type PackageCommandIO = {
  write(text: string): void
  confirm(
    preview: Pick<PackagePreview, 'id' | 'version' | 'integrity'>,
    action?: 'install' | 'trust' | 'enable',
  ): Promise<boolean>
  confirmEnable?(installed: PackageInstalledDescriptor, action?: 'trust' | 'enable'): Promise<boolean>
}

async function confirmPreview(
  p: ParsedArgs,
  io: PackageCommandIO,
  preview: Pick<PackagePreview, 'id' | 'version' | 'integrity'>,
  action: 'install' | 'trust' | 'enable' = 'install',
): Promise<boolean> {
  return p.yes === true || io.confirm(preview, action)
}

async function confirmInstalled(
  p: ParsedArgs,
  io: PackageCommandIO,
  installed: PackageInstalledDescriptor,
  action: 'trust' | 'enable',
): Promise<boolean> {
  if (p.yes) return true
  return io.confirmEnable ? io.confirmEnable(installed, action) : io.confirm(installed, action)
}

function formatOperation(operation: PackageOperation): string {
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

function requireArg(args: readonly string[], index: number, usage: string): string {
  const value = args[index]
  if (!value) throw new UsageError(`usage: ${usage}`)
  return value
}

async function directOperation(
  client: NodeClient,
  profile: string,
  kind: 'enable' | 'disable' | 'rollback' | 'remove',
  id: string,
  expectedInstalledIntegrity?: string,
): Promise<PackageOperation> {
  const base = { profile, clientId: await client.clientId(), commandId: newPackageCommandId(kind), id }
  const receipt =
    kind === 'enable' && expectedInstalledIntegrity
      ? await client.packages.enable({ ...base, expectedInstalledIntegrity })
      : await client.packages[kind](base)
  return waitForPackageOperation(client, receipt)
}

export async function runPackageCommand(
  p: ParsedArgs,
  client: NodeClient,
  io: PackageCommandIO,
): Promise<void> {
  const profile = p.profile ?? 'local-dev'
  const args = p.command === 'install' ? ['add', ...p.positional] : p.positional
  const action = args[0] ?? 'status'
  switch (action) {
    case 'status':
    case 'list': {
      const result = await client.packages.list({ profile })
      io.write(
        result.packages.length === 0
          ? 'No packages installed.'
          : result.packages
              .map(
                (entry) =>
                  `${entry.id}@${entry.version} desired=${entry.desired} actual=${entry.actual} trusted=${entry.trusted}`,
              )
              .join('\n'),
      )
      return
    }
    case 'catalog': {
      const page = await client.packages.catalog.list({
        profile,
        ...(args[1] ? { query: args[1] } : {}),
      })
      io.write(
        page.items.length === 0
          ? 'No catalog packages found.'
          : page.items.map((item) => `${item.id}@${item.version}`).join('\n'),
      )
      return
    }
    case 'inspect': {
      const preview = await inspectPackage(
        client,
        profile,
        parsePackageSource(requireArg(args, 1, 'agh package inspect <source>')),
      )
      io.write(formatPreview(preview))
      return
    }
    case 'add': {
      const preview = await inspectPackage(
        client,
        profile,
        parsePackageSource(requireArg(args, 1, 'agh install <source>')),
      )
      io.write(`${formatPreview(preview, { activate: p.command === 'plugins' })}\n`)
      if (preview.blockers.length > 0)
        throw new UsageError('package preview has blockers; resolve the blockers above and inspect again')
      if (!(await confirmPreview(p, io, preview))) {
        io.write('Installation cancelled.\n')
        return
      }
      io.write(`${formatOperation(await installPreview(client, profile, preview))}\n`)
      if (p.command === 'plugins') {
        if (!preview.capabilityHash)
          throw new Error('Preview has no capability hash; update the daemon and inspect again.')
        const trust = await client.packages.trust({
          profile,
          clientId: await client.clientId(),
          commandId: newPackageCommandId('trust'),
          id: preview.id,
          expectedIntegrity: preview.integrity,
          capabilityHash: preview.capabilityHash,
        })
        await waitForPackageOperation(client, trust)
        io.write(
          `${formatOperation(await directOperation(client, profile, 'enable', preview.id, preview.integrity))}\n`,
        )
      }
      return
    }
    case 'trust': {
      const id = requireArg(args, 1, 'agh package trust <id> [<integrity> <capabilityHash>] [--yes]')
      if (args.length !== 2 && args.length !== 4)
        throw new UsageError('usage: agh package trust <id> [<integrity> <capabilityHash>] [--yes]')
      const installed = (await client.packages.list({ profile })).packages.find((entry) => entry.id === id)
      if (!installed) throw new UsageError(`package ${id} is not installed; run agh package status`)
      io.write(
        `${installed.id}@${installed.version}\nintegrity ${installed.integrity}\ncapabilityHash ${installed.capabilityHash ?? 'unavailable'}\nRequested capabilities: ${JSON.stringify(installed.declaredCapabilities ?? 'not declared')}\nblockers ${installed.blockers.map((blocker) => `${blocker.code}: ${blocker.references.join(', ')}`).join('; ') || 'none'}\n`,
      )
      const expectedIntegrity = args[2] ?? installed.integrity
      const capabilityHash = args[3] ?? installed.capabilityHash
      if (expectedIntegrity !== installed.integrity || capabilityHash !== installed.capabilityHash)
        throw new UsageError(
          `hash mismatch: expected integrity=${installed.integrity} capabilityHash=${installed.capabilityHash}; given integrity=${expectedIntegrity} capabilityHash=${capabilityHash}; review the installed package before trusting`,
        )
      if (!capabilityHash)
        throw new UsageError('installed package has no capabilityHash; rebuild or upgrade the daemon')
      if (installed.blockers.length)
        throw new UsageError('package has blockers; resolve them before trusting')
      if (!(await confirmInstalled(p, io, installed, 'trust'))) {
        io.write('Trust cancelled.\n')
        return
      }
      const receipt = await client.packages.trust({
        profile,
        clientId: await client.clientId(),
        commandId: newPackageCommandId('trust'),
        id,
        expectedIntegrity,
        capabilityHash,
      })
      io.write(`${formatOperation(await waitForPackageOperation(client, receipt))}\n`)
      return
    }
    case 'enable':
    case 'disable':
    case 'rollback':
    case 'remove': {
      const id = requireArg(args, 1, `agh package ${action} <id>`)
      let reviewedIntegrity: string | undefined
      if (action === 'enable') {
        const installed = (await client.packages.list({ profile })).packages.find((entry) => entry.id === id)
        if (!installed) throw new UsageError(`package ${id} is not installed; run agh package status`)
        if (!installed.capabilityHash)
          throw new UsageError('Installed summary has no capability hash; update the daemon.')
        reviewedIntegrity = installed.integrity
        io.write(
          `Enable ${installed.id}@${installed.version} integrity=${installed.integrity} capabilityHash=${installed.capabilityHash}\nRequested capabilities: ${JSON.stringify(installed.declaredCapabilities ?? 'not declared')}\n`,
        )
        if (!(await confirmInstalled(p, io, installed, 'enable'))) {
          io.write('Enable cancelled.\n')
          return
        }
      }
      io.write(`${formatOperation(await directOperation(client, profile, action, id, reviewedIntegrity))}\n`)
      return
    }
    case 'operation': {
      const id = requireArg(args, 1, 'agh package operation <operationId>')
      io.write(`${formatOperation(await client.packages.operation.get({ profile, operationId: id }))}\n`)
      return
    }
    case 'cancel': {
      const operationId = requireArg(args, 1, 'agh package cancel <operationId>')
      const receipt = await client.packages.operation.cancel({
        profile,
        operationId,
        clientId: await client.clientId(),
        commandId: newPackageCommandId('cancel'),
      })
      io.write(`cancel accepted ${receipt.operationId}\n`)
      return
    }
    default:
      throw new UsageError(`unknown package action ${action}`)
  }
}
