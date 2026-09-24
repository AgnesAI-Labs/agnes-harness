import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import * as P from '../src/index.js'
import { type Fixture, runFixtureLine } from '../tools/conformance-core.js'

const rows = readFileSync(new URL('../fixtures/configs/task20.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Fixture)
const validators: Record<string, (value: unknown) => P.ValidationResult<unknown>> = {
  RuntimeProfileManifest: P.validateProfileManifest,
  ProfileFragment: P.validateProfileFragment,
  ResolvedProfile: P.validateResolvedProfile,
  ManagedPolicy: P.validateManagedPolicy,
  Lockfile: P.validateLockfile,
  ExtensionManifest: P.validateExtensionManifest,
  DeployManifest: P.validateDeployManifest,
  JobSpec: P.validateJobSpec,
  JobStatus: P.validateJobStatus,
}
function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object') return
  for (const item of Object.values(value)) deepFreeze(item)
  Object.freeze(value)
}
describe('Task20 document validators', () => {
  it.each(rows)('$id: actual validator leaves success and failure inputs unchanged', (row) => {
    const before = structuredClone(row.payload)
    deepFreeze(row.payload)
    const check = validators[row.name as string]
    if (!check) throw new Error(`unknown validator ${row.name}`)
    const result = check(row.payload)
    expect(result.ok).toBe(row.kind === 'valid')
    expect(row.payload).toEqual(before)
    if (result.ok) expect(result.value).toBe(row.payload)
    expect(runFixtureLine(row).pass).toBe(true)
  })
  it('validates omitted fields without installing defaults or granting capabilities', () => {
    const profile = { name: 'fixture' }
    expect(P.validateProfileManifest(profile)).toEqual({ ok: true, value: profile })
    expect(Object.keys(profile)).toEqual(['name'])
    const job = {
      idempotencyKey: 'j',
      sessionKey: 's',
      payload: { prompt: 'hi' },
      schedule: { kind: 'once' },
    }
    expect(P.validateJobSpec(job)).toEqual({ ok: true, value: job })
    expect(job).not.toHaveProperty('maxAttempts')
    expect(job).not.toHaveProperty('protected')
    expect(P.validateJobSpec({ ...job, schedule: undefined }).ok).toBe(false)
    expect(
      P.validateExtensionManifest({
        id: 'fixture/ext',
        version: '0.1.0',
        apiRange: '^1.0.0',
        entry: './index.ts',
        capabilities: {},
      }).ok,
    ).toBe(true)
  })
  it('preserves empty prefix authority and an explicit empty names allowlist', () => {
    const manifest = { id: 'fixture/ext', version: '0.1.0', apiRange: '^1.0.0', entry: './index.ts' }
    const broad = { ...manifest, capabilities: { tools: { prefix: '' } } }
    const none = { ...manifest, capabilities: { tools: { prefix: '', names: [] } } }
    expect(P.validateExtensionManifest(broad)).toEqual({ ok: true, value: broad })
    expect(P.validateExtensionManifest(none)).toEqual({ ok: true, value: none })
    expect(none.capabilities.tools.names).toEqual([])
    expect(broad.capabilities.tools).not.toHaveProperty('names')
  })
  it('rejects non JSON numbers, undefined payload members and diagnostic secret interpolation', () => {
    const job = {
      idempotencyKey: 'j',
      sessionKey: 's',
      payload: { command: { method: 'resume', params: { missing: undefined } } },
      schedule: { kind: 'once' },
    }
    expect(P.validateJobSpec(job).ok).toBe(false)
    for (const budget of [NaN, Infinity, -Infinity])
      expect(P.validateJobSpec({ ...job, payload: { prompt: 'hi' }, budget }).ok).toBe(false)
    const secret = 'RAW_FIXTURE_CREDENTIAL_SENTINEL'
    const result = P.validateProfileManifest({
      name: 'fixture',
      transports: [{ kind: 'ws-tls', tls: { key: secret } }],
    })
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result)).not.toContain(secret)
  })
  it('unknown config dispatch is an error instead of a permissive validator', () => {
    expect(() =>
      runFixtureLine({ id: 'unknown', kind: 'valid', target: 'config', name: 'typo', payload: {} }),
    ).toThrow('no config validator')
  })
})

describe('Task20 accepts actual bundled extension manifests', () => {
  it('rejects nonempty legacy network arrays without guessing their authority', () => {
    const base = { id: 'fixture/ext', version: '0.1.0', apiRange: '^1.0.0', entry: './index.ts' }
    expect(P.validateExtensionManifest({ ...base, capabilities: { network: ['example.invalid'] } }).ok).toBe(
      false,
    )
  })
  it.each(['tools-core', 'approval-policy', 'artifacts-local', 'principals-local'])('%s', (name) => {
    const raw = JSON.parse(
      readFileSync(new URL(`../../base/extensions/${name}/agnes.extension.json`, import.meta.url), 'utf8'),
    )
    expect(P.validateExtensionManifest(raw)).toEqual({ ok: true, value: raw })
  })
})

describe('Task20 validates actual host profile assets and resolver output', () => {
  const hostRequire = createRequire(new URL('../../host/package.json', import.meta.url))
  const yaml = hostRequire('yaml') as { parse(text: string): unknown }
  it.each(['local-dev', 'enterprise'])('%s raw YAML', (template) => {
    const raw = yaml.parse(
      readFileSync(new URL(`../../host/templates/${template}.yaml`, import.meta.url), 'utf8'),
    )
    expect(P.validateProfileManifest(raw)).toEqual({ ok: true, value: raw })
  })
  it('accepts the real default local-dev resolved profile without repairing its shape', async () => {
    // Runtime import keeps this protocol-only schema project from acquiring a production dependency
    // on its consumer. Integration checks still call the actual host implementation in this repo.
    const moduleUrl = new URL('../../host/src/profile/resolve.ts', import.meta.url).href
    const { resolveProfile } = (await import(moduleUrl)) as {
      resolveProfile(inputs: unknown, env: unknown): Promise<unknown>
    }
    const resolved = await resolveProfile(
      {
        builtin: 'local-dev',
        lock: {
          packages: Object.fromEntries(
            ['@agnes/ai', '@agnes/base', '@agnes/code'].map((id) => [
              id,
              { version: '0.1.0', integrity: `sha256-${'a'.repeat(64)}`, trust: 'builtin', enabled: true },
            ]),
          ),
        },
      },
      {
        platform: { os: 'darwin', arch: 'arm64', capabilities: {} },
        agnesVersion: '0.0.0',
        now: '2026-09-09T00:00:00Z',
        homeDir: '/fixture/home',
      },
    )
    const before = structuredClone(resolved)
    expect(P.validateResolvedProfile(resolved)).toEqual({ ok: true, value: resolved })
    expect(resolved).toEqual(before)
  })
})
