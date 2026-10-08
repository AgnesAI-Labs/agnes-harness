import { createConfigurationService } from '@agnes/host-infrastructure/configuration'
import type { OrdinaryPluginLayers } from '@agnes/host-providers/assemble/ordinary-rows'
import { buildCompleteRuntimeTarget } from '@agnes/host-providers/runtime-target-builder'
import {
  createPluginRow,
  decodeRuntimeTargetArtifact,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import {
  CHILD_ENGINE_ROW_IDS,
  type ChildEngineSettings,
  childEngineRowConfig,
  type EngineDocument,
} from '@agnes/protocol'

const EXPORTS = {
  [CHILD_ENGINE_ROW_IDS.codex]: 'codexChildAgentsPlugin',
  [CHILD_ENGINE_ROW_IDS.claudeCode]: 'claudeCodeChildAgentsPlugin',
  [CHILD_ENGINE_ROW_IDS.sdk]: 'sdkChildAgentsPlugin',
} as const

function engineRow(
  id: keyof typeof EXPORTS,
  engine: EngineDocument & { protocol?: 'sdk' | 'acp' },
  integrity: string,
) {
  return createPluginRow({
    id,
    plugin: `builtin:@agnes/base/${EXPORTS[id]}`,
    snapshotDigest: integrity,
    exportName: EXPORTS[id],
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
    deployment: {
      [CHILD_ENGINE_ROW_IDS.codex]: {
        enabled: settings.codex.enabled,
        config: childEngineRowConfig(settings.codex),
      },
      [CHILD_ENGINE_ROW_IDS.claudeCode]: {
        enabled: settings.claudeCode.enabled,
        config: childEngineRowConfig(settings.claudeCode),
      },
      [CHILD_ENGINE_ROW_IDS.sdk]: {
        enabled: settings.sdk.enabled,
        config: childEngineRowConfig(settings.sdk),
      },
    },
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
  const ids = new Set<string>(Object.values(CHILD_ENGINE_ROW_IDS))
  const ordinary = decoded.tree.rows.filter((row) => !ids.has(row.id))
  const resourceRows = Object.values(decoded.resource.rows).filter(
    (row): row is NonNullable<typeof row> => row !== null,
  )
  return buildCompleteRuntimeTarget({
    rows: [
      ...ordinary,
      engineRow(CHILD_ENGINE_ROW_IDS.codex, settings.codex, integrity),
      engineRow(CHILD_ENGINE_ROW_IDS.claudeCode, settings.claudeCode, integrity),
      engineRow(CHILD_ENGINE_ROW_IDS.sdk, settings.sdk, integrity),
      ...resourceRows,
    ],
    resources: decoded.resource.resources,
    resourceRevision: decoded.resource.target.resourceRevision,
  }).artifact
}
