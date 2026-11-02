import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_REFINEMENT_SETTINGS } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { type RefinementSettingsPort, RefinementSettingsStore } from '../src/refinement-settings.js'

const dirs: string[] = []
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-refinement-'))
  dirs.push(dir)
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
  it('defaults to off when the file is missing, corrupt or has unknown fields', () => {
    const dir = dataDir()
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
    plant(dir, 'p', '{"enabled":true,"mode":"auto"}')
    expect(new RefinementSettingsStore(dir, 'p').read().settings).toEqual({ enabled: true, mode: 'auto' })
  })

  it('save rejects a stale revision', () => {
    const store = new RefinementSettingsStore(dataDir(), 'p')
    const first = store.read()
    const saved = store.save({ enabled: true, mode: 'auto' }, first.revision)
    expect(saved.revision).not.toBe(first.revision)
    expect(store.read()).toEqual({ settings: { enabled: true, mode: 'auto' }, revision: saved.revision })
    expect(() => store.save({ enabled: false, mode: 'manual' }, first.revision)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_REVISION_CONFLICT' }),
    )
    expect(store.read().settings).toEqual({ enabled: true, mode: 'auto' })
    expect(() => store.save({ enabled: 1, mode: 'auto' } as never, saved.revision)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID_INPUT' }),
    )
  })

  it('keeps one file per profile under refinement/<sha256(profile)>.json', () => {
    const dir = dataDir()
    const a = new RefinementSettingsStore(dir, 'a')
    const b = new RefinementSettingsStore(dir, 'b')
    a.save({ enabled: true, mode: 'manual' }, a.read().revision)
    expect(b.read().settings.enabled).toBe(false)
    expect(readdirSync(join(dir, 'refinement'))).toEqual([
      `${createHash('sha256').update('a').digest('hex')}.json`,
    ])
    expect(JSON.parse(readFileSync(fileOf(dir, 'a'), 'utf8'))).toEqual({ enabled: true, mode: 'manual' })
  })

  it('a profile cannot inherit enabled from any legacy key', () => {
    const dir = dataDir()
    // A preset (and a profile document) carrying the retired switch must not turn refinement on.
    const preset = { name: 'legacy', harness: { auto_refine: { enabled: true } } }
    writeFileSync(join(dir, 'legacy.preset.json'), JSON.stringify(preset))
    writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...preset, auto_refine: { enabled: true } }))
    expect(new RefinementSettingsStore(dir, 'legacy').read().settings).toEqual({
      enabled: false,
      mode: 'manual',
    })
  })

  it('serves the port: current() is the store snapshot', () => {
    const store = new RefinementSettingsStore(dataDir(), 'p')
    const port: RefinementSettingsPort = store
    const before = port.current()
    store.save({ enabled: true, mode: 'auto' }, before.revision)
    expect(port.current().settings).toEqual({ enabled: true, mode: 'auto' })
    expect(port.current().revision).not.toBe(before.revision)
  })
})
