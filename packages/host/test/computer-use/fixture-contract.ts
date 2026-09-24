import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { type TSchema, Type } from '@sinclair/typebox'
import { Ajv2020 } from 'ajv/dist/2020.js'

const NonEmpty = Type.String({ minLength: 1, pattern: '^\\S(?:.*\\S)?$' })
const Sha256 = Type.String({ pattern: '^[a-f0-9]{64}$' })
const Commit = Type.String({ pattern: '^[a-f0-9]{40}$' })
const JsonSchema = Type.Object(
  {
    type: Type.Literal('object'),
    properties: Type.Record(Type.String(), Type.Unknown()),
    required: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
    additionalProperties: Type.Boolean(),
  },
  { additionalProperties: true },
)

const Tool = Type.Object(
  {
    name: NonEmpty,
    capabilities: Type.Array(NonEmpty, { uniqueItems: true }),
    inputSchema: JsonSchema,
  },
  { additionalProperties: false },
)

export const legacyCatalogFixtureSchema = Type.Object(
  {
    format: Type.Literal('normalized-selected-tools-list-v1'),
    contract_epoch: Type.Literal('cua-driver-0.9'),
    observed_reported_version: Type.Literal('0.8.3'),
    capability_version: Type.Literal('1'),
    observed_tool_count: Type.Integer({ minimum: 1 }),
    tools: Type.Array(Tool, { minItems: 1 }),
  },
  { additionalProperties: false },
)

const LegacyPermissionMode = Type.Union([Type.Literal('standard'), Type.Literal('unrestricted')])

/**
 * This is deliberately a source-test behavior table, not a cua-driver manifest, MCP envelope, or
 * parser fixture.  The fixed Hermes 0.10 test file has direct permission-mode assertions but does
 * not retain any driver bytes that could truthfully populate one of those fixture categories.
 */
export const legacyPermissionModeBehaviorFixtureSchema = Type.Object(
  {
    format: Type.Literal('normalized-hermes-permission-mode-behavior-v1'),
    contract_epoch: Type.Literal('cua-driver-0.10'),
    evidence_kind: Type.Literal('source-test-behavior'),
    cases: Type.Array(
      Type.Object(
        {
          id: NonEmpty,
          sessionApprovalBypass: Type.Boolean(),
          gatewayApprovalBypass: Type.Boolean(),
          expectedMode: LegacyPermissionMode,
        },
        { additionalProperties: false },
      ),
      { minItems: 4, maxItems: 4 },
    ),
  },
  { additionalProperties: false },
)

const LockedSource = Type.Object(
  {
    repository: Type.Literal('https://github.com/trycua/cua'),
    tag: Type.Literal('cua-driver-rs-v0.28.1'),
    commit: Type.Literal('d8028a7943087ee258dc1b4d19dc12a7cd27669c'),
  },
  { additionalProperties: false },
)

export const lockedManifestFixtureSchema = Type.Object(
  {
    format: Type.Literal('normalized-driver-manifest-v1'),
    source: LockedSource,
    schema_version: Type.Literal('1'),
    binary_version: Type.Literal('0.28.1'),
    mcp_invocation: Type.Object(
      { command: NonEmpty, args: Type.Array(NonEmpty, { minItems: 1 }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
)

export const lockedCatalogFixtureSchema = Type.Object(
  {
    format: Type.Literal('normalized-tools-list-v1'),
    source: LockedSource,
    capability_version: Type.Literal('1'),
    observed_tool_count: Type.Integer({ minimum: 1 }),
    tools: Type.Array(Tool, { minItems: 1 }),
  },
  { additionalProperties: false },
)

const ContentBlock = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: Type.String() }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal('image'),
      mimeType: Type.Union([Type.Literal('image/png'), Type.Literal('image/jpeg')]),
      sha256: Sha256,
      decodedBytes: Type.Integer({ minimum: 1 }),
      width: Type.Integer({ minimum: 1 }),
      height: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  ),
])

export const lockedResultFixtureSchema = Type.Object(
  {
    format: Type.Literal('normalized-tool-result-v1'),
    source: LockedSource,
    tool: NonEmpty,
    isError: Type.Boolean(),
    structuredContent: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    content: Type.Array(ContentBlock, { minItems: 1 }),
  },
  { additionalProperties: false },
)

