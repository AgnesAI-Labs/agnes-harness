import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { buildJudgmentPayload } from '../tools/build-judgment-payload.mjs'
import { ensureJudgmentPayload } from '../tools/ensure-judgment-payload.mjs'

const payload = new URL('../bundled-plugins/judgment/', import.meta.url)
it('mirrors the source row with API 5.17 and exports the real plugin', async () => {
  const source = JSON.parse(readFileSync(new URL('../../judgment/package.json', import.meta.url), 'utf8'))
  const manifest = JSON.parse(readFileSync(new URL('package.json', payload), 'utf8'))
  const { default: disabled, ...row } = source.agnes.plugins[0]
  expect(disabled).toBe(false)
  expect(manifest.agnes.plugins).toEqual([row])
  expect(row).toMatchObject({
    export: 'judgmentPlugin',
    id: 'ext:agnes.judgment/main',
    apiRange: '^5.17.0',
    configReload: 'next-session',
    inject: ['hooks', 'projections', 'eventLog', 'sideCall', 'self'],
  })
  expect(row.configSchema.properties.uses.properties.stop.properties.enabled.default).toBe(false)
  const loaded = await import(/* @vite-ignore */ new URL('index.mjs', payload).href)
  expect(loaded.judgmentPlugin.inject).toEqual(row.inject)
  expect(loaded.CONFIG_SCHEMA).toEqual(row.configSchema)
})
it('builds atomically and refreshes missing or stale payloads without rewriting a fresh one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-judgment-payload-'))
  try {
    cpSync(fileURLToPath(new URL('package.json', payload)), join(root, 'package.json'))
    await ensureJudgmentPayload(root)
    const file = join(root, 'index.mjs'),
      first = readFileSync(file, 'utf8'),
      at = statSync(file).mtimeMs
    await ensureJudgmentPayload(root)
    expect(statSync(file).mtimeMs).toBe(at)
    writeFileSync(file, 'stale')
    utimesSync(file, 0, 0)
    await ensureJudgmentPayload(root)
    expect(readFileSync(file, 'utf8')).toBe(first)
    await buildJudgmentPayload(root)
    expect(readdirSync(root).sort()).toEqual(['index.mjs', 'package.json'])
    for (const match of first.matchAll(/\bfrom\s*["']([^"']+)["']/g))
      expect(match[1]!.startsWith('node:') || match[1] === '@agnes/extension-api').toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
