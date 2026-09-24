import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateModule, type JsonSchemaDoc } from './gen-core.js'
import { writeDocs } from './gen-docs.js'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
type ImportSpec = { from: string; defs: string[] }
const TARGETS: Array<{
  schema: string
  out: string
  module: string
  imports?: ImportSpec[]
}> = [
  { schema: 'schema/worker.json', out: 'gen/ts/worker.ts', module: 'WorkerSchema' },
  {
    schema: 'schema/resource-control.json',
    out: '../resource-control-contracts/src/gen/resource-control.ts',
    module: 'ResourceControlSchema',
    imports: [
      { from: 'schema/profile.json', defs: ['SecretRef'] },
      { from: 'schema/session-v1.json', defs: ['JsonValue'] },
    ],
  },
  {
    schema: 'schema/package-admin.json',
    out: 'gen/ts/package-admin.ts',
    module: 'PackageAdminSchema',
    imports: [
      { from: 'schema/surface.json', defs: ['SurfaceDescriptor', 'SurfaceArtifact', 'SurfaceServiceGrant'] },
      {
        from: 'schema/extension-manifest.json',
        defs: ['Capabilities', 'ClientContribution', 'SkinContribution', 'SkinTokenValue'],
      },
      { from: 'schema/hooks.json', defs: ['HookEvent'] },
      { from: 'schema/slots.json', defs: ['UiSlotName'] },
      { from: 'schema/profile.json', defs: ['SeamName'] },
      { from: 'schema/projection.json', defs: ['ProjectionCapability'] },
      { from: 'schema/extension-service.json', defs: ['ServiceCapability', 'ExtensionCallResult'] },
      { from: 'schema/tooldef.json', defs: ['ParametersSchema'] },
      { from: 'schema/session-v1.json', defs: ['JsonValue'] },
    ],
  },
  { schema: 'schema/session-v1.json', out: 'gen/ts/session-v1.ts', module: 'SessionV1' },
  {
    schema: 'schema/agnes-v1.json',
    out: 'gen/ts/agnes-v1.ts',
    module: 'AgnesV1',
    // SessionEventParams carries a whole ledger row, so EventEnvelope has to come across too, and it
    // in turn references Actor and SurfaceOp. The list is the transitive closure: EventEnvelope's
    // remaining $ref is JsonValue, which was already here.
    imports: [
      {
        from: 'schema/package-admin.json',
        defs: [
          'PackageAdminPermission',
          'PackageSource',
          'PackageContributionSummary',
          'PackageCapabilityDiff',
          'PackageBlocker',
          'PackageWarning',
          'PackageProvenance',
          'PackagePreview',
          'PackageTrustDecision',
          'PackageActivationTrust',
          'PackageActivationRequest',
          'PackageRollbackTarget',
          'PackageAdminContext',
          'PackageInstalledDescriptor',
          'PackageCatalogDescriptor',
          'PackageAdminError',
          'PackageOperationReceipt',
          'PackageOperation',
          'PackageCatalogPage',
          'PackageListResult',
          'PackageCatalogListParams',
          'PackageCatalogGetParams',
          'PackageListParams',
          'SkinReadParams',
          'ClientModuleReadParams',
          'PackageInspectParams',
          'PackageInstallParams',
          'PackageTrustParams',
          'PackageUntrustParams',
          'PackageEnableParams',
          'PackageDisableParams',
          'PackageRollbackParams',
          'PackageRemoveParams',
          'PackageUpdateParams',
          'PackageOperationGetParams',
          'PackageOperationCancelParams',
          'RuntimePinDescriptor',
          'RuntimePinReleaseResult',
          'PackagePinsInspectParams',
          'PackagePinsInspectResult',
          'PackagePinsReleaseParams',
          'PackagePinsReleaseResult',
          'PackageTrustWorkspaceParams',
          'PackageTrustWorkspaceResult',
          'PluginTreeArtifact',
          'PluginTreeApplyParams',
          'PluginTreeRollbackParams',
          'PluginTreeView',
          'PluginTreeApplyResult',
          'PluginTreeRollbackResult',
        ],
      },
      { from: 'schema/surface.json', defs: ['SurfaceDescriptor', 'SurfaceArtifact', 'SurfaceServiceGrant'] },
      {
        from: 'schema/extension-manifest.json',
        defs: ['Capabilities', 'ClientContribution', 'SkinContribution', 'SkinTokenValue'],
      },
      { from: 'schema/hooks.json', defs: ['HookEvent'] },
      { from: 'schema/slots.json', defs: ['UiSlotName'] },
      { from: 'schema/profile.json', defs: ['SeamName'] },
      { from: 'schema/projection.json', defs: ['ProjectionCapability'] },
      { from: 'schema/tooldef.json', defs: ['ParametersSchema'] },

      {
        from: 'schema/channel.json',
        defs: [
          'Auth',
          'Credential',
          'DirectoryEntry',
          'ChannelCredential',
          'JwtCredential',
          'SourceAuthCredential',
          'PortalIdentityCredential',
          'LocalCredential',
          'SurfaceAuthCredential',
        ],
      },
      {
        from: 'schema/session-v1.json',
        defs: [
          'JsonValue',
          'ContentBlock',
          'Actor',
          'SurfaceOp',
          'EventEnvelope',
          'BudgetState',
          'ArtifactRef',
          'ArtifactJob',
          'Billing',
        ],
      },
      {
        from: 'schema/extension-service.json',
        defs: [
          'ExtensionCallParams',
          'ExtensionCallResult',
          'ExtensionAckParams',
          'ExtensionCallError',
          'ServiceCapability',
        ],
      },
      { from: 'schema/jobs.json', defs: ['Schedule', 'JobSpec', 'JobStatus'] },
      // SessionSetModelParams.slot reuses the one closed SlotName enum (model.json) rather than
      // retyping the seven-value set a second time.
      { from: 'schema/model.json', defs: ['SlotName', 'ThinkingLevel', 'TokenCounts'] },
    ],
  },
  { schema: 'schema/acp/schema.json', out: 'gen/ts/acp.ts', module: 'Acp' },
  {
    schema: 'schema/model.json',
    out: 'gen/ts/model.ts',
    module: 'ModelV1',
    imports: [
      {
        from: 'schema/session-v1.json',
        defs: [
          'JsonValue',
          'ContentBlock',
          'ResolvedToolCallPolicy',
          'ExecutionDomain',
          'ToolCall',
          'Billing',
        ],
      },
    ],
  },
  {
    schema: 'schema/tooldef.json',
    out: 'gen/ts/tooldef.ts',
    module: 'ToolDefSchema',
    imports: [{ from: 'schema/session-v1.json', defs: ['JsonValue'] }],
  },
  {
    schema: 'schema/hooks.json',
    out: 'gen/ts/hooks.ts',
    module: 'HooksSchema',
    imports: [
      {
        from: 'schema/session-v1.json',
        defs: [
          'JsonValue',
          'Actor',
          'ContentBlock',
          'ToolResult',
          'PlanItems',
          'Verdict',
          'ResolvedToolCallPolicy',
          'ExecutionDomain',
        ],
      },
      { from: 'schema/tooldef.json', defs: ['ToolMeta'] },
    ],
  },
  {
    schema: 'schema/preset.json',
    out: 'gen/ts/preset.ts',
    module: 'PresetSchema',
    imports: [
      { from: 'schema/model.json', defs: ['RouteTable', 'RouteTarget', 'ThinkingLevel'] },
      { from: 'schema/hooks.json', defs: ['HookEvent'] },
    ],
  },
  {
    schema: 'schema/projection.json',
    out: 'gen/ts/projection.ts',
    module: 'ProjectionSchema',
    imports: [{ from: 'schema/session-v1.json', defs: ['JsonValue'] }],
  },
  {
    schema: 'schema/extension-service.json',
    out: 'gen/ts/extension-service.ts',
    module: 'ExtensionServiceSchema',
    imports: [
      { from: 'schema/session-v1.json', defs: ['JsonValue'] },
      { from: 'schema/tooldef.json', defs: ['ParametersSchema'] },
    ],
  },
  { schema: 'schema/slots.json', out: 'gen/ts/slots.ts', module: 'SlotsSchema' },
  {
    schema: 'schema/surface.json',
    out: 'gen/ts/surface.ts',
    module: 'SurfaceSchema',
    imports: [{ from: 'schema/profile.json', defs: ['SecretRef'] }],
  },
  {
    schema: 'schema/profile.json',
    out: 'gen/ts/profile.ts',
    module: 'ProfileSchema',
    imports: [
      {
        from: 'schema/model.json',
        defs: ['RouteDecl', 'ModelRecord', 'ModelCost', 'DecodeRule', 'SlotName'],
      },
      { from: 'schema/session-v1.json', defs: ['JsonValue'] },
    ],
  },
  {
    schema: 'schema/extension-manifest.json',
    out: 'gen/ts/extension-manifest.ts',
    module: 'ExtensionManifestSchema',
    imports: [
      { from: 'schema/hooks.json', defs: ['HookEvent'] },
      { from: 'schema/slots.json', defs: ['UiSlotName'] },
      { from: 'schema/profile.json', defs: ['SeamName'] },
      { from: 'schema/projection.json', defs: ['ProjectionCapability'] },
      { from: 'schema/extension-service.json', defs: ['ServiceCapability'] },
      { from: 'schema/tooldef.json', defs: ['ParametersSchema'] },
      { from: 'schema/session-v1.json', defs: ['JsonValue'] },
    ],
  },
  {
    schema: 'schema/lockfile.json',
    out: 'gen/ts/lockfile.ts',
    module: 'LockfileSchema',
    imports: [
      { from: 'schema/package-admin.json', defs: ['PackageContributionSummary', 'PackageTrustDecision'] },
      { from: 'schema/surface.json', defs: ['SurfaceDescriptor', 'SurfaceArtifact', 'SurfaceServiceGrant'] },
      {
        from: 'schema/extension-manifest.json',
        defs: ['Capabilities', 'ClientContribution', 'SkinContribution', 'SkinTokenValue'],
      },
      { from: 'schema/hooks.json', defs: ['HookEvent'] },
      { from: 'schema/slots.json', defs: ['UiSlotName'] },
      { from: 'schema/profile.json', defs: ['SeamName', 'Capability'] },
      { from: 'schema/projection.json', defs: ['ProjectionCapability'] },
      { from: 'schema/extension-service.json', defs: ['ServiceCapability'] },
      { from: 'schema/tooldef.json', defs: ['ParametersSchema'] },
      { from: 'schema/session-v1.json', defs: ['JsonValue'] },
    ],
  },
  { schema: 'schema/deploy-manifest.json', out: 'gen/ts/deploy-manifest.ts', module: 'DeployManifestSchema' },
  {
    schema: 'schema/jobs.json',
    out: 'gen/ts/jobs.ts',
    module: 'JobsSchema',
    imports: [{ from: 'schema/session-v1.json', defs: ['JsonValue', 'ContentBlock'] }],
  },
  {
    schema: 'schema/authz.json',
    out: 'gen/ts/authz.ts',
    module: 'AuthzSchema',
    imports: [{ from: 'schema/session-v1.json', defs: ['Actor'] }],
  },
  { schema: 'schema/channel.json', out: 'gen/ts/channel.ts', module: 'ChannelSchema' },
  {
    schema: 'schema/bridge.json',
    out: 'gen/ts/bridge.ts',
    module: 'BridgeSchema',
    imports: [{ from: 'schema/session-v1.json', defs: ['JsonValue'] }],
  },
]

