import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { referenceConfigPorts } from '../../../../examples/runtime-reference/src/providers/config.ts'
import {
  type ConfigConformanceBinding,
  type ConfigScenarioEvidence,
  type ConfigSourcePort,
  registerConfigContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/config.ts'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import {
  CONFIG_CONTRACT,
  CONFIG_PACKAGE,
  CONFIG_PROVIDER_ID,
  documentDigest,
} from '../../../../packages/host/src/runtime/config/config-digest.ts'
import { readPinnedConfigDocument } from '../../../../packages/host/src/runtime/config/host-read.ts'
import {
  type ConfigProvider,
  createFetchConfigProvider,
  createFileConfigProvider,
  createSchemaCatalog,
  type FetchConfigSource,
  type FileConfigSource,
  type SchemaCatalog,
  type SchemaRef,
} from '../../../../packages/host/src/runtime/providers/config.ts'
import { getConformanceBuildIdentity } from '../build-identity.js'

const PROFILE_SCHEMA = 'https://agnes.ai/schema/runtime/v1/profile.schema.json'
const PRESET_SCHEMA = 'https://agnes.ai/schema/runtime/v1/preset.schema.json'
const PARAMETER_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    meta: {
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a'],
    },
  },
  required: ['name'],
}

type Profile = Record<string, unknown>
type Preset = Record<string, unknown>
type Recipe = 'file' | 'fetch'

function schemaRef(document: unknown, typeId: string): SchemaRef {
  return { typeId, revision: 1, digest: documentDigest(document) }
}

const parameterSchemaRef = schemaRef(PARAMETER_SCHEMA, 'acme.config/session@1')

function policy(): Record<string, unknown> {
  return {
    capabilityCeiling: [],
    minimumRecovery: 'R0',
    allowedIsolation: ['trusted-in-process'],
    sourcePolicy: { allowLocal: false, npmRegistries: [], gitOrigins: [], allowBuildScripts: false },
    grants: [
      {
        provider: { packageId: 'agnes-host', providerId: 'agh.default/config' },
        decision: 'ask',
        capabilities: [],
        resourceScopes: [],
      },
    ],
  }
}

function packageRow(enabled: boolean): Record<string, unknown> {
  return {
    id: 'tools',
    source: { kind: 'local', path: '/opt/tools', packageDigest: 'd'.repeat(64) },
    manifestDigest: 'e'.repeat(64),
    enabled,
  }
}

function profile(id: string, revision: number, presetId: string, presetDigest: string): Profile {
  return {
    $schema: PROFILE_SCHEMA,
    kind: 'agh.profile',
    schemaVersion: '1.0',
    id,
    revision,
    requiredContractSet: 'agh.runtime/full-v1',
    packages: [],
    selections: [],
    providerConfigs: [],
    selectionPolicy: [],
    presets: { default: presetId, allowed: [{ presetId, digest: presetDigest }] },
    policy: policy(),
    limits: { MAX_ID_BYTES: 256 },
    client: {
      rendererSelections: [],
      requiredTargets: ['sdk'],
      shell: { packageId: 'agnes-host', contributionId: 'shell' },
      registry: { packageId: 'agnes-host', contributionId: 'registry' },
      fallbackRenderer: { packageId: 'agnes-host', contributionId: 'fallback' },
    },
    storage: { dataDir: '/var/agnes/data', cacheDir: '/var/agnes/cache' },
    overrides: { allowWorkspaceRestrictions: false, sessionParametersSchema: parameterSchemaRef },
  }
}

function preset(id: string, revision: number, value: Record<string, unknown>): Preset {
  return {
    $schema: PRESET_SCHEMA,
    kind: 'agh.preset',
    schemaVersion: '1.0',
    id,
    revision,
    selections: [],
    configOverrides: [],
    parameters: { schema: parameterSchemaRef, value },
    restrictions: {
      capabilityCeiling: [],
      minimumRecovery: 'R0',
      allowedIsolation: ['trusted-in-process'],
      limits: { MAX_ID_BYTES: 256 },
    },
  }
}

function bind(sourceRef: string, revision: number, document: unknown) {
  return { source: { sourceRef, revision, digest: documentDigest(document) }, document }
}