export const lockedSomFixtureSchema = Type.Object(
  {
    format: Type.Literal('normalized-som-capture-v1'),
    source: LockedSource,
    image: Type.Object(
      {
        mimeType: Type.Union([Type.Literal('image/png'), Type.Literal('image/jpeg')]),
        sha256: Sha256,
        decodedBytes: Type.Integer({ minimum: 1 }),
        width: Type.Integer({ minimum: 8 }),
        height: Type.Integer({ minimum: 8 }),
      },
      { additionalProperties: false },
    ),
    // The fixed design keeps the index separate from screenshot bytes; no overlay claim is inferred.
    elements: Type.Array(
      Type.Object(
        {
          index: Type.Integer({ minimum: 0 }),
          role: NonEmpty,
          label: Type.String({ maxLength: 120 }),
          bounds: Type.Union([
            Type.Null(),
            Type.Object(
              {
                x: Type.Number(),
                y: Type.Number(),
                width: Type.Number({ exclusiveMinimum: 0 }),
                height: Type.Number({ exclusiveMinimum: 0 }),
              },
              { additionalProperties: false },
            ),
          ]),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 100 },
    ),
  },
  { additionalProperties: false },
)

export const lockedDoctorFixtureSchema = Type.Object(
  {
    format: Type.Literal('normalized-health-report-v1'),
    source: LockedSource,
    schema_version: Type.Literal('1'),
    platform: NonEmpty,
    overall: Type.Union([Type.Literal('ok'), Type.Literal('warning'), Type.Literal('error')]),
    checks: Type.Array(
      Type.Object(
        {
          id: NonEmpty,
          status: Type.Union([
            Type.Literal('pass'),
            Type.Literal('warn'),
            Type.Literal('fail'),
            Type.Literal('skip'),
          ]),
          message: Type.String(),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
)

const MissingMatrixEntry = Type.Object(
  {
    id: NonEmpty,
    contractEpoch: NonEmpty,
    kind: Type.Union([
      Type.Literal('manifest'),
      Type.Literal('catalog'),
      Type.Literal('result'),
      Type.Literal('som'),
      Type.Literal('doctor'),
      Type.Literal('legacyCompatibility'),
    ]),
    status: Type.Literal('missing'),
    blocker: NonEmpty,
  },
  { additionalProperties: false },
)

const VerifiedMatrixEntry = Type.Object(
  {
    id: NonEmpty,
    contractEpoch: NonEmpty,
    kind: Type.Union([
      Type.Literal('manifest'),
      Type.Literal('catalog'),
      Type.Literal('result'),
      Type.Literal('som'),
      Type.Literal('doctor'),
      Type.Literal('legacyCompatibility'),
    ]),
    status: Type.Literal('verified'),
    fixturePath: Type.String({
      pattern: '^packages/host/test/computer-use/fixtures/(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._/-]*$',
    }),
    sha256: Sha256,
    provenance: Type.Union([
      Type.Object(
        {
          kind: Type.Literal('source-behavior'),
          repository: Type.Literal('https://github.com/NousResearch/hermes-agent.git'),
          commit: Commit,
          sourcePath: NonEmpty,
          sourceSha256: Sha256,
          normalization: NonEmpty,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal('source-fixture'),
          repository: Type.Literal('https://github.com/NousResearch/hermes-agent.git'),
          commit: Commit,
          sourcePath: NonEmpty,
          sourceSha256: Sha256,
          normalization: NonEmpty,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal('driver-capture'),
          repository: Type.Literal('https://github.com/trycua/cua'),
          tag: Type.Literal('cua-driver-rs-v0.28.1'),
          commit: Type.Literal('d8028a7943087ee258dc1b4d19dc12a7cd27669c'),
          platform: Type.Union([
            Type.Literal('darwin'),
            Type.Literal('win32'),
            Type.Literal('linux-x11'),
            Type.Literal('linux-wayland'),
          ]),
          capturedAt: NonEmpty,
          sanitization: NonEmpty,
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
)

export const fixtureMatrixSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    entries: Type.Array(Type.Union([MissingMatrixEntry, VerifiedMatrixEntry]), { minItems: 1 }),
  },
  { additionalProperties: false },
)

type Requirement = {
  contractEpoch: string
  kind: string
  provenanceKind: 'source-fixture' | 'source-behavior' | 'driver-capture'
  fixturePath: string
  fixtureSha256: string | null
  source?: {
    commit: string
    sourcePath: string
    sourceSha256: string
    normalization: string
  }
}

const REQUIREMENTS = {
  'legacy-0.9-selected-catalog': {
    contractEpoch: 'cua-driver-0.9',
    kind: 'legacyCompatibility',
    provenanceKind: 'source-fixture',
    fixturePath: 'packages/host/test/computer-use/fixtures/0.9/catalog.selected.json',
    fixtureSha256: 'bc2651301b1b0774d8003de14c1a56a79cb97a19478957ee7c9b826f996875ca',
    source: {
      commit: 'fb56a7e06dde62e9f645ff744c82cb47b60c469e',
      sourcePath: 'tests/fixtures/cua_driver_0_9_tools_list.json',
      sourceSha256: '21d770a0ea9c6547b7ec805b20f6261897f29e0e92475cc5e241f9eaf9121db2',
      normalization: 'JSON whitespace only via repository formatter; keys and values unchanged.',
    },
  },
  'legacy-0.10-permission-mode-behavior': {
    contractEpoch: 'cua-driver-0.10',
    kind: 'legacyCompatibility',
    provenanceKind: 'source-behavior',
    fixturePath: 'packages/host/test/computer-use/fixtures/0.10/permission-mode.behavior.json',
    fixtureSha256: '3df83bbb1ed4df247e3a1015f1bf7a3b39320a7c0e712fc8a3dc57f592ee796a',
    source: {
      commit: 'fb56a7e06dde62e9f645ff744c82cb47b60c469e',
      sourcePath: 'tests/tools/test_computer_use_cua_0_10_permissions.py',
      sourceSha256: '3aef215baa5308055400bad5177ddd0d88c692978a970e78b68f4fe3bc971b7a',
      normalization:
        'Reviewed semantic extraction of the four direct mode-resolution assertions only; no driver/MCP bytes are represented.',
    },
  },
  'locked-0.28.1-manifest': lockedRequirement(
    'manifest',
    'manifest.json',
    '0190a6f05ab24e968e141d3a247c3c8336d327d9cbb46e7cc943c3f4b41d2c27',
  ),
  'locked-0.28.1-catalog': lockedRequirement(
    'catalog',
    'catalog.json',
    '5fb395a2b94c6a28cf7b7680f2bef2838d46952cfc187edff9c36621a425b6ef',
  ),
  'locked-0.28.1-result': lockedRequirement(
    'result',
    'result.json',
    'e4d3d6cdabb775d85b4187bd342162e1cbf339c4261ff2c3e70eea6529fb25da',
  ),
  'locked-0.28.1-som': lockedRequirement('som', 'som.json'),
  'locked-0.28.1-doctor': lockedRequirement(
    'doctor',
    'doctor.json',
    '7179d3ba639ffdc855b60020fed7946fe22f3c4403acaf5fa02e2f5ff6fd8d0f',
  ),
} as const satisfies Record<string, Requirement>

function lockedRequirement(kind: string, filename: string, fixtureSha256: string | null = null): Requirement {
  return {
    contractEpoch: 'cua-driver-0.28.1',
    kind,
    provenanceKind: 'driver-capture',
    fixturePath: `packages/host/test/computer-use/fixtures/0.28.1/${filename}`,
    // This must be populated by reviewed capture bytes, never by the matrix row being validated.
    fixtureSha256,
  }
}

type TrustedCatalogBinding = {
  sha256: string
  observedToolCount: number
  names: readonly string[]
}

const TRUSTED_CATALOG_BINDINGS: Record<string, TrustedCatalogBinding | null> = {
  'legacy-0.9-selected-catalog': {
    sha256: 'bc2651301b1b0774d8003de14c1a56a79cb97a19478957ee7c9b826f996875ca',
    observedToolCount: 49,
    names: [
      'bring_to_front',
      'browser_click',
      'browser_dialog',
      'browser_download',
      'browser_navigate',
      'browser_pointer',
      'browser_prepare',
      'browser_set_input_files',
      'browser_type',
      'click',
      'get_browser_state',
      'type_text',
    ],
  },
  'locked-0.28.1-catalog': {
    sha256: '5fb395a2b94c6a28cf7b7680f2bef2838d46952cfc187edff9c36621a425b6ef',
    observedToolCount: 57,
    names: [
      'list_apps',
      'list_windows',
      'get_window_state',
      'verify_state',
      'launch_app',
      'kill_app',
      'bring_to_front',
      'set_window_frame',
      'invoke_menu',
      'debug_window_info',
      'click',
      'double_click',
      'right_click',
      'drag',
      'type_text',
      'press_key',
      'hotkey',
      'set_value',
      'scroll',
      'clipboard_read',
      'clipboard_write',
      'get_screen_size',
      'get_desktop_state',
      'get_cursor_position',
      'move_cursor',
      'set_agent_cursor_enabled',
      'set_agent_cursor_motion',
      'get_agent_cursor_state',
      'set_agent_cursor_theme',
      'check_permissions',
      'health_report',
      'get_config',
      'set_config',
      'get_accessibility_tree',
      'zoom',
      'page',
      'get_browser_state',
      'browser_prepare',
      'browser_navigate',
      'browser_click',
      'browser_type',
      'browser_dialog',
      'browser_set_input_files',
      'browser_download',
      'browser_pointer',
      'start_recording',
      'stop_recording',
      'get_recording_state',
      'replay_trajectory',
      'install_ffmpeg',
      'start_session',
      'escalate_session',
      'get_session',
      'list_sessions',
      'get_session_state',
      'end_session',
      'check_for_update',
    ],
  },
}

const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: false })
const validators = new Map<TSchema, ReturnType<typeof ajv.compile>>()

export type FixtureInspection = { ok: true } | { ok: false; issues: string[] }

export function inspectFixture(schema: TSchema, value: unknown): FixtureInspection {
  let validate = validators.get(schema)
  if (validate === undefined) {
    validate = ajv.compile(schema)
    validators.set(schema, validate)
  }
  if (validate(value)) return { ok: true }
  return {
    ok: false,
    issues: (validate.errors ?? []).map(
      (error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
    ),
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function readVerifiedFixture(root: string, fixturePath: string, expectedSha256: string): unknown {
  const absoluteRoot = resolve(root)
  const fixtureRoot = resolve(root, 'packages/host/test/computer-use/fixtures')
  const absolutePath = resolve(root, fixturePath)
  const withinRoot = relative(absoluteRoot, absolutePath)
  const withinFixtures = relative(fixtureRoot, absolutePath)
  if (
    isAbsolute(withinRoot) ||
    withinRoot === '..' ||
    withinRoot.startsWith(`..${sep}`) ||
    isAbsolute(withinFixtures) ||
    withinFixtures === '..' ||
    withinFixtures.startsWith(`..${sep}`)
  )
    throw new Error(`fixture path escapes repository: ${fixturePath}`)
  const canonicalPath = realpathSync(absolutePath)
  const canonicalFixtureRoot = realpathSync(fixtureRoot)
  const canonicalRelative = relative(canonicalFixtureRoot, canonicalPath)
  if (isAbsolute(canonicalRelative) || canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`))
    throw new Error(`fixture symlink escapes fixture root: ${fixturePath}`)
  const bytes = readFileSync(canonicalPath)
  const actualSha256 = sha256(bytes)
  if (actualSha256 !== expectedSha256)
    throw new Error(`fixture digest mismatch: expected ${expectedSha256}, received ${actualSha256}`)
  return JSON.parse(bytes.toString('utf8')) as unknown
}

export function sensitiveFixtureStrings(
  value: unknown,
  options: { scanFieldNames?: boolean } = {},
): string[] {
  const issues = new Set<string>()
  const scanFieldNames = options.scanFieldNames ?? true
  const forbiddenFields = new Set([
    'accesstoken',
    'refreshtoken',
    'authtoken',
    'apikey',
    'authorization',
    'cookie',
    'credential',
    'credentials',
    'password',
    'secret',
    'session',
    'sessionid',
    'sessionkey',
    'sessiontoken',
  ])
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      if (approvedPlaceholder(node)) return
      if (/\/(?:Users|home)\/[^/\s]+(?:\/|$)/i.test(node) || /(?:^|\s)\/root(?:\/|$)/i.test(node))
        issues.add(`posix-home:${path}`)
      if (/\\Users\\[^\\\s]+(?:\\|$)/i.test(node)) issues.add(`windows-home:${path}`)
      if (/\bfile:\/\//i.test(node)) issues.add(`file-uri:${path}`)
      if (/\bhttps?:\/\//i.test(node)) issues.add(`url:${path}`)
      if (/\blocalhost\b/i.test(node)) issues.add(`localhost:${path}`)
      if (/\bBearer\s+\S+/i.test(node)) issues.add(`credential-value:${path}`)
      if (/\btoken[-_:][A-Za-z0-9]/i.test(node)) issues.add(`token-value:${path}`)
      if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(node)) issues.add(`email:${path}`)
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        walk(item, `${path}[${index}]`)
      })
      return
    }
    if (typeof node !== 'object' || node === null) return
    for (const [key, child] of Object.entries(node)) {
      const childPath = path.length === 0 ? key : `${path}.${key}`
      const normalizedKey = key.replaceAll(/[-_]/g, '').toLowerCase()
      if (scanFieldNames && forbiddenFields.has(normalizedKey) && !approvedPlaceholder(child))
        issues.add(`sensitive-field:${childPath}`)
      walk(child, childPath)
    }
  }
  walk(value, '')
  return [...issues]
}

function approvedPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return (
    /^(?:<redacted>|\[redacted\]|redacted|none|not-captured)$/i.test(value) ||
    /^[A-Z0-9._%+-]+@example\.invalid$/i.test(value) ||
    /^https?:\/\/example\.invalid(?:\/[A-Z0-9._~!$&'()*+,;=:@%/-]*)?$/i.test(value)
  )
}

export function semanticFixtureIssues(kind: string, value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return ['fixture:not-object']
  const fixture = value as Record<string, unknown>
  const { source: _lockedPublicSource, ...capturedState } = fixture
  const issues = sensitiveFixtureStrings(capturedState, {
    // Legacy/catalog JSON schemas legitimately describe a property named `session`; they contain no
    // captured values. Other fixture kinds reject all credential/session-bearing field names.
    scanFieldNames: kind !== 'catalog' && kind !== 'legacyCompatibility',
  }).map((finding) => `fixture:sensitive:${finding}`)
  if (kind === 'catalog' || kind === 'legacyCompatibility') {
    const tools = Array.isArray(fixture.tools) ? fixture.tools : []
    const names = tools.map((tool) =>
      typeof tool === 'object' && tool !== null ? String((tool as Record<string, unknown>).name) : '',
    )
    if (new Set(names).size !== names.length) issues.push('fixture:catalog:duplicate-tool')
    const observed = fixture.observed_tool_count
    if (typeof observed === 'number') {
      if (observed < tools.length) issues.push('fixture:catalog:observed-count-underflow')
      if (kind === 'catalog' && observed !== tools.length) issues.push('fixture:catalog:count-mismatch')
    }
  }
  if (kind === 'result') {
    const content = Array.isArray(fixture.content) ? fixture.content : []
    const hasTextFallback = content.some(
      (block) =>
        typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'text',
    )
    if (fixture.structuredContent === undefined && !hasTextFallback)
      issues.push('fixture:result:missing-structured-or-text-fallback')
  }
  if (kind === 'som') {
    const elements = Array.isArray(fixture.elements) ? fixture.elements : []
    const indexes = elements.map((element) =>
      typeof element === 'object' && element !== null
        ? (element as Record<string, unknown>).index
        : undefined,
    )
    if (new Set(indexes).size !== indexes.length) issues.push('fixture:som:duplicate-index')
  }
  if (kind === 'doctor') {
    const checks = Array.isArray(fixture.checks) ? fixture.checks : []
    const ids = checks.map((check) =>
      typeof check === 'object' && check !== null ? (check as Record<string, unknown>).id : undefined,
    )
    if (new Set(ids).size !== ids.length) issues.push('fixture:doctor:duplicate-check')
  }
  return issues
}

type FixtureMatrixEntry =
  | {
      id: string
      contractEpoch: string
      kind: string
      status: 'missing'
      blocker: string
    }
  | {
      id: string
      contractEpoch: string
      kind: string
      status: 'verified'
      fixturePath: string
      sha256: string
      provenance:
        | {
            kind: 'source-fixture'
            repository: string
            commit: string
            sourcePath: string
            sourceSha256: string
            normalization: string
          }
        | {
            kind: 'source-behavior'
            repository: string
            commit: string
            sourcePath: string
            sourceSha256: string
            normalization: string
          }
        | {
            kind: 'driver-capture'
            repository: string
            tag: string
            commit: string
            platform: string
            capturedAt: string
            sanitization: string
          }
    }

export type FixtureMatrixDecision = {
  ready: boolean
  verified: string[]
  blockers: string[]
}

/** Test-only P0 evidence harness. A green result never admits or launches a production driver. */
export function evaluateComputerUseFixtureMatrix(value: unknown, root: string): FixtureMatrixDecision {
  const inspected = inspectFixture(fixtureMatrixSchema, value)
  if (!inspected.ok)
    return {
      ready: false,
      verified: [],
      blockers: inspected.issues.map((issue) => `matrix:schema:${issue}`),
    }

  const entries = (value as { entries: FixtureMatrixEntry[] }).entries
  const blockers: string[] = []
  const verified: string[] = []
  const ids = new Set<string>()
  const fixturePaths = new Set<string>()
  const fixtureDigests = new Set<string>()
  const provenanceIdentities = new Set<string>()
  for (const entry of entries) {
    const entryBlockerStart = blockers.length
    if (ids.has(entry.id)) blockers.push(`matrix:duplicate-id:${entry.id}`)
    ids.add(entry.id)
    const requirement = REQUIREMENTS[entry.id as keyof typeof REQUIREMENTS] as Requirement | undefined
    if (requirement === undefined) {
      blockers.push(`matrix:unknown-id:${entry.id}`)
      continue
    }
    if (entry.contractEpoch !== requirement.contractEpoch || entry.kind !== requirement.kind)
      blockers.push(`matrix:tuple-mismatch:${entry.id}`)
    if (entry.status === 'missing') {
      blockers.push(`fixture:${entry.id}:missing:${entry.blocker}`)
      continue
    }
    if (entry.fixturePath !== requirement.fixturePath) blockers.push(`fixture:${entry.id}:path-mismatch`)
    if (requirement.fixtureSha256 === null) blockers.push(`fixture:${entry.id}:trusted-digest-missing`)
    else if (entry.sha256 !== requirement.fixtureSha256)
      blockers.push(`fixture:${entry.id}:trusted-digest-mismatch`)
    if (fixturePaths.has(entry.fixturePath)) blockers.push(`matrix:fixture-path-reused:${entry.fixturePath}`)
    fixturePaths.add(entry.fixturePath)
    if (fixtureDigests.has(entry.sha256)) blockers.push(`matrix:fixture-digest-reused:${entry.sha256}`)
    fixtureDigests.add(entry.sha256)
    const provenanceIdentity = provenanceKey(entry.provenance)
    if (provenanceIdentities.has(provenanceIdentity))
      blockers.push(`matrix:provenance-identity-reused:${provenanceIdentity}`)
    provenanceIdentities.add(provenanceIdentity)
    blockers.push(...provenanceIssues(entry.id, entry.provenance, requirement))
    try {
      const fixture = readVerifiedFixture(root, entry.fixturePath, entry.sha256)
      const schema = fixtureSchema(entry)
      const fixtureInspection = inspectFixture(schema, fixture)
      if (!fixtureInspection.ok) {
        blockers.push(...fixtureInspection.issues.map((issue) => `fixture:${entry.id}:schema:${issue}`))
        continue
      }
      const semanticIssues = semanticFixtureIssues(entry.kind, fixture)
      if (semanticIssues.length > 0) {
        blockers.push(...semanticIssues.map((issue) => `fixture:${entry.id}:${issue}`))
        continue
      }
      const catalogIssues = trustedCatalogIssues(entry.id, fixture, entry.sha256)
      if (catalogIssues.length > 0) {
        blockers.push(...catalogIssues)
        continue
      }
      if (blockers.length === entryBlockerStart) verified.push(entry.id)
    } catch (error) {
      blockers.push(`fixture:${entry.id}:${error instanceof Error ? error.message : String(error)}`)
    }
  }

  for (const id of Object.keys(REQUIREMENTS)) {
    if (!ids.has(id)) blockers.push(`matrix:required-entry:${id}`)
  }
  return { ready: blockers.length === 0, verified, blockers }
}

function provenanceKey(
  provenance: Extract<FixtureMatrixEntry, { status: 'verified' }>['provenance'],
): string {
  if (provenance.kind === 'source-fixture' || provenance.kind === 'source-behavior')
    return `${provenance.repository}@${provenance.commit}:${provenance.sourcePath}#${provenance.sourceSha256}`
  return `${provenance.repository}@${provenance.commit}:${provenance.tag}:${provenance.platform}:${provenance.capturedAt}`
}

function provenanceIssues(
  id: string,
  provenance: Extract<FixtureMatrixEntry, { status: 'verified' }>['provenance'],
  requirement: Requirement,
): string[] {
  const prefix = `fixture:${id}:provenance`
  if (provenance.kind !== requirement.provenanceKind) return [`${prefix}:kind-mismatch`]
  if (provenance.kind === 'source-fixture' || provenance.kind === 'source-behavior') {
    const source = requirement.source
    if (
      source === undefined ||
      provenance.repository !== 'https://github.com/NousResearch/hermes-agent.git' ||
      provenance.commit !== source.commit ||
      provenance.sourcePath !== source.sourcePath ||
      provenance.sourceSha256 !== source.sourceSha256 ||
      provenance.normalization !== source.normalization
    )
      return [`${prefix}:source-identity-mismatch`]
    return []
  }
  if (
    provenance.repository !== 'https://github.com/trycua/cua' ||
    provenance.tag !== 'cua-driver-rs-v0.28.1' ||
    provenance.commit !== 'd8028a7943087ee258dc1b4d19dc12a7cd27669c'
  )
    return [`${prefix}:release-identity-mismatch`]
  return []
}

function trustedCatalogIssues(id: string, value: unknown, fixtureSha256: string): string[] {
  const binding = TRUSTED_CATALOG_BINDINGS[id]
  if (binding === undefined) return []
  if (binding === null) return [`fixture:${id}:trusted-catalog-binding-missing`]
  const fixture = value as { observed_tool_count?: unknown; tools?: unknown }
  const names = Array.isArray(fixture.tools)
    ? fixture.tools.map((tool) =>
        typeof tool === 'object' && tool !== null ? String((tool as Record<string, unknown>).name) : '',
      )
    : []
  if (
    fixtureSha256 !== binding.sha256 ||
    fixture.observed_tool_count !== binding.observedToolCount ||
    JSON.stringify(names) !== JSON.stringify(binding.names)
  )
    return [`fixture:${id}:trusted-catalog-binding-mismatch`]
  return []
}

function fixtureSchema(entry: { contractEpoch: string; kind: string }): TSchema {
  if (entry.contractEpoch === 'cua-driver-0.9' && entry.kind === 'legacyCompatibility')
    return legacyCatalogFixtureSchema
  if (entry.contractEpoch === 'cua-driver-0.10' && entry.kind === 'legacyCompatibility')
    return legacyPermissionModeBehaviorFixtureSchema
  if (entry.contractEpoch === 'cua-driver-0.28.1') {
    if (entry.kind === 'manifest') return lockedManifestFixtureSchema
    if (entry.kind === 'catalog') return lockedCatalogFixtureSchema
    if (entry.kind === 'result') return lockedResultFixtureSchema
    if (entry.kind === 'som') return lockedSomFixtureSchema
    if (entry.kind === 'doctor') return lockedDoctorFixtureSchema
  }
  return Type.Never()
}
