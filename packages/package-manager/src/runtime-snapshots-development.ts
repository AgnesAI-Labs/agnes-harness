import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createPluginRow, isResourceOwnedRowId, type PluginRow } from '@agnes/plugin-runtime/host'
import { inspectStaged } from './inspect.js'
import { readStaticJson } from './integrity.js'
import type { RuntimePluginSnapshot } from './package-plugin-loader.js'
import { parseAgnesPluginEntries } from './plugin-manifest.js'
import { hashDirectory } from './sources.js'

/** Explicit dev entry point: inspect local data before executable code is imported. */
export function readDevelopmentPlugin(directory: string, profile: string): RuntimePluginSnapshot {
  directory = resolve(directory)
  const pkg = readStaticJson(join(directory, 'package.json'))
  const integrity = hashDirectory(directory, { exclude: [] })
  const { preview, treeIntegrity } = inspectStaged({
    dir: directory,
    source: { type: 'file', ref: 'file:./development' },
    fetched: {
      dir: directory,
      version: pkg.version as string,
      integrity,
      license: (pkg.license as string | undefined) ?? 'UNLICENSED',
      dependencies: (pkg.dependencies ?? {}) as Record<string, string>,
    },
    ceiling: [],
  })
  if (!preview.capabilityHash) throw new Error('E_PLUGIN_RELOAD_METADATA: package has no capability hash')
  if (preview.blockers.length)
    throw new Error('E_PLUGIN_RELOAD_METADATA: local package metadata has blockers')
  return {
    generation: 1,
    trusted: true,
    snapshot: {
      directory,
      profile,
      snapshotId: integrity,
      integrity,
      treeIntegrity,
      packageId: preview.id,
      version: preview.version,
      capabilityHash: preview.capabilityHash,
      contributions: preview.contributions,
    },
  }
}

export function generationClientRowId(packageId: string, count: number, contributionId: string): string {
  if (count === 1) return `web:${packageId}`
  const readable = `web:${packageId}:${contributionId}`
  return readable.length <= 256
    ? readable
    : `web:${createHash('sha256').update(`${packageId}\0${contributionId}`).digest('hex')}`
}

export function developmentPluginRows(
  source: RuntimePluginSnapshot,
  previous: readonly Readonly<PluginRow>[],
): readonly Readonly<PluginRow>[] {
  const snapshot = source.snapshot,
    pkg = readStaticJson(join(snapshot.directory, 'package.json'))
  const declarations = parseAgnesPluginEntries(
    snapshot.packageId,
    (pkg.agnes as { plugins?: unknown } | undefined)?.plugins,
  )
  const rows: Readonly<PluginRow>[] = declarations
    .filter((entry) => !isResourceOwnedRowId(entry.id))
    .map((entry) => {
      const old = previous.find((row) => row.id === entry.id)
      return createPluginRow({
        id: entry.id,
        plugin: `${snapshot.packageId}@${snapshot.snapshotId}/${entry.export}`,
        snapshotDigest: snapshot.integrity,
        exportName: entry.export,
        entryRevision: snapshot.snapshotId,
        extrasRevision: 'none',
        mountRevision: 'host-ordinary-row:v1',
        ...(old?.config !== undefined || entry.config !== undefined
          ? { config: old?.config ?? entry.config }
          : {}),
        ...(entry.inject ? { inject: entry.inject } : {}),
        ...(entry.provide ? { provides: entry.provide } : {}),
        runtime: entry.runtime,
        disabled: old?.disabled ?? !entry.default,
      })
    })
  const clients = snapshot.contributions.filter(
    (item) =>
      (item.kind === 'client' && 'client' in item) ||
      (item.kind === 'extension' && item.client !== undefined),
  )
  for (const item of clients) {
    if (!('client' in item)) continue
    const id = generationClientRowId(snapshot.packageId, clients.length, item.client?.id ?? item.id)
    rows.push(
      createPluginRow({
        id,
        plugin:
          clients.length === 1
            ? `${snapshot.packageId}@${snapshot.snapshotId}/client`
            : `${snapshot.packageId}@${snapshot.snapshotId}/client/${item.id}`,
        snapshotDigest: snapshot.integrity,
        exportName: 'client',
        entryRevision: snapshot.snapshotId,
        extrasRevision: 'none',
        mountRevision: 'host-web-row:v1',
        runtime: 'in-process',
        disabled: previous.find((row) => row.id === id)?.disabled ?? false,
      }),
    )
  }
  return rows
}
