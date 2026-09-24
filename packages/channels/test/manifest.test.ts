import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkManifest, loadManifest } from '../src/manifest.js'

const fixture = new URL('../testkit/fixtures/dingtalk.channel.json', import.meta.url)
const base = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, unknown>

describe('channel manifest', () => {
  it('loads and validates the dingtalk fixture', async () => {
    const manifest = await loadManifest(fileURLToPath(fixture))
    expect(manifest.id).toBe('dingtalk')
    expect(manifest.capabilities.card).toBe(true)
  })

  it('reports schema violations as E_MANIFEST_INVALID with validator detail', () => {
    for (const invalid of [
      { ...base, id: 'DingTalk' },
      { ...base, extra: 1 },
      { ...base, limits: { textChars: 0, cardBytes: 1, editWindowMs: 0 } },
    ]) {
      try {
        checkManifest(invalid)
        throw new Error('expected invalid manifest')
      } catch (error) {
        expect(error).toMatchObject({ code: 'E_MANIFEST_INVALID' })
        expect((error as { detail?: { errors?: unknown[] } }).detail?.errors?.length).toBeGreaterThan(0)
      }
    }
  })

  it('requires connection.default to be one of connection.modes', () => {
    expect(() => checkManifest({ ...base, connection: { modes: ['stream'], default: 'webhook' } })).toThrow(
      /default.*modes/,
    )
  })

  it('rejects overlapping required and optional credential names', () => {
    const credentials = base.credentials as Record<string, unknown>
    expect(() => checkManifest({ ...base, credentials: { ...credentials, optional: ['clientId'] } })).toThrow(
      /overlap/,
    )
  })

  it('requires card capability when cardAction is declared', () => {
    const capabilities = base.capabilities as Record<string, unknown>
    expect(() => checkManifest({ ...base, capabilities: { ...capabilities, card: false } })).toThrow(
      /cardAction.*card/,
    )
  })

  it('normalizes unreadable files and malformed JSON into E_MANIFEST_INVALID', async () => {
    await expect(
      loadManifest(fileURLToPath(new URL('./missing.channel.json', import.meta.url))),
    ).rejects.toMatchObject({
      code: 'E_MANIFEST_INVALID',
    })
    await expect(
      loadManifest(fileURLToPath(new URL('./manifest.test.ts', import.meta.url))),
    ).rejects.toMatchObject({
      code: 'E_MANIFEST_INVALID',
    })
  })
})
