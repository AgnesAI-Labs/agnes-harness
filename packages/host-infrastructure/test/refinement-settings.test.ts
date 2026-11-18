import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_REFINEMENT_SETTINGS } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createCredentialStore } from '../src/adapters/credential-store.js'
import {
  type RefinementSettingsPort,
  RefinementSettingsStore,
  refinementSettingsRevision,
} from '../src/refinement-settings.js'

const dirs: string[] = []
const model = 'company/review'
const credentialRef = 'secret://generic/00000000-0000-4000-8000-000000000001'
const dataDir = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-refinement-'))
  dirs.push(dir)
  await createCredentialStore({ root: dir }).putGeneric(credentialRef, 'fixture-review-key', {
    label: 'Fixture',
    createdAt: new Date(0).toISOString(),
  })
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const fileOf = (dir: string, profile: string) =>
  join(dir, 'refinement', `${createHash('sha256').update(profile).digest('hex')}.json`)
const plant = (dir: string, profile: string, text: string) => {
  mkdirSync(join(dir, 'refinement'), { recursive: true })
  writeFileSync(fileOf(dir, profile), text)
}

describe('RefinementSettingsStore', () => {
  it('defaults to off when the file is missing, corrupt or has unknown fields and disables legacy settings', async () => {
    const dir = await dataDir()
    const off = { enabled: false, mode: 'manual' }
    expect(DEFAULT_REFINEMENT_SETTINGS).toEqual(off)
    expect(new RefinementSettingsStore(dir, 'p').read().settings).toEqual(off)
    const bad = [
      '{not json',
      '',
      '[]',
      'null',
      '{"enabled":true}',
      '{"enabled":true,"mode":"auto","extra":1}',
      '{"enabled":"yes","mode":"auto"}',
      '{"enabled":true,"mode":"always"}',
    ]
    for (const text of bad) {
      plant(dir, 'p', text)
      expect(new RefinementSettingsStore(dir, 'p').read().settings).toEqual(off)
    }
    plant(
      dir,
      'p',
      JSON.stringify({
        settings: { enabled: true, mode: 'auto' },
        nonce: '0e6f4c1a-6a46-4fb0-9a8b-0f5e9b1c2d3e',
      }),
    )
    expect(new RefinementSettingsStore(dir, 'p').read().settings).toEqual({ enabled: false, mode: 'auto' })
    for (const partial of [{}, { credentialRef }, { model }]) {
      const settings = { ...partial, enabled: true, mode: 'auto' }
      for (const body of [settings, { settings, nonce: '0e6f4c1a-6a46-4fb0-9a8b-0f5e9b1c2d3e' }]) {
        plant(dir, 'p', JSON.stringify(body))
        expect(new RefinementSettingsStore(dir, 'p').read().settings).toEqual({
          ...settings,
          enabled: false,
        })
      }
    }
  })

  it('save rejects a stale revision', async () => {
    const store = new RefinementSettingsStore(await dataDir(), 'p')
    const first = store.read()
    for (const invalid of [
      { enabled: true, mode: 'auto' },
      { enabled: true, mode: 'auto', credentialRef: 'raw-key', model },
      { enabled: true, mode: 'auto', credentialRef: 'secret://generic/missing', model },
      { enabled: true, mode: 'auto', credentialRef },
      { enabled: true, mode: 'auto', model },
      { enabled: true, mode: 'auto', credentialRef, model: 'two ids' },
    ])
      expect(() => store.save(invalid as never, first.revision)).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID_INPUT' }),
      )
    const saved = store.save({ credentialRef, model, enabled: true, mode: 'auto' }, first.revision)
    expect(saved.revision).not.toBe(first.revision)
    expect(store.read()).toEqual({
      settings: { credentialRef, model, enabled: true, mode: 'auto' },
      revision: saved.revision,
    })
    expect(() => store.save({ enabled: false, mode: 'manual' }, first.revision)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_REVISION_CONFLICT' }),
    )
    expect(store.read().settings).toEqual({ credentialRef, model, enabled: true, mode: 'auto' })
    expect(() => store.save({ enabled: 1, mode: 'auto' } as never, saved.revision)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID_INPUT' }),
    )
  })

  it('keeps one file per profile under refinement/<sha256(profile)>.json', async () => {
    const dir = await dataDir()
    const a = new RefinementSettingsStore(dir, 'a')
    const b = new RefinementSettingsStore(dir, 'b')
    a.save({ credentialRef, model, enabled: true, mode: 'manual' }, a.read().revision)
    expect(b.read().settings.enabled).toBe(false)
    expect(readdirSync(join(dir, 'refinement'))).toEqual([
      `${createHash('sha256').update('a').digest('hex')}.json`,
    ])
    expect(JSON.parse(readFileSync(fileOf(dir, 'a'), 'utf8'))).toEqual({
      settings: { credentialRef, model, enabled: true, mode: 'manual' },
      nonce: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
  })

  it('every save gets a new revision: off and on again never brings back an old one', async () => {
    const store = new RefinementSettingsStore(await dataDir(), 'p')
    const seen = new Set([store.read().revision])
    for (const enabled of [true, false, true, false, true]) {
      const { revision } = store.save({ credentialRef, model, enabled, mode: 'auto' }, store.read().revision)
      expect(seen.has(revision)).toBe(false)
      seen.add(revision)
      expect(store.read().revision).toBe(revision)
    }
    // Saving the same value again is a new revision too.
    const same = store.save({ credentialRef, model, enabled: true, mode: 'auto' }, store.read().revision)
    expect(seen.has(same.revision)).toBe(false)
  })

  it('a saved file with a bad nonce or extra keys reads as the default, and a file from before the nonce still reads', async () => {
    const dir = await dataDir()
    const off = { enabled: false, mode: 'manual' }
    const settings = { credentialRef, model, enabled: true, mode: 'auto' }
    for (const body of [
      { settings, nonce: 'short' },
      { settings, nonce: 7 },
      { settings, nonce: '0e6f4c1a-6a46-4fb0-9a8b-0f5e9b1c2d3e', extra: 1 },
      { settings: { enabled: 'yes', mode: 'auto' }, nonce: '0e6f4c1a-6a46-4fb0-9a8b-0f5e9b1c2d3e' },
    ]) {
      plant(dir, 'p', JSON.stringify(body))
      expect(new RefinementSettingsStore(dir, 'p').read().settings, JSON.stringify(body)).toEqual(off)
    }
    plant(dir, 'p', JSON.stringify(settings))
    expect(new RefinementSettingsStore(dir, 'p').read().settings).toEqual(settings)
  })

  it('a profile cannot inherit enabled from any legacy key', async () => {
    const dir = await dataDir()
    // A preset (and a profile document) carrying the retired switch must not turn refinement on.
    const preset = { name: 'legacy', harness: { auto_refine: { enabled: true } } }
    writeFileSync(join(dir, 'legacy.preset.json'), JSON.stringify(preset))
    writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...preset, auto_refine: { enabled: true } }))
    expect(new RefinementSettingsStore(dir, 'legacy').read().settings).toEqual({
      enabled: false,
      mode: 'manual',
    })
  })

  it('invalidates a deleted key, rejects an empty replacement and binds a new revision', async () => {
    const dir = await dataDir()
    const store = new RefinementSettingsStore(dir, 'p')
    const credentials = createCredentialStore({ root: dir })
    const nextRef = 'secret://generic/00000000-0000-4000-8000-000000000002'
    const original = { credentialRef, model, enabled: true, mode: 'auto' } as const
    const next = { ...original, credentialRef: nextRef }
    expect(refinementSettingsRevision(next)).not.toBe(refinementSettingsRevision(original))
    expect(refinementSettingsRevision({ ...original, model: 'company/another-review' })).not.toBe(
      refinementSettingsRevision(original),
    )
    const saved = store.save(original, store.read().revision)
    await credentials.remove(credentialRef)
    expect(store.read()).toEqual({
      revision: saved.revision,
      settings: { ...original, enabled: false },
      credentialMissing: true,
    })
    const metadata = { label: 'Replacement', createdAt: new Date(0).toISOString() }
    await credentials.putGeneric(nextRef, '\u200b', metadata)
    expect(() => store.save(next, saved.revision)).toThrow('CONFIG_INVALID_INPUT')
    await credentials.putGeneric(nextRef, 'fixture-replacement-key', metadata)
    const replacement = store.save(next, saved.revision)
    expect(replacement.revision).not.toBe(saved.revision)
    expect(store.read()).toEqual({ ...replacement, settings: next })
  })

  it('serves the port: current() is the store snapshot', async () => {
    const store = new RefinementSettingsStore(await dataDir(), 'p')
    const port: RefinementSettingsPort = store
    const before = port.current()
    store.save({ credentialRef, model, enabled: true, mode: 'auto' }, before.revision)
    expect(port.current().settings).toEqual({ credentialRef, model, enabled: true, mode: 'auto' })
    expect(port.current().revision).not.toBe(before.revision)
  })
})
