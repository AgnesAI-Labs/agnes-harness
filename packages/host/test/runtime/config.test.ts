import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { documentDigest } from '../../src/runtime/config/config-digest.js'
import { readPinnedConfigDocument } from '../../src/runtime/config/host-read.js'
import {
  type ConfigOutcome,
  type ConfigProvider,
  createFetchConfigProvider,
  createFileConfigProvider,
  createSchemaCatalog,
  type SchemaRef,
} from '../../src/runtime/providers/config.js'

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
const SECRET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { apiKey: { type: 'string' } },
  required: ['apiKey'],
}

type Profile = Record<string, unknown>
type Preset = Record<string, unknown>

function schemaRef(document: unknown, typeId: string): SchemaRef {
  return { typeId, revision: 1, digest: documentDigest(document) }
}

const parameterSchemaRef = schemaRef(PARAMETER_SCHEMA, 'acme.config/session@1')
const secretSchemaRef = schemaRef(SECRET_SCHEMA, 'acme.config/secret@1')

function client(): Record<string, unknown> {
  return {
    rendererSelections: [],
    requiredTargets: ['sdk'],
    shell: { packageId: 'agnes-host', contributionId: 'shell' },
    registry: { packageId: 'agnes-host', contributionId: 'registry' },
    fallbackRenderer: { packageId: 'agnes-host', contributionId: 'fallback' },
  }
}

function policy(decision: 'allow' | 'ask' | 'deny' = 'ask'): Record<string, unknown> {
  return {
    capabilityCeiling: [],
    minimumRecovery: 'R0',
    allowedIsolation: ['trusted-in-process'],
    sourcePolicy: { allowLocal: false, npmRegistries: [], gitOrigins: [], allowBuildScripts: false },
    grants: [
      {
        provider: { packageId: 'agnes-host', providerId: 'agh.default/config' },
        decision,
        capabilities: [],
        resourceScopes: [],
      },
    ],
  }
}

