import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import type { OrdinaryPluginLayers } from '@agnes/host-providers/assemble/ordinary-rows'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import { RELEASE_CHILD_ENGINES } from '@agnes/package-manager'
import {
  createPluginRow,
  decodeRuntimeTargetArtifact,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import { type ChildEngineSettings, childEngineRowConfig, type EngineDocument } from '@agnes/protocol'

function engineRow(
  row: (typeof RELEASE_CHILD_ENGINES.rows)[number],
  engine: EngineDocument & { protocol?: 'sdk' | 'acp' },
  integrity: string,
) {
  return createPluginRow({
    id: row.id,
    plugin: `builtin:${RELEASE_CHILD_ENGINES.packageId}/${row.exportName}`,
    snapshotDigest: integrity,
    exportName: row.exportName,
    entryRevision: integrity,
    extrasRevision: 'none',
    mountRevision: 'host-ordinary-row:v1',
    config: childEngineRowConfig(engine),
    inject: ['childAgents'],
    runtime: 'in-process',
    disabled: !engine.enabled,
  })
}

/** Deployment-layer overrides for the three builtin child-engine rows. */
export function childEnginePluginLayers(settings: ChildEngineSettings): OrdinaryPluginLayers {
  return {
    deployment: Object.fromEntries(
      RELEASE_CHILD_ENGINES.rows.map((row) => [
        row.id,
        { enabled: settings[row.setting].enabled, config: childEngineRowConfig(settings[row.setting]) },
      ]),
    ),
  }
}

/** Reads the profile file. A missing or unreadable document leaves the rows at their disabled default. */
export async function loadChildEnginePluginLayers(input: {
  home: string
  profile: string
  profileDir?: string
}): Promise<OrdinaryPluginLayers | undefined> {
  try {
    const snapshot = await createConfigurationService(input).childEngines()
    return childEnginePluginLayers(snapshot.engines)
  } catch {
    return undefined
  }
}

/**
 * Replaces only the three child-engine rows on an existing desired artifact.
 * Callers must not publish this when there is no current artifact.
 */
export function overlayChildEngineTarget(
  previous: RuntimeTargetArtifact,
  settings: ChildEngineSettings,
  integrity: string,
): RuntimeTargetArtifact {
  const decoded = decodeRuntimeTargetArtifact(previous)
  const ids = new Set<string>(RELEASE_CHILD_ENGINES.rows.map((row) => row.id))
  const ordinary = decoded.tree.rows.filter((row) => !ids.has(row.id))
  const resourceRows = Object.values(decoded.resource.rows).filter(
    (row): row is NonNullable<typeof row> => row !== null,
  )
  return buildCompleteRuntimeTarget({
    rows: [
      ...ordinary,
      ...RELEASE_CHILD_ENGINES.rows.map((row) => engineRow(row, settings[row.setting], integrity)),
      ...resourceRows,
    ],
    resources: decoded.resource.resources,
    resourceRevision: decoded.resource.target.resourceRevision,
  }).artifact
}
