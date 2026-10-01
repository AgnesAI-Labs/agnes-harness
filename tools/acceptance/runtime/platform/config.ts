import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { documentDigest } from '../../../../packages/host/src/runtime/config/config-digest.ts'
import { readPinnedConfigDocument } from '../../../../packages/host/src/runtime/config/host-read.ts'
import {
  type ConfigOutcome,
  createFetchConfigProvider,
  createFileConfigProvider,
  createSchemaCatalog,
  type SchemaRef,
} from '../../../../packages/host/src/runtime/providers/config.ts'

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

function refusalCode(result: ConfigOutcome<unknown>): string {
  assert.equal(result.ok, false)
  if (result.ok) return ''
  return result.refusal.code
}

function provePersistentPin(): { digest: string } {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-config-pin-'))
  const path = join(directory, 'local.json')
  const first = { revision: 1, schema: parameterSchemaRef, value: { name: 'pinned', meta: { a: 1 } } }
  const second = { revision: 2, schema: parameterSchemaRef, value: { name: 'newer', meta: { a: 2 } } }
  let reads = 0
  try {
    writeFileSync(path, JSON.stringify(first))
    const opened = createFileConfigProvider(() => {
      reads += 1
      return readFileSync(path, 'utf8')
    })
    assert.equal(opened.source.refresh('local'), null)
    writeFileSync(path, JSON.stringify(second))
    const readsAfterAdmit = reads
    const pinned = readPinnedConfigDocument(opened.provider, 'local', 1)
    assert.equal(pinned.ok, true)
    if (!pinned.ok) return { digest: '' }
    assert.equal(pinned.result.revision, 1)
    assert.equal(reads, readsAfterAdmit)
    const value = pinned.result.documentRef.kind === 'inline' ? pinned.result.documentRef.value : null
    assert.equal(documentDigest(value), documentDigest({ name: 'pinned', meta: { a: 1 } }))
    assert.equal(pinned.result.digest, documentDigest(value))
    assert.equal(
      refusalCode(readPinnedConfigDocument(opened.provider, 'local', Number.NaN)),
      'schema_invalid',
    )
    assert.equal(reads, readsAfterAdmit)
    return { digest: pinned.result.digest }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')
const versionedService = fileURLToPath(
  new URL('../../../../packages/host/test/runtime/config-source-worker.ts', import.meta.url),
)

function requestCount(stdout: string): number {
  return stdout.match(/^request /gm)?.length ?? 0
}

async function proveHttpPin(expectedDigest: string): Promise<void> {
  const child: ChildProcess = spawn(process.execPath, [tsxCli, versionedService, 'serve'], {
    env: { ...process.env, AGNES_CONFIG_SCHEMA: JSON.stringify(parameterSchemaRef) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`versioned server did not start\n${stderr}`)), 20_000)
      const watch = () => {
        const match = /^ready (\d+)$/.exec(stdout.split('\n')[0] ?? '')
        if (match?.[1] === undefined) return
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
      child.stdout?.on('data', watch)
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error(`versioned server exited\n${stderr}`))
      })
      watch()
    })
    let revision = '1'
    const http = createFetchConfigProvider(async (_sourceRef, signal) => {
      const response = await fetch(`http://127.0.0.1:${port}/${revision}`, { signal })
      if (!response.ok) throw new Error(`status ${response.status}`)
      return (await response.json()) as {
        revision: number
        schema: SchemaRef
        value: { name: string; meta: { a: number } }
      }
    })
    assert.equal(await http.source.refresh('remote'), null)
    const callsAfterAdmit = requestCount(stdout)
    const pinned = readPinnedConfigDocument(http.provider, 'remote', 1)
    assert.equal(pinned.ok, true)
    if (!pinned.ok) return
    assert.equal(requestCount(stdout), callsAfterAdmit)
    assert.equal(pinned.result.digest, expectedDigest)
    assert.equal(pinned.result.revision, 1)
    revision = '2'
    assert.equal(await http.source.refresh('remote'), null)
    const latest = http.provider.read({ sourceRef: 'remote', revision: null })
    assert.equal(latest.ok, true)
    if (!latest.ok) return
    assert.equal(latest.result.revision, 2)
    assert.equal(latest.result.digest, documentDigest({ name: 'newer', meta: { a: 2 } }))
    assert.equal(readPinnedConfigDocument(http.provider, 'remote', 1).ok, true)
    assert.equal(requestCount(stdout), callsAfterAdmit + 1)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  }
}

function proveResolve(): { profileDigest: string; presetDigest: string; sourceSetDigest: string } {
  const catalog = createSchemaCatalog()
  assert.equal(catalog.admitSchema(parameterSchemaRef, PARAMETER_SCHEMA), null)
  const request = chain()
  const file = createFileConfigProvider(() => null, catalog).provider.resolve(request)
  const fetchProvider = createFetchConfigProvider(async () => {
    throw new Error('resolve must not fetch')
  }, catalog)
  const remote = fetchProvider.provider.resolve(request)
  assert.equal(file.ok, true)
  assert.equal(remote.ok, true)
  if (!file.ok || !remote.ok) return { profileDigest: '', presetDigest: '', sourceSetDigest: '' }
  assert.equal(file.result.status, 'candidate')
  assert.equal(file.result.profile.id, 'deployed')
  assert.equal(file.result.profile.limits.MAX_ID_BYTES, 128)
  assert.equal(remote.result.profileDigest, file.result.profileDigest)
  assert.equal(remote.result.presetDigest, file.result.presetDigest)
  assert.equal(remote.result.sourceSetDigest, file.result.sourceSetDigest)
  const revived = chain(({ parent, child }) => {
    parent.packages = [packageRow(false)]
    child.packages = [packageRow(true)]
  })
  const refused = createFileConfigProvider(() => null, catalog).provider.resolve(revived)
  assert.equal(refusalCode(refused), 'disabled_package_revived')
  fetchProvider.provider.dispose()
  assert.equal(refusalCode(fetchProvider.provider.read({ sourceRef: 'remote', revision: 1 })), 'disposed')
  const still = createFileConfigProvider(() => null, catalog).provider.resolve(request)
  assert.equal(still.ok, true)
  if (!still.ok) return { profileDigest: '', presetDigest: '', sourceSetDigest: '' }
  assert.equal(still.result.profileDigest, file.result.profileDigest)
  return {
    profileDigest: file.result.profileDigest,
    presetDigest: file.result.presetDigest,
    sourceSetDigest: file.result.sourceSetDigest,
  }
}

async function main(): Promise<void> {
  const pinned = provePersistentPin()
  await proveHttpPin(pinned.digest)
  const resolved = proveResolve()
  console.log(
    JSON.stringify({
      pinnedDigest: pinned.digest,
      profileDigest: resolved.profileDigest,
      presetDigest: resolved.presetDigest,
      sourceSetDigest: resolved.sourceSetDigest,
    }),
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
