import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const indexSrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const schemaDefNames = (file: string): string[] =>
  Object.keys(
    (
      JSON.parse(readFileSync(new URL(`../schema/${file}`, import.meta.url), 'utf8')) as {
        $defs: Record<string, unknown>
      }
    ).$defs,
  )
// Pull the names out of the two `export type { … } from '../gen/ts/<doc>.js'` blocks in index.ts.
// Types are erased at runtime and never appear on the module object, so the source file is the only
// place to read them — which is exactly the side this guard exists to watch.
const reexportedTypesFrom = (genModule: string): string[] => {
  const re = new RegExp(String.raw`export type \{([^}]*)\} from '\.\./gen/ts/${genModule}\.js'`)
  const m = re.exec(indexSrc)
  if (!m) throw new Error(`no type re-export block from ../gen/ts/${genModule}.js found in index.ts`)
  return (m[1] as string)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .sort()
}

const src = fileURLToPath(new URL('../src/', import.meta.url))
const files: string[] = []
const walk = (d: string) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    statSync(p).isDirectory() ? walk(p) : e.endsWith('.ts') && files.push(p)
  }
}
walk(src)

describe('protocol src boundary', () => {
  it('imports neither node:* nor @agnes/*', () => {
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toMatch(/from ['"]node:/)
      expect(text, f).not.toMatch(/from ['"]@agnes\//)
    }
  })
  // This used to check only that these names are present (one direction), so anything extra on the
  // surface went unnoticed. It is now a two-way toEqual pinning the runtime export surface, so adding
  // an export — or accidentally putting the resetMigrations test back door back on the root — goes
  // red.
  // Only exports that really exist at runtime (values and functions) are listed. Pure type exports
  // (EventType / ValidationResult /
  // ValidationError / MethodSpec / MethodName / RpcError / ApprovalVerdict / AcpPermissionKind /
  // TurnEndReason / AcpStopReason, plus every $def type from the two self-owned schemas) leave no
  // same-named property on the module object once erased — they are covered by the "type re-export
  // surface ↔ schema $defs" case below.
  it('index re-exports exactly the documented runtime surface (both directions)', async () => {
    const mod = await import('../src/index.js')
    expect(Object.keys(mod).sort()).toEqual(
      [
        'AGNES_ERRORS',
        'SESSION_TITLE_EVENT',
        'SessionTitleRecord',
        'readSessionTitle',
        'BRIDGE_ERRORS',
        'validateServiceCapability',
        'validateSurfaceArtifact',
        'validateSurfaceConfigValue',
        'validateSurfaceDescriptor',
        'validateSurfaceInstance',
        'validateSurfacePackageMetadata',
        'validateSurfaceServiceGrant',
        'PACKAGE_ADMIN_METHODS',
        'PACKAGE_ADMIN_PERMISSIONS',
        'RESOURCE_CONTROL_METHODS',
        'RESOURCE_CONTROL_PERMISSIONS',
        'canAccessPackageAdmin',
        'canAccessResourceControl',
        'validatePackageAdminData',
        'validatePackageAdminCall',
        'validateResourceControlData',
        'validateResourceControlCall',
        'validateSkinListResult',
        'validateSkinReadParams',
        'validateSkinReadResult',
        'validateClientModuleListResult',
        'validateClientModuleReadParams',
        'validateClientModuleReadResult',
        'validateClientModuleServiceCallParams',
        'validateClientModuleServiceCallResult',
        'validateClientModuleEffectCallParams',
        'validateClientModuleEffectCallResult',
        'validateExtensionCall',
        'validateExtensionCallError',
        'validateProjectionCapability',
        'validateProjectionReadResult',
        'validateRequestMedia',
        'validateActor',
        'validateAction',
        'validateTarget',
        'validateDecision',
        'validateCredential',
        'validateChannelManifest',
        'validateCommandHooksPolicy',
        'validateApprovalAction',
        'validateDirectoryEntry',
        'validateChannelCapabilities',
        'validateBridgeFrame',
        'AGH_DIR',
        'WORKSPACE_SECRET_DIRS',
        'AGNES_NS',
        'AI_ERROR_CODES',
        'ARTIFACT_READ_RPC_MAX_BYTES',
        'CURRENT_V',
        'DEFAULT_JSON_DATA_MAX_BYTES',
        'DSH_WEB_CLIENT_SLOT_CATALOG_VERSION',
        'inspectJsonData',
        'isWorkerGeneration',
        'jcs',
        'EVENT_TYPES',
        'EXT_EVENT_PATTERN',
        'EXT_EVENT_PATTERN_SOURCE',
        'HOOK_EVENTS',
        'HOOK_TABLE',
        'JSONRPC_ERRORS',
        'MAX_FRAME_BYTES',
        'MAX_RUNTIME_TARGET_ARTIFACT_BASE64_LENGTH',
        'META_KEY',
        'METHODS',
        'OFFERED_OPTION_KINDS',
        'SESSION_FORMAT',
        'SLOT_NAMES',
        'STOP_REASON_TABLE',
        'UI_HISTORY_DEFAULT_LIMIT',
        'UI_HISTORY_MAX_LIMIT',
        'UI_OPENING_DEFAULT_MAX_NODES',
        'UI_OPENING_MAX_NODES',
        'UI_PROJECTION_DEFAULT_MAX_BYTES',
        'UI_PROJECTION_MAX_BYTES',
        'UI_PROJECTION_MIN_MAX_BYTES',
        'UI_PROJECTION_RESYNC_REQUIRED',
        'UI_SLOT_MAX_BYTES',
        'UI_SLOT_NAMES',
        'UI_SLOT_TABLE',
        'ULID_PATTERN',
        'WEB_CLIENT_MODULE_SLOT_NAMES',
        'checkSequence',
        'fromAcpOptionKind',
        'getHarnessMeta',
        'isDateTime',
        'isEventType',
        'isHookEvent',
        'isDshWebClientModuleSlotName',
        'isWebClientModuleSlotName',
        'listMigrations',
        'normalize',
        'projectClientModuleRows',
        'registerMigration', // was named register, which collided semantically with extension-api's four register*
        'rpcError',
        'setHarnessMeta',
        'supportedVersions', // was named supported
        'toAcpOptionKind',
        'toAcpStopReason',
        'toRpcError',
        'validateAgainst',
        'validateContractManifest',
        'validateContractStamp',
        'validateProfileManifest',
        'validateProfileFragment',
        'validateResolvedProfile',
        'validateManagedPolicy',
        'validateLockfile',
        'validateExtensionManifest',
        'validateExtensionIsolationPolicy',
        'validateExtensionIsolationRequest',
        'validateDeployManifest',
        'validateJobSpec',
        'validateJobStatus',

        'validateEvent',
        'validateOpState',
        'validateHook',
        'validateMethod',
        'validateModelRecord',
        'validatePreset',
        'validateRouteTable',
        'validateRuntimeApplyFailedFrame',
        'validateRuntimeBootReadyFrame',
        'validateRuntimeConvergedFrame',
        'validateRuntimeConvergenceReport',
        'validateRuntimeConvergenceRow',
        'validateRuntimeStaleFrame',
        'validateRuntimeTargetArtifact',
        'validateSlotPayload',
        'validateToolDef',
        'workerGeneration',
      ].sort(),
    )
  })

  // ── Type re-export surface ↔ the $defs of the self-owned schemas ────────────────────────
  // The rule, stated at the top of src/index.ts: **every** type generated from the self-owned schema
  // documents is on the root surface. session-v1 owns the definitions the other two borrow, so a name
  // both documents carry is exported once, from session-v1: agnes-v1 borrows `JsonValue` and
  // `ContentBlock`, model.json borrows those two plus `ToolCall`.
  // Adding a $def and forgetting to put it on the root surface goes red here.
  // agnes-v1 borrows three more since SessionEventParams started carrying a whole ledger row:
  // EventEnvelope, and the Actor / SurfaceOp it references. They are spelled in agnes-v1.json as
  // cross-file $refs — the alternative, letting tools/gen.ts inject them with no name in $defs, is
  // what once let ContentBlock slip past the parity suite's coverage guard — and the case below
  // checks that each really is a $ref rather than a second independent definition.
  const ALIASES_OF_SESSION: Record<string, string[]> = {
    'agnes-v1': [
      'JsonValue',
      'ContentBlock',
      'Actor',
      'SurfaceOp',
      'EventEnvelope',
      'BudgetState',
      'ArtifactRef',
      'ArtifactJob',
    ],
    model: ['JsonValue', 'ContentBlock', 'ToolCall', 'Billing'],
  }
  it('every session-v1.json $def type is on the root surface (both directions)', () => {
    expect(reexportedTypesFrom('session-v1')).toEqual(schemaDefNames('session-v1.json').sort())
  })
  it('every worker.json $def type is on the root surface (both directions)', () => {
    expect(reexportedTypesFrom('worker')).toEqual(schemaDefNames('worker.json').sort())
  })
  for (const [doc, aliases] of Object.entries(ALIASES_OF_SESSION)) {
    it(`every ${doc}.json $def type is on the root surface, minus the cross-file aliases`, () => {
      const expected = schemaDefNames(`${doc}.json`)
        .filter(
          (n) =>
            !aliases.includes(n) &&
            !(
              doc === 'agnes-v1' &&
              [
                'PackageActivationTrust',
                'PackageActivationRequest',
                'PackageRollbackTarget',
                'PackageAdminContext',
                'PackageCatalogDescriptor',
                'PackageCatalogGetParams',
                'PackageCatalogListParams',
                'PackageCatalogPage',
                'PackageDisableParams',
                'PackageEnableParams',
                'PackageInspectParams',
                'PackageInstallParams',
                'PackageListParams',
                'PackageListResult',
                'SkinReadParams',
                'ClientModuleReadParams',
                'PackageOperation',
                'PackageOperationCancelParams',
                'PackageOperationGetParams',
                'PackageOperationReceipt',
                'PackagePinsInspectParams',
                'PackagePinsInspectResult',
                'PackagePinsReleaseParams',
                'PackagePinsReleaseResult',
                'PackageRemoveParams',
                'PackageRollbackParams',
                'PackageTrustParams',
                'PackageUntrustParams',
                'PackageTrustWorkspaceParams',
                'PackageTrustWorkspaceResult',
                'PackageUpdateParams',
                'PluginTreeApplyParams',
                'PluginTreeApplyResult',
                'PluginTreeRollbackParams',
                'PluginTreeRollbackResult',
                'PluginTreeView',
                'JwtCredential',
                'SourceAuthCredential',
                'PortalIdentityCredential',
                'LocalCredential',
                'SurfaceAuthCredential',
                'ChannelCredential',
                'Credential',
                'DirectoryEntry',
                'Schedule',
                'JobSpec',
                'JobStatus',
                // SessionSetModelParams.slot $refs model.json's SlotName rather than retyping its
                // seven-value enum a second time; SlotName is already on the surface via model.ts.
                'SlotName',
              ].includes(n)
            ),
        )
        .sort()
      expect(reexportedTypesFrom(doc)).toEqual(expected)
    })
    it(`${doc}.json's alias names really are cross-file $refs, not independent definitions`, () => {
      const parsed = JSON.parse(readFileSync(new URL(`../schema/${doc}.json`, import.meta.url), 'utf8')) as {
        $defs: Record<string, { $ref?: string }>
      }
      for (const n of aliases) expect(parsed.$defs[n]?.$ref, n).toBe(`session-v1.json#/$defs/${n}`)
    })
  }
  it('ACP types stay off the root surface (rule 3)', () => {
    expect(indexSrc).not.toMatch(/from '\.\.\/gen\/ts\/acp\.js'/)
  })
  // `DATA_DEFS` (validateEvent's internal lookup table, 11 generated TypeBox schemas) stays off the
  // root export surface. `EXT_EVENT_PATTERN_SOURCE` is the opposite: it is the single source of truth
  // for the extension event namespace (schema and constant share one origin), downstream packages
  // have legitimate uses for it, and it is deliberately kept on the surface. Both are pinned by
  // assertions, so that nobody can put `export * from './validate.js'` back or delete the constant in
  // passing.
  it('keeps DATA_DEFS and resetMigrations off the root surface, keeps EXT_EVENT_PATTERN_SOURCE on it', async () => {
    const mod = await import('../src/index.js')
    expect(mod).not.toHaveProperty('DATA_DEFS')
    // resetMigrations clears a module-level global Map, so any package calling it at runtime could
    // wipe the process-wide migration registry — considerably riskier than the read-only lookup table
    // that was taken off the surface, and likewise kept off the root.
    expect(mod).not.toHaveProperty('resetMigrations')
    expect(mod).toHaveProperty('EXT_EVENT_PATTERN_SOURCE')
  })
})

// Imported route/hook types already belong to their defining modules; config adds only PresetDoc.
it('preset adds only its document type at the public boundary', () => {
  expect(reexportedTypesFrom('preset')).toEqual(['PresetDoc'])
})

describe('Task20 generated type exports', () => {
  it.each([
    'profile',
    'lockfile',
    'extension-manifest',
    'deploy-manifest',
    'jobs',
    'surface',
    'package-admin',
    'resource-control',
  ])('%s owns every non-alias type on the root surface', (file) => {
    const doc = JSON.parse(readFileSync(new URL(`../schema/${file}.json`, import.meta.url), 'utf8')) as {
      $defs: Record<string, Record<string, unknown>>
    }
    expect(reexportedTypesFrom(file)).toEqual(
      Object.entries(doc.$defs)
        .filter(([, value]) => value.$ref === undefined)
        .map(([name]) => name)
        .sort(),
    )
  })
})

describe('Task21 schema ownership', () => {
  for (const [doc, aliases] of [
    ['authz', ['Actor']],
    ['channel', ['Auth']],
    ['bridge', ['JsonValue']],
  ] as const) {
    it(`${doc} root type closure`, () =>
      expect(reexportedTypesFrom(doc)).toEqual(
        schemaDefNames(`${doc}.json`)
          .filter((n) => !(aliases as readonly string[]).includes(n))
          .sort(),
      ))
  }
  it('Auth and its five branches share the channel facts without a reference cycle', () => {
    const agnes = JSON.parse(readFileSync(new URL('../schema/agnes-v1.json', import.meta.url), 'utf8'))
    for (const name of [
      'Auth',
      'JwtCredential',
      'SourceAuthCredential',
      'PortalIdentityCredential',
      'LocalCredential',
      'SurfaceAuthCredential',
    ])
      expect(agnes.$defs[name]).toEqual({ $ref: `channel.json#/$defs/${name}` })
    expect(readFileSync(new URL('../schema/channel.json', import.meta.url), 'utf8')).not.toContain(
      'agnes-v1.json',
    )
  })
})