function chain(mutate?: (documents: { parent: Profile; child: Profile }) => void) {
  const base = preset('base', 1, { name: 'base', meta: { a: 1, b: 2 } })
  const leaf = preset('leaf', 1, { name: 'leaf', meta: { a: 1, b: 3 } })
  leaf.extends = { presetId: 'base', digest: documentDigest(base) }
  const leafDigest = documentDigest(leaf)
  const parent = profile('builtin', 1, 'leaf', leafDigest)
  const child = profile('deployed', 2, 'leaf', leafDigest)
  child.extends = { profileId: 'builtin', digest: documentDigest(parent) }
  child.limits = { MAX_ID_BYTES: 128 }
  mutate?.({ parent, child })
  if (typeof child.extends === 'object' && child.extends) {
    child.extends = { profileId: parent.id, digest: documentDigest(parent) }
  }
  return {
    algorithm: 'agh.config/resolve-v1',
    defaults: { profile: bind('builtin', 1, parent), preset: bind('preset-base', 1, base) },
    profiles: [bind('deployed', 1, child)],
    presets: [bind('preset-leaf', 1, leaf)],
    managed: null,
    workspace: null,
    session: null,
  }
}

function snapshot(revision: number, name: string) {
  return { revision, schema: parameterSchemaRef, value: { name, meta: { a: revision } } }
}

function admit(): SchemaCatalog {
  const catalog = createSchemaCatalog()
  assert.equal(catalog.admitSchema(parameterSchemaRef, PARAMETER_SCHEMA), null)
  return catalog
}

type FileOpened = { provider: ConfigProvider; source: FileConfigSource; loads: () => number }
type FetchOpened = { provider: ConfigProvider; source: FetchConfigSource; loads: () => number }

function openFile(catalog: SchemaCatalog, load: (sourceRef: string) => string | null): FileOpened {
  let count = 0
  const opened = createFileConfigProvider((sourceRef) => {
    count += 1
    return load(sourceRef)
  }, catalog)
  return { provider: opened.provider, source: opened.source, loads: () => count }
}

function openFetch(
  catalog: SchemaCatalog,
  fetchSnapshot: (sourceRef: string, signal: AbortSignal) => Promise<unknown>,
): FetchOpened {
  let count = 0
  const opened = createFetchConfigProvider(async (sourceRef, signal) => {
    count += 1
    return (await fetchSnapshot(sourceRef, signal)) as {
      revision: number
      schema: SchemaRef
      value: unknown
    }
  }, catalog)
  return { provider: opened.provider, source: opened.source, loads: () => count }
}

function providerDigest(recipe: Recipe): string {
  return documentDigest({
    providerId: CONFIG_PROVIDER_ID,
    contract: CONFIG_CONTRACT,
    packageName: CONFIG_PACKAGE,
    recipe,
  })
}

function evidence(
  recipe: Recipe,
  configDigest: string,
  releaseSetDigest: string,
  detail: string,
): ConfigScenarioEvidence {
  return { passed: true, providerDigest: providerDigest(recipe), configDigest, releaseSetDigest, detail }
}

async function select(recipe: Recipe): Promise<ConfigScenarioEvidence> {
  const opened =
    recipe === 'file'
      ? openFile(createSchemaCatalog(), () => null)
      : openFetch(createSchemaCatalog(), async () => {
          throw new Error('select must not fetch')
        })
  try {
    assert.equal(opened.provider.providerId, CONFIG_PROVIDER_ID)
    assert.equal(opened.provider.contract, CONFIG_CONTRACT)
    assert.equal(opened.provider.packageName, CONFIG_PACKAGE)
    const digest = providerDigest(recipe)
    return evidence(recipe, digest, documentDigest({ selected: recipe }), CONFIG_PROVIDER_ID)
  } finally {
    opened.provider.dispose()
  }
}

async function normal(recipe: Recipe): Promise<ConfigScenarioEvidence> {
  const catalog = admit()
  const body = snapshot(1, 'pinned')
  const opened =
    recipe === 'file' ? openFile(catalog, () => JSON.stringify(body)) : openFetch(catalog, async () => body)
  const sibling =
    recipe === 'file'
      ? openFetch(catalog, async () => {
          throw new Error('resolve must not fetch')
        })
      : openFile(catalog, () => {
          throw new Error('resolve must not load')
        })
  try {
    assert.equal(await opened.source.refresh('local'), null)
    const afterAdmit = opened.loads()
    const pinned = readPinnedConfigDocument(opened.provider, 'local', 1)
    assert.equal(pinned.ok, true)
    if (!pinned.ok) return evidence(recipe, providerDigest(recipe), providerDigest(recipe), 'unread')
    assert.equal(opened.loads(), afterAdmit)
    assert.equal(pinned.result.digest, documentDigest(body.value))
    const request = chain()
    const resolved = opened.provider.resolve(request)
    const other = sibling.provider.resolve(request)
    assert.equal(opened.loads(), afterAdmit)
    assert.equal(sibling.loads(), 0)
    assert.equal(resolved.ok && other.ok, true)
    if (!resolved.ok || !other.ok)
      return evidence(recipe, pinned.result.digest, pinned.result.digest, 'unresolved')
    assert.equal(resolved.result.status, 'candidate')
    assert.equal(other.result.profileDigest, resolved.result.profileDigest)
    assert.equal(other.result.presetDigest, resolved.result.presetDigest)
    assert.equal(other.result.sourceSetDigest, resolved.result.sourceSetDigest)
    return evidence(
      recipe,
      resolved.result.profileDigest,
      resolved.result.sourceSetDigest,
      pinned.result.digest,
    )
  } finally {
    opened.provider.dispose()
    sibling.provider.dispose()
  }
}

