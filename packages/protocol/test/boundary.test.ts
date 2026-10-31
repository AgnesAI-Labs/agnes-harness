import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isAdminModelAdapter } from '../src/index.js'

const indexSrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const schemaDefNames = (file: string): string[] =>
  Object.keys(
    (
      JSON.parse(readFileSync(new URL(`../schema/${file}`, import.meta.url), 'utf8')) as {
        $defs: Record<string, unknown>
      }
    ).$defs,
  )
// A schema can have several export blocks; value schemas also export their same-named type.
const reexportedTypesFrom = (genModule: string): string[] => {
  const re = new RegExp(String.raw`export(?: type)? \{([^}]*)\} from '\.\./gen/ts/${genModule}\.js'`, 'g')
  const blocks = [...indexSrc.matchAll(re)]
  if (!blocks.length) throw new Error(`no re-export block from ../gen/ts/${genModule}.js found in index.ts`)
  return blocks
    .flatMap((match) =>
      match[1]!
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    )
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
        'PROFILE_DECISION_JOURNAL_PREFIX',
        'isProfileDecisionJournal',
        'profileDecisionJournalKey',
        'PLUGIN_STREAM_PATH',
        'PLUGIN_STREAM_OPEN_PATH',
        'PLUGIN_STREAM_SOURCE_PATH',
        'PLUGIN_STREAM_SOURCE_OPEN_PATH',
        'PLUGIN_STREAM_HEADER_BYTES',
        'PLUGIN_STREAM_MAX_BYTES',
        'validateStreamDeclaration',
        'transportCapabilityProblems',
        'validatePluginStreamOpen',
        'validatePluginStreamGrant',
        'validatePluginStreamHello',
        'validatePluginStreamJsonFrame',
        'validateManagedServiceReady',
        'validateManagedServiceDescriptor',
        'encodePluginStreamBinary',
        'decodePluginStreamBinary',

        'APPROVAL_REASONS',
        'AutoReviewConfig',
        'ToolReviewFact',
        'WorkbenchEvidenceItem',
        'automaticPermissionDecision',
        'permissionEffectAdmission',
        'isPermissionPurpose',
        'samePermissionContext',
        'publicErrorCode',
        'publicErrorContract',
        'publicErrorCopy',
        'publicErrorHelp',
        'publicErrorMessageKey',
        'publicErrorReason',
        'publicRejectionRpc',
        'readWorkbenchEvidence',
        'compilePluginConfig',
        'redactPluginConfig',
        'resolvePluginMetadata',
        'validatePluginMetadata',
        'PLUGIN_SECRET_REF_PATTERN',
        'fileReferenceBrowse',
        'parentFileReferenceBrowse',
        'validateReferenceSelections',
        'ADMIN_METHODS',
        'APP_SERVER_VERSION',
        'APP_SERVER_SCHEMA',
        'AppServerError',
        'AppServerErrorCause',
        'safeDiagnosticRecord',
        'diagnosticRecords',
        'describeValidationErrors',
        'observeDiagnostics',
        'normalizeRpcError',
        'errorMessageKey',
        'SESSION_VERSION_CODES',
        'sessionVersionNotice',
        'httpRpcError',
        'CHILD_ENGINE_ROW_IDS',
        'CHILD_ENGINE_CAPABILITIES',
        'CLIENT_PLATFORM_IMPORTS',
        'parseChildEngineSettings',
        'METHOD_TIERS',
        'ChildEnginesSaveParams',
        'ChildEnginesState',
        'DISABLED_CHILD_ENGINES',
        'RuntimeAdminEmpty',
        'RuntimeAdminSnapshot',
        'AuxiliaryModelTarget',
        'AutomaticModelTarget',
        'AuxiliaryModelSlots',
        'ModelSlotsSnapshot',
        'RuntimePublicationReport',
        'RuntimeSecurityStatus',
        'parseSessionBundles',
        'parseSystemPromptAppend',
        'SYSTEM_PROMPT_APPEND_MAX',
        'parseAgentRef',
        'AgentPlan',
        'AgentResolveParams',
        'ApplicationAdoptParams',
        'ApplicationClearParams',
        'ApplicationConfigSnapshot',
        'ApplicationPreview',
        'ApplicationPreviewParams',
        'ApplicationSelection',
        'ApplicationState',
        'PresentationRoleSelection',
        'PresentationRoleSelections',
        'PresentationRoleState',
        'isAdminLoop',
        'isAdminModelAdapter',
        'isSessionDefaults',
        'isSessionDefaultsSnapshot',
        'parseLoopSelection',
        'parseLoopSpecifier',
        'pluginFailureHelp',
        'decodeAttachmentData',
        'USER_MESSAGE_ATTACHMENT_LIMITS',
        'validateUserAttachments',
        'fromAcpPrompt',
        'toAcpPrompt',
        'SESSION_TITLE_EVENT',
        'SessionTitleRecord',
        'SessionRuntimeDescriptor',
        'SessionRuntimeParams',
        'SessionIntegrityParams',
        'SessionIntegrityStatus',
        'SessionToolsParams',
        'SessionToolsResult',
        'CapabilitySource',
        'CapabilityReason',
        'SessionCapability',
        'SessionCapabilitySet',
        'SessionCapabilityInfo',
        'CompositionCapabilitySnapshot',
        'readChildEngineSettings',
        'readEngineDocument',
        'readSdkEngineDocument',
        'readSessionTitle',
        'minimumContextBudget',
        'modelImageInputError',
        'decodeSafeImageBytes',
        'decodeSafeImages',
        'USER_MESSAGE_IMAGE_LIMITS',
        'USER_IMAGE_ORIGINAL_LIMITS',
        'userImagePolicy',
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
        'boundedUiJson',
        'componentDataValid',
        'uiDataBinding',
        'uiObject',
        'validIntelligentSurface',
        'validIntelligentSurfaceProjection',
        'validUiComponentDeclaration',
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
        'ARTIFACT_REGISTERED_EVENT',
        'ATTACHMENT_ERROR_CODES',
        'AttachmentError',
        'attachmentLink',
        'attachmentErrorCode',
        'storedAttachment',
        'SESSION_ARTIFACT_ROOT_EVENT_TYPES',
        'sessionArtifactRoots',
        'CURRENT_V',
        'DEFAULT_JSON_DATA_MAX_BYTES',
        'DEFAULT_VOICE_SETTINGS',
        'DSH_WEB_CLIENT_SLOT_CATALOG_VERSION',
        'inspectJsonData',
        'isWorkerGeneration',
        'jcs',
        'jcsChunks',
        'jcsWrite',
        'JcsByteLimitError',
        'sha256Hex',
        'IncrementalSha256',
        'FILE_UPLOAD_PATH',
        'FILE_UPLOAD_CHUNK_BYTES',
        'uploadedAttachment',
        'EVENT_TYPES',
        'EXT_EVENT_PATTERN',
        'EXT_EVENT_PATTERN_SOURCE',
        'HARNESS_VERSION',
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
        'ScheduleHistoryEntry',
        'ScheduleRun',
        'ScheduleRunOutcome',
        'ScheduleSelector',
        'ScheduleTarget',
        'ScheduleView',
        'SchedulesArchiveParams',
        'SchedulesArchiveResult',
        'SchedulesControlParams',
        'SchedulesControlResult',
        'SchedulesHistoryParams',
        'SchedulesHistoryResult',
        'SchedulesReceiptParams',
        'SchedulesReceiptResult',
        'SchedulesListParams',
        'SchedulesListResult',
        'SchedulesUpsertParams',
        'SchedulesUpsertResult',
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
        'VOICE_AUDIO_MAX_BASE64',
        'VOICE_CALL_TIMEOUT_MS',
        'VOICE_LINK_TIMEOUT_MS',
        'VOICE_SEGMENT_MAX_SECONDS',
        'VOICE_SEGMENT_SLACK_SECONDS',
        'VOICE_SPEAK_MAX_CHARS',
        'VOICE_SPEECH_MAX_BASE64',
        'VOICE_TRANSCRIPT_MAX_CHARS',
        'WEB_CLIENT_MODULE_SLOT_NAMES',
        'checkSequence',
        'childEngineRowConfig',
        'childEngineSettingsError',
        'commandAllowed',
        'defaultLoop',
        'defaultModelAdapter',
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
      'DecisionResponse',
      'DecisionCommandReceipt',
      'DecisionSnapshot',
      'JsonValue',
      'ContentBlock',
      'SystemInput',
      'Actor',
      'SurfaceOp',
      'EventEnvelope',
      'ExtensionEventType',
      'BudgetState',
      'ArtifactRef',
      'ArtifactJob',
    ],
    model: ['JsonValue', 'ContentBlock', 'ToolCall', 'Billing', 'ResponseMeta'],
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
                'AuthoringFile',
                'AuthoringOrigin',
                'AuthoringTests',
                'AuthoringCandidate',
                'AuthoringCandidateList',
                'AuthoringCreateParams',
                'AuthoringWriteParams',
                'AuthoringTestParams',
                'AuthoringSubmitParams',
                'AuthoringApproveParams',
                'AuthoringRejectParams',
                'AuthoringShowParams',
                'AuthoringProvenance',
                'AuthoringCandidateSummary',
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
                'PluginGenerationStatus',
                'PluginPublicationReport',
                'PluginPublicationStatusResult',
                'SessionGenerationMigrationParams',
                'SessionGenerationMigrationResult',
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
                // These generated schemas/types are exposed by the dedicated auto-review module.
                'AutoReviewConfig',
                'ToolReviewFact',
                'WorkbenchEvidenceItem',
                'automaticPermissionDecision',
                'isPermissionPurpose',
                'samePermissionContext',
                'publicErrorCode',
                'publicErrorContract',
                'publicErrorCopy',
                'publicErrorHelp',
                'publicErrorMessageKey',
                'publicErrorReason',
                'publicRejectionRpc',
                'readWorkbenchEvidence',
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
    'intelligent-ui',
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