function policyCell(): Record<string, unknown> {
  return {
    contract: 'agh.config',
    major: 1,
    logicalName: 'config',
    allowedProviders: [{ packageId: 'agnes-host', providerId: 'agh.default/config' }],
    allowSessionSelect: false,
    configOverridePaths: [],
    allowedIsolation: ['trusted-in-process'],
    minimumRecovery: 'R0',
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
    client: client(),
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

function chain(
  mutate?: (documents: { parent: Profile; child: Profile; base: Preset; leaf: Preset }) => void,
) {
  const base = preset('base', 1, { name: 'base', meta: { a: 1, b: 2 } })
  const leaf = preset('leaf', 1, { name: 'leaf', meta: { a: 1, b: 3 } })
  leaf.extends = { presetId: 'base', digest: documentDigest(base) }
  const leafDigest = documentDigest(leaf)
  const parent = profile('builtin', 1, 'leaf', leafDigest)
  const child = profile('deployed', 2, 'leaf', leafDigest)
  child.extends = { profileId: 'builtin', digest: documentDigest(parent) }
  child.limits = { MAX_ID_BYTES: 128 }
  mutate?.({ parent, child, base, leaf })
  if (typeof leaf.extends === 'object' && leaf.extends) {
    leaf.extends = { presetId: base.id, digest: documentDigest(base) }
  }
  const parentPresets = parent.presets as { allowed: { digest: string }[] }
  const childPresets = child.presets as { allowed: { digest: string }[] }
  const digest = documentDigest(leaf)
  for (const entry of [...parentPresets.allowed, ...childPresets.allowed]) {
    if (entry.digest === leafDigest) entry.digest = digest
  }
  if (typeof child.extends === 'object' && child.extends) {
    child.extends = { profileId: parent.id, digest: documentDigest(parent) }
  }
  return {
    request: {
      algorithm: 'agh.config/resolve-v1',
      defaults: { profile: bind('builtin', 1, parent), preset: bind('preset-base', 1, base) },
      profiles: [bind('deployed', 1, child)],
      presets: [bind('preset-leaf', 1, leaf)],
      managed: null,
      workspace: null,
      session: null,
    },
    parent,
    child,
    base,
    leaf,
  }
}

function admitParameters(catalog = createSchemaCatalog()) {
  const refusal = catalog.admitSchema(parameterSchemaRef, PARAMETER_SCHEMA)
  expect(refusal).toBeNull()
  return catalog
}

function providerFor(catalog = admitParameters()): ConfigProvider {
  return createFileConfigProvider(() => null, catalog).provider
}

function codeOf(result: ConfigOutcome<unknown>): string {
  expect(result.ok).toBe(false)
  if (result.ok) return ''
  return result.refusal.code
}

it('resolves a pinned profile chain without taking a newer source document', () => {
  const catalog = admitParameters()
  const { request } = chain()
  const files = new Map<string, string>([
    ['deployed', JSON.stringify({ revision: 9, schema: parameterSchemaRef, value: { replaced: true } })],
  ])
  const { provider, source } = createFileConfigProvider((sourceRef) => files.get(sourceRef) ?? null, catalog)
  expect(source.refresh('deployed')).toBeNull()
  const snap = structuredClone(request)
  const resolved = provider.resolve(request)
  expect(request).toEqual(snap)
  expect(resolved.ok).toBe(true)
  if (!resolved.ok) return
  expect(resolved.result.status).toBe('candidate')
  expect(resolved.result.algorithm).toBe('agh.config/resolve-v1')
  expect(resolved.result.profile.id).toBe('deployed')
  expect(resolved.result.profile.extends).toBeUndefined()
  expect(resolved.result.profile.limits).toEqual({ MAX_ID_BYTES: 128 })
  expect(resolved.result.profile.policy.grants[0]?.decision).toBe('ask')
  expect(resolved.result.preset.id).toBe('leaf')
  expect(resolved.result.preset.extends).toBeUndefined()
  expect(resolved.result.preset.parameters.value).toEqual({ name: 'leaf', meta: { a: 1, b: 3 } })
  expect(resolved.result.provenance.some((entry) => entry.operation === 'default')).toBe(true)
  expect(
    resolved.result.provenance.some(
      (entry) => entry.operation === 'minimum' && entry.path === '/limits/MAX_ID_BYTES',
    ),
  ).toBe(true)
  const latest = provider.read({ sourceRef: 'deployed', revision: null })
  expect(latest.ok).toBe(true)
  if (!latest.ok) return
  expect(latest.result.digest).not.toBe(resolved.result.profileDigest)
})

it('keeps the same digests when object keys are reversed and when another provider resolves the same request', () => {
  const catalog = admitParameters()
  const { request } = chain()
  const first = providerFor(catalog).resolve(request)
  const reverse = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reverse)
    if (!value || typeof value !== 'object') return value
    const reversed: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).reverse()) {
      reversed[key] = reverse((value as Record<string, unknown>)[key])
    }
    return reversed
  }
  const second = createFetchConfigProvider(async () => {
    throw new Error('resolve must not fetch')
  }, catalog).provider.resolve(reverse(request))
  expect(first.ok && second.ok).toBe(true)
  if (!first.ok || !second.ok) return
  expect(second.result.profileDigest).toBe(first.result.profileDigest)
  expect(second.result.presetDigest).toBe(first.result.presetDigest)
  expect(second.result.sourceSetDigest).toBe(first.result.sourceSetDigest)
})