async function deny(recipe: Recipe): Promise<ConfigScenarioEvidence> {
  const catalog = admit()
  const opened =
    recipe === 'file'
      ? openFile(catalog, () => null)
      : openFetch(catalog, async () => {
          throw new Error('deny must not fetch')
        })
  try {
    const resolved = opened.provider.resolve(
      chain(({ parent, child }) => {
        parent.packages = [packageRow(false)]
        child.packages = [packageRow(true)]
      }),
    )
    assert.equal(resolved.ok, false)
    if (resolved.ok) return evidence(recipe, providerDigest(recipe), providerDigest(recipe), 'not refused')
    assert.equal(resolved.refusal.code, 'disabled_package_revived')
    assert.equal(opened.loads(), 0)
    const digest = documentDigest({ code: resolved.refusal.code })
    return evidence(
      recipe,
      digest,
      documentDigest({ recipe, refused: resolved.refusal.code }),
      resolved.refusal.code,
    )
  } finally {
    opened.provider.dispose()
  }
}

async function cancel(recipe: Recipe): Promise<ConfigScenarioEvidence> {
  const catalog = createSchemaCatalog()
  if (recipe === 'file') {
    const opened = openFile(catalog, () => JSON.stringify(snapshot(1, 'pinned')))
    try {
      const controller = new AbortController()
      controller.abort()
      assert.equal(opened.source.refresh('local', controller.signal)?.code, 'cancelled')
      assert.equal(opened.loads(), 0)
      const read = opened.provider.read({ sourceRef: 'local', revision: null })
      assert.equal(read.ok, false)
      if (read.ok) return evidence(recipe, providerDigest(recipe), providerDigest(recipe), 'admitted')
      const digest = documentDigest({ code: 'cancelled', recipe })
      return evidence(recipe, digest, digest, 'cancelled')
    } finally {
      opened.provider.dispose()
    }
  }
  const opened = openFetch(
    catalog,
    (_sourceRef, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
  )
  try {
    const controller = new AbortController()
    const pending = opened.source.refresh('remote', controller.signal)
    controller.abort()
    assert.equal((await pending)?.code, 'cancelled')
    const read = opened.provider.read({ sourceRef: 'remote', revision: null })
    assert.equal(read.ok, false)
    const digest = documentDigest({ code: 'cancelled', recipe })
    return evidence(recipe, digest, digest, 'cancelled')
  } finally {
    opened.provider.dispose()
  }
}

async function recover(recipe: Recipe): Promise<ConfigScenarioEvidence> {
  const catalog = createSchemaCatalog()
  const body = snapshot(1, 'pinned')
  if (recipe === 'file') {
    const directory = mkdtempSync(join(tmpdir(), 'agnes-config-recover-'))
    const path = join(directory, 'local.json')
    try {
      writeFileSync(path, JSON.stringify(body))
      const first = openFile(catalog, () => readFileSync(path, 'utf8'))
      assert.equal(first.source.refresh('local'), null)
      const pinned = readPinnedConfigDocument(first.provider, 'local', 1)
      first.provider.dispose()
      assert.equal(pinned.ok, true)
      if (!pinned.ok) return evidence(recipe, providerDigest(recipe), providerDigest(recipe), 'unread')
      const second = openFile(catalog, () => readFileSync(path, 'utf8'))
      try {
        assert.equal(second.source.refresh('local'), null)
        const restored = readPinnedConfigDocument(second.provider, 'local', 1)
        assert.equal(restored.ok, true)
        if (!restored.ok) return evidence(recipe, pinned.result.digest, pinned.result.digest, 'unrestored')
        assert.equal(restored.result.digest, pinned.result.digest)
        assert.equal(restored.result.digest, documentDigest(body.value))
        return evidence(recipe, restored.result.digest, restored.result.digest, 'recovered')
      } finally {
        second.provider.dispose()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
  const fetchBody = async () => body
  const first = openFetch(catalog, fetchBody)
  assert.equal(await first.source.refresh('remote'), null)
  const pinned = readPinnedConfigDocument(first.provider, 'remote', 1)
  first.provider.dispose()
  assert.equal(pinned.ok, true)
  if (!pinned.ok) return evidence(recipe, providerDigest(recipe), providerDigest(recipe), 'unread')
  const second = openFetch(catalog, fetchBody)
  try {
    assert.equal(await second.source.refresh('remote'), null)
    const restored = readPinnedConfigDocument(second.provider, 'remote', 1)
    assert.equal(restored.ok, true)
    if (!restored.ok) return evidence(recipe, pinned.result.digest, pinned.result.digest, 'unrestored')
    assert.equal(restored.result.digest, pinned.result.digest)
    return evidence(recipe, restored.result.digest, restored.result.digest, 'recovered')
  } finally {
    second.provider.dispose()
  }
}

async function dispose(recipe: Recipe): Promise<ConfigScenarioEvidence> {
  const catalog = admit()
  const body = snapshot(1, 'pinned')
  const subject =
    recipe === 'file' ? openFile(catalog, () => JSON.stringify(body)) : openFetch(catalog, async () => body)
  const sibling =
    recipe === 'file'
      ? openFetch(catalog, async () => {
          throw new Error('sibling must not fetch')
        })
      : openFile(catalog, () => null)
  try {
    assert.equal(await subject.source.refresh('local'), null)
    assert.equal(readPinnedConfigDocument(subject.provider, 'local', 1).ok, true)
    subject.provider.dispose()
    subject.provider.dispose()
    const read = subject.provider.read({ sourceRef: 'local', revision: 1 })
    assert.equal(read.ok, false)
    if (!read.ok) assert.equal(read.refusal.code, 'disposed')
    const resolved = sibling.provider.resolve(chain())
    assert.equal(resolved.ok, true)
    if (!resolved.ok)
      return evidence(recipe, providerDigest(recipe), providerDigest(recipe), 'sibling stopped')
    assert.equal(sibling.loads(), 0)
    return evidence(recipe, resolved.result.profileDigest, resolved.result.sourceSetDigest, 'disposed')
  } finally {
    sibling.provider.dispose()
  }
}

function port(recipe: Recipe): ConfigSourcePort {
  return {
    recipe,
    select: () => select(recipe),
    normal: () => normal(recipe),
    deny: () => deny(recipe),
    cancel: () => cancel(recipe),
    recover: () => recover(recipe),
    dispose: () => dispose(recipe),
  }
}

export async function bindConfigContract(
  harness: ConformanceHarness,
  command: string,
  providerId = 'default',
): Promise<void> {
  assert.notEqual(command, '')
  const binding: ConfigConformanceBinding = {
    command,
    build: getConformanceBuildIdentity(),
    sources: [port('file'), port('fetch')],
    providerId,
  }
  registerConfigContract(harness, binding)
}

export async function bindReferenceConfigContract(
  harness: ConformanceHarness,
  command: string,
  providerId = 'reference',
): Promise<void> {
  assert.notEqual(command, '')
  const binding: ConfigConformanceBinding = {
    command,
    build: getConformanceBuildIdentity(),
    sources: referenceConfigPorts(),
    providerId,
  }
  registerConfigContract(harness, binding)
}

function configProviderIds(providers: readonly string[]): string[] {
  return providers.filter(
    (providerId) =>
      providerId === 'default' || providerId === 'agh.default/config' || providerId === 'reference',
  )
}

export async function bindConformance(
  harness: ConformanceHarness,
  request: {
    readonly command: string
    readonly contracts: readonly string[] | 'all'
    readonly providers: readonly string[]
  },
): Promise<{ readonly contracts: readonly string[]; readonly providers: readonly string[] }> {
  const selected = request.contracts === 'all' || request.contracts.includes('agh.config')
  if (!selected) return { contracts: [], providers: [] }
  const providerIds = configProviderIds(request.providers)
  for (const providerId of providerIds) {
    if (providerId === 'reference') await bindReferenceConfigContract(harness, request.command, providerId)
    else await bindConfigContract(harness, request.command, providerId)
  }
  return { contracts: ['agh.config'], providers: providerIds }
}
