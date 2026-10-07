import { isAbsolute, relative, resolve, sep } from 'node:path'
import { escapeControl } from '@agnes/cli-tui'
import type { PackageInstalledDescriptor } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { UsageError } from '../errors.js'
import {
  inspectPackage,
  installPreview,
  newPackageCommandId,
  waitForPackageOperation,
} from '../tui/package-admin.js'
import type { ParsedArgs } from '../types.js'

/** Local development explicitly approves the inspected revision; reload preserves disabled state. */
export async function runPluginDevelopmentCommand(
  p: ParsedArgs,
  client: NodeClient,
  write: (text: string) => void,
): Promise<void> {
  const profile = p.profile ?? 'local-dev'
  if (p.command === 'plugins' && p.positional[0] === 'publication-status') {
    if (p.positional.length !== 1) throw new UsageError('plugins publication-status takes no arguments')
    const result = await client.packages.publicationStatus({ profile })
    if (p.json) write(`${JSON.stringify(result)}\n`)
    else if (!result.publication)
      write('No composition publication has been recorded in the current worker.\n')
    else {
      const report = result.publication
      write(`${report.operation}: ${report.ok ? 'applied' : 'partial publication; retry the same input'}\n`)
      for (const row of report.containers)
        write(
          `${escapeControl(row.compositionHash)}\t${row.status}${row.error ? `\t${escapeControl(row.error)}` : ''}\n`,
        )
    }
    return
  }
  const dev = p.command === 'dev'
  if (dev ? p.positional.length !== 1 : p.positional[0] !== 'reload' || p.positional.length > 2)
    throw new UsageError('usage: agh dev <plugin-folder> | agh plugins reload [id]')
  const installed = (await client.packages.list({ profile })).packages
  let selected: { directory: string; previous?: PackageInstalledDescriptor }[]
  if (dev) selected = [{ directory: resolve(p.cwd ?? process.cwd(), p.positional[0] as string) }]
  else {
    const id = p.positional[1]
    const rows = installed.filter((row) =>
      id
        ? row.id === id
        : (row.source.type === 'file' || row.source.type === 'local') && row.desired === 'enabled',
    )
    if (id && !rows.length) throw new Error('E_PLUGIN_RELOAD_SOURCE_MISSING: plugin is not installed')
    selected = rows.map((previous) => {
      if (previous.source.type !== 'file' && previous.source.type !== 'local')
        throw new Error('E_PLUGIN_RELOAD_SOURCE_MISSING: reload requires a local file source')
      if (previous.actual === 'restart-required')
        throw new Error('E_GENERATION_RESTART_REQUIRED: this plugin requires a restart')
      if (!previous.trusted || previous.desired !== 'enabled')
        throw new Error('E_PLUGIN_RELOAD_DISABLED: activate the local folder with agh dev first')
      return { directory: previous.source.ref, previous }
    })
  }
  for (const entry of selected) {
    if (entry.previous?.source.type === 'local') {
      const result = await waitForPackageOperation(
        client,
        await client.packages.enable({
          profile,
          clientId: await client.clientId(),
          id: entry.previous.id,
          commandId: newPackageCommandId('local-reload'),
        }),
      )
      if (
        !result.installed ||
        result.installed.actual === 'failed' ||
        result.installed.actual === 'restart-required'
      )
        throw new Error('E_PLUGIN_RELOAD_ACTIVATION: local reload was not accepted')
      write(`${entry.previous.id} ready for new sessions; existing sessions keep their generation.\n`)
      continue
    }
    const localPath = relative(p.cwd ?? process.cwd(), entry.directory)
    if (dev && (!localPath || isAbsolute(localPath) || localPath.split(sep).includes('..')))
      throw new Error('E_PLUGIN_RELOAD_SOURCE_SCOPE: dev folder must be below the daemon startup workspace')
    const source = {
      type: 'file' as const,
      ref: dev ? `file:./${localPath.split(sep).join('/')}` : entry.directory,
    }
    const preview = await inspectPackage(client, profile, source)
    if (!preview.capabilityHash) throw new Error('E_PLUGIN_RELOAD_METADATA: package has no capability hash')
    if (preview.blockers.length) throw new Error('E_PLUGIN_RELOAD_BLOCKED: local package failed inspection')
    let previous = entry.previous ?? installed.find((row) => row.id === preview.id)
    if (previous?.actual === 'restart-required')
      throw new Error('E_GENERATION_RESTART_REQUIRED: this plugin requires a restart')
    const base = { profile, clientId: await client.clientId(), id: preview.id }
    if (!previous) {
      const result = await installPreview(client, profile, preview)
      previous = result.installed
      if (!previous) throw new Error('E_PLUGIN_RELOAD_INSTALL: installation returned no package')
    }
    if (previous.integrity !== preview.integrity) {
      await waitForPackageOperation(
        client,
        await client.packages.update({
          ...base,
          commandId: newPackageCommandId('reload'),
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
    } else {
      if (!previous.trusted)
        await waitForPackageOperation(
          client,
          await client.packages.trust({
            ...base,
            commandId: newPackageCommandId('dev-trust'),
            expectedIntegrity: preview.integrity,
            capabilityHash: preview.capabilityHash,
          }),
        )
      if (previous.desired !== 'enabled')
        await waitForPackageOperation(
          client,
          await client.packages.enable({
            ...base,
            commandId: newPackageCommandId('dev-enable'),
            expectedInstalledIntegrity: preview.integrity,
          }),
        )
    }
    write(
      `${preview.id}@${preview.version} ready for new sessions; existing sessions keep their generation.\n`,
    )
  }
  if (!selected.length) write('No enabled local plugins to reload.\n')
}
