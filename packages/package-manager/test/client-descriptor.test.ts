import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { inspectStaged } from '../src/inspect.js'
import { hashDirectory } from '../src/sources.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(
  options: {
    runtime?: string
    duplicate?: boolean
    legacy?: boolean
    escape?: boolean
    malformed?: boolean
    skinsOnly?: boolean
    emptyDescriptor?: boolean
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-client-descriptor-'))
  roots.push(dir)
  mkdirSync(join(dir, 'client'))
  writeFileSync(join(dir, 'index.mjs'), 'export const panel = { apply() {} }\n')
  writeFileSync(join(dir, 'client', 'index.js'), 'export function apply() {}\n')
  writeFileSync(
    join(dir, 'client', 'agnes.client.json'),
    JSON.stringify(
      options.emptyDescriptor
        ? {}
        : options.skinsOnly
          ? { skins: [{ id: 'example-skin', name: 'Example', css: './skin.css' }] }
          : { client: { entry: './index.js', services: ['panel.version'] } },
    ),
  )
  if (options.skinsOnly) writeFileSync(join(dir, 'client', 'skin.css'), 'body { color: red }\n')
  const rowId = 'ext:example/panel'
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'example-panel',
      version: '1.0.0',
      type: 'module',
      exports: './index.mjs',
      agnes: {
        plugins: [{ export: 'panel', id: rowId, runtime: options.runtime ?? 'in-process' }],
        clientDescriptors: options.malformed
          ? {}
          : options.duplicate
            ? [
                { rowId, path: './client/agnes.client.json' },
                { rowId, path: './client/agnes.client.json' },
              ]
            : [{ rowId, path: './client/agnes.client.json' }],
        ...(options.legacy ? { extensions: ['./extension'] } : {}),
      },
    }),
  )
  if (options.escape) {
    const outside = mkdtempSync(join(tmpdir(), 'agnes-client-escape-'))
    roots.push(outside)
    writeFileSync(join(outside, 'index.js'), 'export {}\n')
    rmSync(join(dir, 'client', 'index.js'))
    symlinkSync(join(outside, 'index.js'), join(dir, 'client', 'index.js'))
  }
  const inspect = () =>
    inspectStaged({
      dir,
      source: { type: 'file', ref: 'file:./panel' },
      fetched: { dir, version: '1.0.0', integrity: hashDirectory(dir, { exclude: [] }), dependencies: {} },
      ceiling: ['ui'],
    })
  return { inspect, rowId }
}

it('archives a client descriptor against its sole in-process backend row', () => {
  const { inspect, rowId } = fixture()
  const { preview } = inspect()
  expect(preview.contributions).toMatchObject([
    {
      kind: 'client',
      rowId,
      path: './client/agnes.client.json',
      client: { entry: 'index.js', services: ['panel.version'] },
    },
  ])
  expect(preview.contributions[0]?.id).toMatch(/^plugin\/[0-9a-f]{16}$/)
})

it('accepts a skin-only descriptor without inventing a browser client', () => {
  const { preview, rowId } = (() => {
    const input = fixture({ skinsOnly: true })
    return { preview: input.inspect().preview, rowId: input.rowId }
  })()
  expect(preview.contributions).toMatchObject([{ kind: 'client', rowId, skins: [{ id: 'example-skin' }] }])
  expect(preview.contributions[0]).not.toHaveProperty('client')
})

it('rejects an empty descriptor', () => {
  expect(() => fixture({ emptyDescriptor: true }).inspect()).toThrow(
    expect.objectContaining({ detail: { reason: 'client-descriptor-content' } }),
  )
})

it.each([
  [{ duplicate: true }, 'duplicate-client-descriptor'],
  [{ runtime: 'isolated' }, 'client-descriptor-row'],
  [{ malformed: true }, 'client-descriptors'],
] as const)('rejects invalid descriptor ownership', (options, reason) => {
  expect(() => fixture(options).inspect()).toThrow(expect.objectContaining({ detail: { reason } }))
})

it('rejects a descriptor combined with the old executable extension list with a migration hint', () => {
  expect(() => fixture({ legacy: true }).inspect()).toThrow(/migrate the backend to agnes.plugins/)
})

it('refuses a symlinked asset before it can enter an immutable snapshot', () => {
  expect(() => fixture({ escape: true }).inspect()).toThrow(/symbolic link/)
})