describe('admin model adapter catalog guard', () => {
  const adapter = {
    id: 'adapter',
    version: '1.0.0',
    wireApi: 'wire',
    sourcePackage: '@acme/adapter',
    capabilities: { imageInput: false, tools: true, streaming: true },
    models: [{ id: 'm', label: 'M', route: 'r' }],
  }
  const withCapabilities = (extra: Record<string, unknown>) => ({
    ...adapter,
    capabilities: { ...adapter.capabilities, ...extra },
  })

  it('accepts the three required capabilities alone', () => {
    expect(isAdminModelAdapter(adapter)).toBe(true)
  })

  it('accepts the optional payload and payloadOnly capabilities', () => {
    expect(isAdminModelAdapter(withCapabilities({ payload: true, payloadOnly: true }))).toBe(true)
    expect(isAdminModelAdapter(withCapabilities({ payload: false }))).toBe(true)
    expect(isAdminModelAdapter(withCapabilities({ payloadOnly: false }))).toBe(true)
  })

  it('rejects a non-boolean payload or payloadOnly', () => {
    expect(isAdminModelAdapter(withCapabilities({ payload: 'yes' }))).toBe(false)
    expect(isAdminModelAdapter(withCapabilities({ payloadOnly: 'yes' }))).toBe(false)
    expect(isAdminModelAdapter(withCapabilities({ payload: 1 }))).toBe(false)
    expect(isAdminModelAdapter(withCapabilities({ payloadOnly: null }))).toBe(false)
  })

  it('rejects any other capability key', () => {
    expect(isAdminModelAdapter(withCapabilities({ batch: true }))).toBe(false)
    expect(isAdminModelAdapter(withCapabilities({ payload: true, batch: true }))).toBe(false)
  })

  it('still requires the three original capabilities', () => {
    for (const key of ['imageInput', 'tools', 'streaming']) {
      const { [key]: _omitted, ...rest } = adapter.capabilities as Record<string, boolean>
      expect(isAdminModelAdapter({ ...adapter, capabilities: { ...rest, payload: true } }), key).toBe(false)
    }
  })
})
