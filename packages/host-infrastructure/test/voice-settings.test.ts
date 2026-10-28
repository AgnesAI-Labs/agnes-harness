import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { VoiceSettingsStore, voiceSettingsRevision } from '../src/voice-settings.js'

const dirs: string[] = []
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-voice-settings-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const changed = (patch: Partial<VoiceSettings['input']>): VoiceSettings => ({
  ...structuredClone(DEFAULT_VOICE_SETTINGS),
  account: 'account-a',
  input: { ...DEFAULT_VOICE_SETTINGS.input, ...patch },
})

it('reads defaults when no file exists', async () => {
  const snapshot = await new VoiceSettingsStore(dataDir(), 'default').read()
  expect(snapshot).toEqual({
    settings: DEFAULT_VOICE_SETTINGS,
    revision: voiceSettingsRevision(DEFAULT_VOICE_SETTINGS),
  })
  // The frozen defaults are never handed out.
  expect(Object.isFrozen(snapshot.settings)).toBe(false)
  snapshot.settings.input.language = 'zh'
  expect(DEFAULT_VOICE_SETTINGS.input.language).toBe('')
})

it('saves against the current revision and refuses a stale one', async () => {
  const dir = dataDir()
  const store = new VoiceSettingsStore(dir, 'default')
  const rev0 = (await store.read()).revision
  const first = changed({ language: 'zh' })
  const saved = await store.save(first, rev0)
  expect(saved).toEqual({ settings: first, revision: voiceSettingsRevision(first) })
  expect(await new VoiceSettingsStore(dir, 'default').read()).toEqual(saved)
  await expect(store.save(changed({ language: 'en' }), rev0)).rejects.toMatchObject({
    code: 'CONFIG_REVISION_CONFLICT',
    current: saved,
  })
  expect((await store.read()).settings.input.language).toBe('zh')
})

it('refuses settings outside the schema', async () => {
  const store = new VoiceSettingsStore(dataDir(), 'default')
  const { revision } = await store.read()
  await expect(store.save(changed({ maxSeconds: 121 }), revision)).rejects.toMatchObject({
    code: 'CONFIG_INVALID_INPUT',
  })
  await expect(
    store.save({ ...changed({}), extra: true } as unknown as VoiceSettings, revision),
  ).rejects.toMatchObject({ code: 'CONFIG_INVALID_INPUT' })
  expect((await store.read()).settings).toEqual(DEFAULT_VOICE_SETTINGS)
})

it('reads a corrupt file as defaults', async () => {
  const dir = dataDir()
  const store = new VoiceSettingsStore(dir, 'default')
  await store.save(changed({ language: 'zh' }), (await store.read()).revision)
  const [file] = readdirSync(join(dir, 'voice'))
  for (const text of ['{', JSON.stringify({ account: 7 }), ' '.repeat(1024 * 1024 + 1)]) {
    writeFileSync(join(dir, 'voice', String(file)), text)
    expect((await store.read()).settings).toEqual(DEFAULT_VOICE_SETTINGS)
  }
})

it('keeps one 0600 file per profile', async () => {
  const dir = dataDir()
  for (const profile of ['a', 'b']) {
    const store = new VoiceSettingsStore(dir, profile)
    await store.save(changed({ language: profile === 'a' ? 'zh' : 'en' }), (await store.read()).revision)
  }
  const files = readdirSync(join(dir, 'voice'))
  expect(files).toHaveLength(2)
  for (const file of files) expect(file).toMatch(/^[0-9a-f]{64}\.json$/)
  expect((await new VoiceSettingsStore(dir, 'a').read()).settings.input.language).toBe('zh')
  expect((await new VoiceSettingsStore(dir, 'b').read()).settings.input.language).toBe('en')
  if (process.platform !== 'win32') {
    expect(statSync(join(dir, 'voice')).mode & 0o777).toBe(0o700)
    for (const file of files) expect(statSync(join(dir, 'voice', file)).mode & 0o777).toBe(0o600)
  }
})

it('serialises concurrent saves so exactly one wins a revision', async () => {
  const dir = dataDir()
  mkdirSync(join(dir, 'voice'), { recursive: true })
  const store = new VoiceSettingsStore(dir, 'default')
  const { revision } = await store.read()
  const results = await Promise.allSettled([
    store.save(changed({ language: 'zh' }), revision),
    new VoiceSettingsStore(dir, 'default').save(changed({ language: 'en' }), revision),
  ])
  expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
})