// agnes-v1.json reuses session-v1's definitions through cross-file `$ref`s
// (`session-v1.json#/$defs/JsonValue` and `.../ContentBlock`), but `refName()` in tools/gen-core.ts
// only recognises the same-file pointer shape `#/$defs/X` — the generator does not resolve cross-file
// $refs. Rather than teach it cross-file resolution (a much larger change that would also have to
// handle the general case, circular references and all, when the only need here is referencing a
// definition inside a sibling document), the document is pre-processed before being handed to
// `generateModule`: every definition named in `imports.defs` is copied wholesale from the source file
// into the target document's `$defs` (overwriting any same-named placeholder entry), then every
// `$ref` of the form `"<file>.json#/..."` in the document is rewritten to a local `"#/..."` pointer.
// The rewritten document is, in memory, a fully self-contained 2020-12 document with only local
// `#/$defs/...` pointers, so `generateModule` never has to know cross-file refs exist.
// On disk, `schema/agnes-v1.json` keeps the original cross-file `$ref` spelling — more honest to a
// human reader and to external ajv validation, since it really is referencing session-v1.json. Only
// the in-memory copy fed to the generator is rewritten.
function inlineImports(doc: JsonSchemaDoc, imports: ImportSpec[] | undefined): JsonSchemaDoc {
  if (!imports || imports.length === 0) return doc
  const merged = structuredClone(doc)
  merged.$defs = { ...(merged.$defs ?? {}) }
  // Several sources, applied in order: hooks.json borrows shapes from both session-v1.json and
  // tooldef.json. A name copied twice takes the last spelling, which is why the order in TARGETS is
  // the order a reader should read them in.
  for (const spec of imports) {
    const source = JSON.parse(readFileSync(join(pkg, spec.from), 'utf8')) as JsonSchemaDoc
    for (const name of spec.defs) merged.$defs[name] = source.$defs?.[name] as Record<string, unknown>
  }
  const rewrite = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(rewrite)
    else if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>
      if (typeof obj.$ref === 'string') obj.$ref = obj.$ref.replace(/^[a-z0-9-]+\.json#/, '#')
      for (const v of Object.values(obj)) rewrite(v)
    }
  }
  rewrite(merged)
  return merged
}

const check = process.argv.includes('--check')
let dirty = 0
for (const t of TARGETS) {
  const schemaPath = join(pkg, t.schema)
  if (!existsSync(schemaPath)) continue
  const doc = inlineImports(JSON.parse(readFileSync(schemaPath, 'utf8')) as JsonSchemaDoc, t.imports)
  // UNSUPPORTED_NODES keys are repo-root-relative paths (the same granularity as the exemption lists
  // in tools/guards). `pkg` is the absolute path to packages/protocol, so prefixing the fixed segment
  // is enough — no need to resolve the repo root a second time.
  const src = generateModule(doc, t.module, `packages/protocol/${t.schema}`)
  const outPath = join(pkg, t.out)
  const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''
  if (current === src) continue
  if (check) {
    console.error(`stale: ${t.out}`)
    dirty++
    continue
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, src)
  console.log(`wrote ${t.out}`)
}
// The three generated Markdown pages are part of the same contract as the generated modules: a
// stale page is as wrong as a stale module, and it is the only place the declaration tables are
// readable as prose.
dirty += writeDocs(check)
if (check && dirty) process.exit(1)
