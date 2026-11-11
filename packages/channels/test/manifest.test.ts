import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { channelKind } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import { checkManifest, loadManifest } from '../src/manifest.js'

const fixture = new URL('../testkit/fixtures/example-im.channel.json', import.meta.url)
const base = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, unknown>

describe('channel manifest', () => {
  it('loads and validates the example-im fixture', async () => {
    const manifest = await loadManifest(fileURLToPath(fixture))
    expect(manifest.id).toBe('example-im')
    expect(manifest.capabilities.card).toBe(true)
    const provider = {
      id: manifest.id,
      version: '1.0.0',
      manifest,
      create() {
        throw new Error('unused')
      },
    }
    expect(() => channelKind.validate(provider)).not.toThrow()
    const displayNames = { en: 'Example IM', 'zh-CN': '示例渠道' }
    expect(checkManifest({ ...manifest, displayNames }).displayNames).toEqual(displayNames)
    expect(() => channelKind.validate({ ...provider, manifest: { ...manifest, displayNames } })).not.toThrow()
    expect(checkManifest({ ...manifest, displayNames: { en: 'Example' } }).displayNames).toEqual({
      en: 'Example',
    })
    const icon = 'data:image/png;base64,aGVsbG8='
    expect(checkManifest({ ...manifest, icon }).icon).toBe(icon)
    expect(() => channelKind.validate({ ...provider, manifest: { ...manifest, icon } })).not.toThrow()
    expect(() => channelKind.validate({ ...provider, id: 'another-channel' })).toThrow()
    expect(() => channelKind.validate({ ...provider, create: undefined } as never)).toThrow()
  })

  it('reports schema violations as E_MANIFEST_INVALID with validator detail', () => {
    for (const invalid of [
      { ...base, id: 'ExampleIM' },
      { ...base, extra: 1 },
      ...[
        null,
        'Example',
        { fr: 'Exemple' },
        { en: '' },
        { en: '   ' },
        { en: 'a'.repeat(65) },
        { en: 7 },
      ].map((displayNames) => ({ ...base, displayNames })),
      ...[
        'https://example.com/icon.png',
        './icon.png',
        'data:image/svg+xml;base64,PHN2Zz4=',
        '',
        `data:image/png;base64,${'A'.repeat(32768)}`,
      ].map((icon) => ({ ...base, icon })),
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
