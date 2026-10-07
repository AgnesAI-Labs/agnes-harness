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
  confirm(preview: PackagePreview): Promise<boolean>
  confirmEnable?(installed: PackageInstalledDescriptor): Promise<boolean>
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
      io.write(
        `${formatPreview(preview)}\n${p.command === 'plugins' ? 'Confirmation will install, trust and enable this reviewed version.\n' : ''}`,
      )
      if (preview.blockers.length > 0) throw new Error('package preview has blockers')
      if (!(await io.confirm(preview))) {
        io.write(
          'Installation cancelled. Use an interactive terminal or --yes to confirm the displayed preview.\n',
        )
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
      if (p.command === 'plugins' && args.length === 2) {
        const row = (await client.packages.list({ profile })).packages.find((item) => item.id === args[1])
        if (!row) throw new Error('Plugin is not installed.')
        if (!row.capabilityHash)
          throw new Error('Installed summary has no capability hash; update the daemon.')
        io.write(`Requested capabilities: ${JSON.stringify(row.declaredCapabilities ?? 'not declared')}\n`)
        if (!(p.yes || (await io.confirmEnable?.(row)))) {
          io.write('Trust cancelled. Use an interactive terminal or --yes.\n')
          return
        }
        const receipt = await client.packages.trust({
          profile,
          clientId: await client.clientId(),
          commandId: newPackageCommandId('trust'),
          id: row.id,
          expectedIntegrity: row.integrity,
          capabilityHash: row.capabilityHash,
        })
        io.write(formatOperation(await waitForPackageOperation(client, receipt)) + '\n')
        return
      }
      const id = requireArg(args, 1, 'agh package trust <id> <integrity> <capabilityHash>')
      const expectedIntegrity = requireArg(args, 2, 'agh package trust <id> <integrity> <capabilityHash>')
      const capabilityHash = requireArg(args, 3, 'agh package trust <id> <integrity> <capabilityHash>')
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
        const row = (await client.packages.list({ profile })).packages.find((item) => item.id === id)
        if (!row) throw new Error('Plugin is not installed.')
        if (!row.capabilityHash)
          throw new Error('Installed summary has no capability hash; update the daemon.')
        reviewedIntegrity = row.integrity
        io.write(`Requested capabilities: ${JSON.stringify(row.declaredCapabilities ?? 'not declared')}\n`)
        if (p.command === 'plugins' && !(p.yes || (await io.confirmEnable?.(row)))) {
          io.write('Enable cancelled. Use an interactive terminal or --yes.\n')
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
