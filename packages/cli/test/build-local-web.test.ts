import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveLaunchResources } from '@agnes/cli-launch'
import { expect, it } from 'vitest'

it('builds local web assets with the shared platform vendor modules', async () => {
  const output = await mkdtemp(join(tmpdir(), 'agnes-local-web-build-'))
  try {
    const { buildLocalWeb } = await import('../tools/build-local.js')
    await buildLocalWeb(output)

    const app = await readFile(join(output, 'app.js'), 'utf8')
    const html = await readFile(join(output, 'index.html'), 'utf8')
    const antdVendor = await readFile(join(output, 'vendor', 'antd.js'), 'utf8')
    expect(app).toMatch(/from\s+["']react["']/)
    expect(app).toMatch(/from\s+["']antd["']/)
    expect(app).toMatch(/from\s+["']@agnes\/web-ui\/assistant-ui["']/)
    expect(html).toContain('"react": "/vendor/react.js"')
    expect(antdVendor.includes('Copyright (c) Meta Platforms, Inc. and affiliates.')).toBe(true)

    for (const entry of [
      'react.js',
      'react-jsx-runtime.js',
      'react-dom.js',
      'react-dom-client.js',
      'cordis.js',
      'web-client.js',
    ]) {
      await expect(readFile(join(output, 'vendor', entry), 'utf8')).resolves.toBeTruthy()
    }

    for (const page of ['index.html', 'admin.html', 'resources.html']) {
      const source = await readFile(join(output, page), 'utf8')
      const importMap = source.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1]
      expect(importMap, `${page} import map`).toBeDefined()
      const imports = (JSON.parse(importMap ?? '{}') as { imports: Record<string, string> }).imports
      const linkedAssets = [...source.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)="(\/[^"#?]+)"/g)]
        .map((match) => match[1])
        .filter((asset): asset is string => asset !== undefined)
      for (const asset of [...linkedAssets, ...Object.values(imports)]) {
        expect(asset, `${page} local asset URL`).toMatch(/^\/[\w./-]+$/)
        await expect(
          readFile(join(output, asset.slice(1))),
          `${page} references ${asset}`,
        ).resolves.toBeTruthy()
      }
    }

    const conversationCss = await readFile(
      join(import.meta.dirname, '../../web-ui/src/conversation/messages.css'),
      'utf8',
    )
    expect(await readFile(join(output, 'style.css'), 'utf8')).toContain(conversationCss.trim())
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 30_000)

it('rejects a local package when an HTML or import-map asset is missing', async () => {
  const output = await mkdtemp(join(tmpdir(), 'agnes-local-web-resources-'))
  const web = join(output, 'web')
  try {
    const { buildLocalWeb } = await import('../tools/build-local.js')
    await buildLocalWeb(web)
    await Promise.all([writeFile(join(output, 'daemon.mjs'), ''), writeFile(join(output, 'worker.mjs'), '')])
    const moduleUrl = pathToFileURL(join(output, 'agnes.mjs')).href
    expect(resolveLaunchResources(moduleUrl)).toMatchObject({ mode: 'package', webRoot: web })

    for (const asset of [
      'admin-standalone.js',
      'resources-standalone.js',
      'theme.js',
      'antd.css',
      'tokens.css',
      'vendor/react.js',
      'vendor/react-jsx-runtime.js',
      'vendor/react-dom.js',
      'vendor/react-dom-client.js',
      'vendor/antd.js',
      'vendor/assistant-ui.js',
      'vendor/cordis.js',
      'vendor/web-client.js',
    ]) {
      const path = join(web, asset)
      const contents = await readFile(path)
      await rm(path)
      try {
        expect(() => resolveLaunchResources(moduleUrl), `missing ${asset}`).toThrow(
          'Agnes local launch resources are unavailable',
        )
      } finally {
        await writeFile(path, contents)
      }
    }
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 30_000)