it('reads the admitted revision after a newer file and a failed or cancelled fetch', async () => {
  const files = new Map<string, string>()
  let loads = 0
  const file = createFileConfigProvider((sourceRef) => {
    loads += 1
    return files.get(sourceRef) ?? null
  })
  const first = { revision: 1, schema: parameterSchemaRef, value: { name: 'first' } }
  const second = { revision: 2, schema: parameterSchemaRef, value: { name: 'second' } }
  files.set('local', JSON.stringify(first))
  expect(file.source.refresh('local')).toBeNull()
  files.set('local', JSON.stringify(second))
  expect(file.source.refresh('local')).toBeNull()
  const loadsAfterAdmit = loads
  const pinned = file.provider.read({ sourceRef: 'local', revision: 1 })
  const latest = file.provider.read({ sourceRef: 'local', revision: null })
  expect(loads).toBe(loadsAfterAdmit)
  expect(pinned.ok && latest.ok).toBe(true)
  if (!pinned.ok || !latest.ok) return
  expect(pinned.result.revision).toBe(1)
  expect(pinned.result.documentRef).toMatchObject({ kind: 'inline', value: { name: 'first' } })
  expect(latest.result.revision).toBe(2)
  expect(file.provider.read({ sourceRef: 'local', revision: 9 }).ok).toBe(false)
  files.set('local', JSON.stringify({ revision: 2, schema: parameterSchemaRef, value: { name: 'tampered' } }))
  expect(file.source.refresh('local')?.code).toBe('revision_conflict')
  const still = file.provider.read({ sourceRef: 'local', revision: 2 })
  expect(still.ok).toBe(true)
  if (!still.ok) return
  expect(still.result.documentRef).toMatchObject({ value: { name: 'second' } })

  const yaml = createFileConfigProvider(
    () =>
      'revision: 1\nschema:\n  typeId: acme.config/session@1\n  revision: 1\n  digest: ' +
      `${parameterSchemaRef.digest}\nvalue:\n  name: from-yaml\n`,
  )
  expect(yaml.source.refresh('yaml')).toBeNull()
  const yamlRead = yaml.provider.read({ sourceRef: 'yaml', revision: 1 })
  expect(yamlRead.ok).toBe(true)
  if (!yamlRead.ok) return
  expect(yamlRead.result.documentRef).toMatchObject({ value: { name: 'from-yaml' } })
  expect(yamlRead.result.digest).toBe(documentDigest({ name: 'from-yaml' }))

  let calls = 0
  let body = first
  const server: Server = createServer((_request, response) => {
    calls += 1
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const http = createFetchConfigProvider(async (_sourceRef, signal) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/latest`, { signal })
    return (await response.json()) as { revision: number; schema: SchemaRef; value: { name: string } }
  })
  try {
    expect(await http.source.refresh('remote')).toBeNull()
    body = second
    const callsAfterFirst = calls
    const httpPinned = http.provider.read({ sourceRef: 'remote', revision: 1 })
    expect(calls).toBe(callsAfterFirst)
    expect(httpPinned.ok).toBe(true)
    if (!httpPinned.ok) return
    expect(httpPinned.result.digest).toBe(pinned.result.digest)
    expect(await http.source.refresh('remote')).toBeNull()
    const httpLatest = http.provider.read({ sourceRef: 'remote', revision: null })
    expect(httpLatest.ok).toBe(true)
    if (!httpLatest.ok) return
    expect(httpLatest.result.revision).toBe(2)
    expect(http.provider.read({ sourceRef: 'remote', revision: 1 })).toMatchObject({
      ok: true,
      result: { digest: pinned.result.digest },
    })
    const failing = createFetchConfigProvider(async () => {
      throw new Error('offline')
    })
    expect((await failing.source.refresh('remote'))?.code).toBe('source_unavailable')
    expect(failing.provider.read({ sourceRef: 'remote', revision: null }).ok).toBe(false)
    const cancelled = createFetchConfigProvider(
      (_sourceRef, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    )
    const controller = new AbortController()
    const pending = cancelled.source.refresh('remote', controller.signal)
    controller.abort()
    expect((await pending)?.code).toBe('cancelled')
    expect(cancelled.provider.read({ sourceRef: 'remote', revision: null }).ok).toBe(false)
    http.provider.dispose()
    expect(codeOf(http.provider.read({ sourceRef: 'remote', revision: 1 }))).toBe('disposed')
    expect(file.provider.read({ sourceRef: 'local', revision: 1 }).ok).toBe(true)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

it('refuses a weaker layer that revives a package, widens authority, or breaks the parent chain', () => {
  const catalog = admitParameters()
  const provider = providerFor(catalog)
  const revived = chain(({ parent, child }) => {
    parent.packages = [packageRow(false)]
    child.packages = [packageRow(true)]
  })
  expect(codeOf(provider.resolve(revived.request))).toBe('disabled_package_revived')
  const widened = chain(({ child }) => {
    child.policy = {
      ...policy(),
      capabilityCeiling: [{ capability: 'goals.read', resourceTypes: [], operations: ['read'] }],
    }
  })
  expect(codeOf(provider.resolve(widened.request))).toBe('configuration_widens_authority')
  const isolation = chain(({ child }) => {
    child.policy = { ...policy(), allowedIsolation: ['trusted-in-process', 'remote'] }
  })
  expect(codeOf(provider.resolve(isolation.request))).toBe('configuration_widens_authority')
  const missing = chain(({ child }) => {
    delete child.extends
  })
  expect(codeOf(provider.resolve(missing.request))).toBe('extends_missing')
  const mismatch = chain()
  const profileSnapshot = mismatch.request.profiles[0]
  if (!profileSnapshot) throw new Error('missing profile')
  const profileDocument = profileSnapshot.document as Profile
  profileDocument.extends = { profileId: 'builtin', digest: 'a'.repeat(64) }
  profileSnapshot.source.digest = documentDigest(profileDocument)
  expect(codeOf(provider.resolve(mismatch.request))).toBe('extends_digest_mismatch')
  const cycle = chain(({ child }) => {
    child.id = 'builtin'
  })
  expect(codeOf(provider.resolve(cycle.request))).toBe('extends_cycle')
  const duplicated = chain(({ child }) => {
    child.packages = [packageRow(true), packageRow(true)]
  })
  expect(codeOf(provider.resolve(duplicated.request))).toBe('duplicate_package')
  const replaced = chain(({ parent, child }) => {
    parent.packages = [packageRow(true)]
    child.packages = [{ ...packageRow(true), manifestDigest: 'f'.repeat(64) }]
  })
  expect(codeOf(provider.resolve(replaced.request))).toBe('source_replaced')
  const unknown = createSchemaCatalog()
  expect(codeOf(providerFor(unknown).resolve(chain().request))).toBe('unknown_schema')
  const identity = chain()
  identity.request.defaults.profile.source.digest = 'b'.repeat(64)
  expect(codeOf(provider.resolve(identity.request))).toBe('content_identity_mismatch')
  const disjoint = chain(({ parent, child }) => {
    parent.selectionPolicy = [policyCell()]
    child.selectionPolicy = [policyCell()]
  })
  expect(
    codeOf(
      provider.resolve({
        ...disjoint.request,
        managed: bind('managed', 1, {
          policy: policy('deny'),
          selectionPolicy: [{ ...policyCell(), allowedIsolation: ['remote'] }],
          allowedPresets: (disjoint.child.presets as { allowed: unknown[] }).allowed,
          limits: { MAX_ID_BYTES: 64 },
          packagesDeny: [],
          providerConfigRestrictions: [],
        }),
      }),
    ),
  ).toBe('limit_conflict')
  const unselected = chain(({ parent, child, leaf }) => {
    parent.selectionPolicy = [policyCell()]
    child.selectionPolicy = [policyCell()]
    leaf.selections = [
      {
        contract: 'agh.config',
        major: 1,
        logicalName: 'config',
        provider: { packageId: 'agnes-host', providerId: 'agh.default/config' },
        isolation: 'trusted-in-process',
      },
    ]
  })
  expect(codeOf(provider.resolve(unselected.request))).toBe('provider_not_selected')
  const otherSchema = {
    ...PARAMETER_SCHEMA,
    properties: { ...PARAMETER_SCHEMA.properties, note: { type: 'string' } },
  }
  const otherRef = schemaRef(otherSchema, 'acme.config/session-note@1')
  expect(catalog.admitSchema(otherRef, otherSchema)).toBeNull()
  const mismatched = chain(({ leaf }) => {
    leaf.parameters = { schema: otherRef, value: { name: 'leaf', meta: { a: 1 } } }
  })
  expect(codeOf(provider.resolve(mismatched.request))).toBe('parameter_schema_mismatch')
})

it('keeps the stricter grant and applies a managed deny without reading the latest file', () => {
  const catalog = admitParameters()
  const documents = chain(({ parent, child }) => {
    parent.packages = [packageRow(true)]
    child.packages = [packageRow(true)]
    child.policy = policy('allow')
  })
  const kept = providerFor(catalog).resolve(documents.request)
  expect(kept.ok).toBe(true)
  if (!kept.ok) return
  expect(kept.result.profile.policy.grants[0]?.decision).toBe('ask')
  const managed = {
    policy: policy('deny'),
    selectionPolicy: [],
    allowedPresets: (documents.child.presets as { allowed: unknown[] }).allowed,
    limits: { MAX_ID_BYTES: 64 },
    packagesDeny: ['tools'],
    providerConfigRestrictions: [],
  }
  const resolved = providerFor(catalog).resolve({
    ...documents.request,
    managed: bind('managed', 1, managed),
  })
  expect(resolved.ok).toBe(true)
  if (!resolved.ok) return
  expect(resolved.result.profile.packages).toEqual([{ ...packageRow(false) }])
  expect(resolved.result.profile.policy.grants[0]?.decision).toBe('deny')
  expect(resolved.result.profile.limits).toEqual({ MAX_ID_BYTES: 64 })
  expect(resolved.result.provenance.some((entry) => entry.operation === 'deny-union')).toBe(true)
})

it('refuses workspace input unless restrictions are allowed, and then only narrows them', () => {
  const catalog = admitParameters()
  const blocked = chain()
  const workspace = {
    restrictions: { allowedIsolation: ['trusted-in-process', 'remote'], limits: { MAX_ID_BYTES: 32 } },
    parameters: { schema: parameterSchemaRef, value: { name: 'workspace', meta: { a: 1 } } },
  }
  expect(
    codeOf(providerFor(catalog).resolve({ ...blocked.request, workspace: bind('workspace', 1, workspace) })),
  ).toBe('workspace_forbidden')
  const allowed = chain(({ parent, child }) => {
    parent.overrides = { allowWorkspaceRestrictions: true, sessionParametersSchema: parameterSchemaRef }
    child.overrides = { allowWorkspaceRestrictions: true, sessionParametersSchema: parameterSchemaRef }
  })
  const resolved = providerFor(catalog).resolve({
    ...allowed.request,
    workspace: bind('workspace', 1, workspace),
  })
  expect(resolved.ok).toBe(true)
  if (!resolved.ok) return
  expect(resolved.result.preset.restrictions.allowedIsolation).toEqual(['trusted-in-process'])
  expect(resolved.result.preset.restrictions.limits).toEqual({ MAX_ID_BYTES: 32 })
  expect(resolved.result.preset.parameters.value).toEqual({ name: 'workspace', meta: { a: 1, b: 3 } })
})

it('selects an admitted provider and refuses a raw secret, a bad storage path, and a reserved patch', () => {
  const catalog = admitParameters()
  expect(catalog.admitSchema(secretSchemaRef, SECRET_SCHEMA)).toBeNull()
  expect(
    catalog.admitProvider('agnes-host', {
      providerId: 'agh.default/config',
      contract: 'agh.config',
      major: 1,
      logicalName: 'config',
      packageVersion: '1.0.0',
      packageDigest: 'c'.repeat(64),
      features: [],
      scope: 'runtime',
      configSchema: secretSchemaRef,
      requires: [],
      capabilities: [],
      recovery: 'R1',
      isolation: ['trusted-in-process'],
      stateCodecs: [],
      activationMode: 'lazy',
      operations: [],
    }),
  ).toBeNull()
  const cell = { ...policyCell(), allowSessionSelect: true, configOverridePaths: ['/apiKey'] }
  const config = {
    provider: { packageId: 'agnes-host', providerId: 'agh.default/config' },
    config: { schema: secretSchemaRef, value: { apiKey: 'secret://v/k' } },
  }
  const documents = chain(({ parent, child }) => {
    parent.selectionPolicy = [cell]
    child.selectionPolicy = [cell]
    parent.providerConfigs = [config]
    child.providerConfigs = [structuredClone(config)]
  })
  const session = {
    selections: [
      {
        contract: 'agh.config',
        major: 1,
        logicalName: 'config',
        provider: { packageId: 'agnes-host', providerId: 'agh.default/config' },
        isolation: 'trusted-in-process',
      },
    ],
    configOverrides: [],
    parameters: { schema: parameterSchemaRef, value: { name: 'session', meta: { a: 4 } } },
  }
  const selected = providerFor(catalog).resolve({
    ...documents.request,
    session: bind('session', 1, session),
  })
  expect(selected.ok).toBe(true)
  if (!selected.ok) return
  expect(selected.result.preset.selections).toEqual(session.selections)
  expect(selected.result.preset.parameters.value).toEqual({ name: 'session', meta: { a: 4, b: 3 } })
  expect(selected.result.profile.providerConfigs[0]?.config.value).toEqual({ apiKey: 'secret://v/k' })

  const hidden = chain(({ parent, child }) => {
    parent.providerConfigs = [
      { ...config, config: { schema: secretSchemaRef, value: { apiKey: 'raw-secret' } } },
    ]
    child.providerConfigs = structuredClone(parent.providerConfigs)
  })
  const secret = providerFor(catalog).resolve(hidden.request)
  expect(codeOf(secret)).toBe('secret_material')
  expect(JSON.stringify(secret)).not.toContain('raw-secret')

  const relative = chain(({ parent, child }) => {
    parent.storage = { dataDir: 'relative/data', cacheDir: '/var/agnes/cache' }
    child.storage = { dataDir: 'relative/data', cacheDir: '/var/agnes/cache' }
  })
  expect(codeOf(providerFor(catalog).resolve(relative.request))).toBe('path_not_absolute')
  const home = chain(({ parent, child }) => {
    parent.storage = { dataDir: '~/agnes/data', cacheDir: '/var/agnes/cache' }
    child.storage = { dataDir: '~/agnes/data', cacheDir: '/var/agnes/cache' }
  })
  expect(codeOf(providerFor(catalog).resolve(home.request))).toBe('home_unresolved')

  const patched = chain(({ parent, child }) => {
    parent.selectionPolicy = [{ ...cell, configOverridePaths: ['/__proto__/polluted'] }]
    child.selectionPolicy = [{ ...cell, configOverridePaths: ['/__proto__/polluted'] }]
    parent.providerConfigs = [structuredClone(config)]
    child.providerConfigs = [structuredClone(config)]
  })
  const attack = {
    selections: [],
    configOverrides: [
      {
        provider: { packageId: 'agnes-host', providerId: 'agh.default/config' },
        patch: [{ path: '/__proto__/polluted', value: true }],
      },
    ],
    parameters: { schema: parameterSchemaRef, value: { name: 'session', meta: { a: 1 } } },
  }
  expect(
    codeOf(providerFor(catalog).resolve({ ...patched.request, session: bind('session', 1, attack) })),
  ).toBe('config_override_forbidden')
  const blockedSession = chain()
  expect(
    codeOf(
      providerFor(catalog).resolve({
        ...blockedSession.request,
        session: bind('session', 1, { ...session, selections: session.selections }),
      }),
    ),
  ).toBe('session_selection_forbidden')
})

it('refuses a profile chain longer than 16 documents', () => {
  const { request, parent } = chain()
  const profiles = []
  for (let index = 0; index < 16; index += 1) {
    const document = structuredClone(parent)
    document.id = `layer-${index}`
    document.revision = index + 1
    profiles.push(bind(`layer-${index}`, index + 1, document))
  }
  expect(codeOf(providerFor().resolve({ ...request, profiles }))).toBe('extends_depth')
})

it('reads one admitted revision through the host adapter and does not ask for a newer file', () => {
  const files = new Map<string, string>()
  let loads = 0
  const seen: unknown[] = []
  const file = createFileConfigProvider((sourceRef) => {
    loads += 1
    return files.get(sourceRef) ?? null
  })
  const first = { revision: 1, schema: parameterSchemaRef, value: { name: 'pinned', meta: { a: 1 } } }
  files.set('local', JSON.stringify(first))
  expect(file.source.refresh('local')).toBeNull()
  files.set('local', JSON.stringify({ revision: 2, schema: parameterSchemaRef, value: { name: 'newer' } }))
  const loadsAfterAdmit = loads
  const reader = {
    read(input: unknown) {
      seen.push(input)
      return file.provider.read(input)
    },
  }
  const pinned = readPinnedConfigDocument(reader, 'local', 1)
  expect(pinned.ok).toBe(true)
  if (!pinned.ok) return
  expect(pinned.result.revision).toBe(1)
  expect(pinned.result.documentRef).toMatchObject({
    kind: 'inline',
    value: { name: 'pinned', meta: { a: 1 } },
  })
  expect(loads).toBe(loadsAfterAdmit)
  expect(seen).toEqual([{ sourceRef: 'local', revision: 1 }])
  expect(codeOf(readPinnedConfigDocument(reader, 'local', Number.NaN))).toBe('schema_invalid')
  expect(seen).toHaveLength(1)
  expect(codeOf(readPinnedConfigDocument(reader, 'local', 2))).toBe('source_unavailable')
  file.provider.dispose()
  expect(codeOf(readPinnedConfigDocument(reader, 'local', 1))).toBe('disposed')
})
