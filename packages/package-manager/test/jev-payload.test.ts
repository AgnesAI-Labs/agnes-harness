import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { OPTIONAL_BUNDLED_PACKAGES } from '../src/bundled-plugin-source.js'
import { requireGeneratedEntry } from '../src/sources.js'
import { buildJevPayload } from '../tools/build-jev-payload.mjs'

const read = (url: URL) => JSON.parse(readFileSync(url, 'utf8'))
const payloadUrl = new URL('../bundled-plugins/jev-loop/', import.meta.url)
const source = read(new URL('../../loop-jev/package.json', import.meta.url))
const payload = read(new URL('package.json', payloadUrl))

it('registers the Jev payload as an optional bundled package with its real identity', () => {
  expect(OPTIONAL_BUNDLED_PACKAGES).toContainEqual({
    name: 'jev-loop',
    id: payload.name,
    version: payload.version,
    license: payload.license,
    ref: 'file:./bundled-plugins/jev-loop',
    sourcePath: 'package-manager/bundled-plugins/jev-loop',
    build: 'pnpm --filter @agnes/package-manager build:jev-payload',
  })
  expect(payload.version).not.toBe('0.0.0')
  expect(payload.agnes.provides).toEqual(['loop'])
  expect(payload.agnes.hostProvidedExternals).toHaveProperty('@agnes/extension-api')
})

it('keeps the payload plugin row identical to packages/loop-jev except that installing enables it', () => {
  const [sourceRow] = source.agnes.plugins
  const [payloadRow] = payload.agnes.plugins
  expect(source.agnes.plugins).toHaveLength(1)
  expect(payload.agnes.plugins).toHaveLength(1)
  expect(sourceRow.default).toBe(false)
  expect(payloadRow).not.toHaveProperty('default')
  const { default: _default, ...mirrored } = sourceRow
  expect(payloadRow).toEqual(mirrored)
  expect(payload.agnes.metadata).toEqual(sourceRow.metadata)
})

it('ships the same NOTICE as packages/loop-jev', () => {
  expect(readFileSync(new URL('NOTICE', payloadUrl), 'utf8')).toBe(
    readFileSync(new URL('../../loop-jev/NOTICE', import.meta.url), 'utf8'),
  )
})

it('exports the plugin named by the row from the generated index.mjs', async () => {
  const entry = new URL('index.mjs', payloadUrl)
  let loaded: Record<string, unknown>
  try {
    loaded = await import(/* @vite-ignore */ entry.href)
  } catch (error) {
    throw new Error(
      'bundled-plugins/jev-loop/index.mjs is missing or does not load; generate it with `pnpm --filter @agnes/package-manager build:jev-payload`',
      { cause: error },
    )
  }
  const name = payload.agnes.plugins[0].export
  expect(Object.keys(loaded)).toContain(name)
  const plugin = loaded[name] as { apply?: unknown }
  expect(typeof plugin.apply).toBe('function')
})

it('imports only node built-ins and the modules the manifest says the host provides', () => {
  const text = readFileSync(new URL('index.mjs', payloadUrl), 'utf8')
  const specifiers = new Set<string>()
  // Static `import ... from "x"`, side-effect `import "x"`, `export ... from "x"` and `import("x")`.
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g))
    specifiers.add(match[1] ?? '')
  const provided = Object.keys(payload.agnes.hostProvidedExternals)
  expect(specifiers.size).toBeGreaterThan(0)
  for (const specifier of specifiers)
    expect(
      specifier.startsWith('node:') || provided.includes(specifier),
      `index.mjs imports "${specifier}", which is neither a node: module nor in hostProvidedExternals`,
    ).toBe(true)
  // The host copy of each provided module is the one that must run: it is imported, not bundled.
  for (const name of provided) expect(specifiers).toContain(name)
})

it('writes the bundle in one step and leaves no temporary file behind', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-jev-payload-'))
  try {
    cpSync(fileURLToPath(new URL('package.json', payloadUrl)), join(directory, 'package.json'))
    await buildJevPayload(directory)
    const first = readFileSync(join(directory, 'index.mjs'), 'utf8')
    await buildJevPayload(directory)
    expect(readFileSync(join(directory, 'index.mjs'), 'utf8')).toBe(first)
    expect(readdirSync(directory).sort()).toEqual(['index.mjs', 'package.json'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('tells a development checkout without the generated bundle how to build it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-jev-missing-'))
  try {
    cpSync(fileURLToPath(new URL('package.json', payloadUrl)), join(directory, 'package.json'))
    expect(() => requireGeneratedEntry('file:./bundled-plugins/jev-loop', directory)).toThrow(
      /no generated \.\/index\.mjs.*pnpm --filter @agnes\/package-manager build:jev-payload/,
    )
    // Other bundled packages have no generated entry and are not checked.
    expect(() => requireGeneratedEntry('file:./bundled-plugins/skill-helper', directory)).not.toThrow()
    // Once the bundle exists the check passes.
    writeFileSync(join(directory, 'index.mjs'), 'export {}\n')
    expect(() => requireGeneratedEntry('file:./bundled-plugins/jev-loop', directory)).not.toThrow()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
