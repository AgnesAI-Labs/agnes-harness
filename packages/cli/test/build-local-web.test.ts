import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWebServer } from '@agnes/web/server'
import { expect, it } from 'vitest'
import { readUiCss } from '../../../tools/web-style-source.mjs'
import { resolveLaunchResources } from '../launch/resources.js'

it('builds local web assets with the shared platform vendor modules', async () => {
  const output = await mkdtemp(join(tmpdir(), 'agnes-local-web-build-'))
  try {
    const { buildLocalWeb } = await import('../tools/build-local.js')
    await buildLocalWeb(output)

    // Check the actual local distribution, including lazy entries and all vendor/shared chunks.
    const assets = (await readdir(output, { recursive: true })).filter((file) => /\.(js|css|map)$/.test(file))
    expect(assets.some((file) => /^terminal-[A-Z0-9]{8}\.js$/.test(file))).toBe(true)
    const listener = createServer()
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
    const address = listener.address()
    if (!address || typeof address === 'string') throw new Error('No test port')
    const port = address.port
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    const server = await createWebServer({
      root: output,
      wsUrl: 'ws://127.0.0.1:4316',
      token: 'synthetic',
      port,
      origin: `http://127.0.0.1:${port}`,
    })
    try {
      for (const file of assets) {
        const response = await fetch(`${server.url}/${file}`)
        expect(response.status, file).toBe(200)
        expect(Buffer.from(await response.arrayBuffer()), file).toEqual(await readFile(join(output, file)))
      }
    } finally {
      await server.close()
    }
    const app = await readFile(join(output, 'app.js'), 'utf8')
    const appChunks = [...app.matchAll(/from\s+["'](\.\/chunk-[^"']+\.js)["']/g)].map((match) => match[1])
    const chunkSources = await Promise.all(
      appChunks.map((chunk) => readFile(join(output, chunk ?? ''), 'utf8')),
    )
    const html = await readFile(join(output, 'index.html'), 'utf8')
    const antdVendor = await readFile(join(output, 'vendor', 'antd.js'), 'utf8')
    // antd 产物不自包含是正常情况：另一个 vendor 入口（比如 conversation）只要也引用 antd，esbuild 就会把
    // 共享代码提成 chunk，antd.js 只剩再导出的壳，连带 react-is 的版权声明一起搬进 chunk。所以顺着 chunk 找。
    const antdVendorChunks = [...antdVendor.matchAll(/(?:from\s+)?["'](\.\/chunk-[\w-]+\.js)["']/g)].map(
      (match) => match[1],
    )
    const antdVendorSources = [
      antdVendor,
      ...(await Promise.all(
        antdVendorChunks.map((chunk) => readFile(join(output, 'vendor', chunk ?? ''), 'utf8')),
      )),
    ]
    const markdownVendor = await readFile(join(output, 'vendor', 'conversation.js'), 'utf8')
    const markdownLicense = await readFile(
      join(output, 'THIRD-PARTY-NOTICES/ant-design-x-markdown.txt'),
      'utf8',
    )
    expect(markdownLicense).toContain('Copyright (c) 2015-present Ant UED')
    expect(app).toMatch(/from\s+["']react["']/)
    expect([app, ...chunkSources].some((source) => /from\s+["']@agnes\/web-ui["']/.test(source))).toBe(true)
    expect(app).toMatch(/from\s+["']@agnes\/web-ui\/conversation["']/)
    expect(html).toContain('"react": "/vendor/react.js"')
    expect(html).toContain('"@agnes/web-ui": "/vendor/web-ui.js"')
    expect(html).toContain('"recharts": "/vendor/recharts.js"')
    const chartNotice = await readFile(join(output, 'THIRD-PARTY-NOTICES/recharts.txt'), 'utf8')
    expect(chartNotice).toContain('recharts')
    const victoryNotice = await readFile(join(output, 'THIRD-PARTY-NOTICES/victory-vendor.txt'), 'utf8')
    expect(victoryNotice).toContain('Formidable Labs')
    expect(victoryNotice).toContain('Mike Bostock')
    const reactIsNotice = 'Copyright (c) Meta Platforms, Inc. and affiliates.'
    expect(antdVendorSources.some((source) => source.includes(reactIsNotice))).toBe(true)
    expect(markdownVendor).toContain('x-markdown')
    expect(markdownVendor).not.toContain('Dynamic require of "react" is not supported')

    for (const entry of [
      'react.js',
      'react-jsx-runtime.js',
      'react-dom.js',
      'react-dom-client.js',
      'recharts.js',
      'cordis.js',
      'web-client.js',
      'web-ui.js',
    ]) {
      await expect(readFile(join(output, 'vendor', entry), 'utf8')).resolves.toBeTruthy()
    }

    for (const page of ['index.html', 'admin.html', 'resources.html']) {
      const source = await readFile(join(output, page), 'utf8')
      const importMap = source.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1]
      expect(importMap, `${page} import map`).toBeDefined()
      const imports = (JSON.parse(importMap ?? '{}') as { imports: Record<string, string> }).imports
      for (const source of [app, ...chunkSources]) {
        for (const [, specifier] of source.matchAll(
          /^import\s+(?:\{[^}]*\}|[^;\n]+)\s+from\s+["']([^"']+)["']/gm,
        )) {
          if (specifier?.startsWith('.') || specifier?.startsWith('/')) continue
          expect(imports, `${page} resolves browser import ${specifier}`).toHaveProperty(specifier ?? '')
        }
      }
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

    const conversationCss = readUiCss(join(import.meta.dirname, '../../web-ui/src/conversation/messages.css'))
    expect(await readFile(join(output, 'style.css'), 'utf8')).toContain(conversationCss.trim())
    const intelligentUiCss = readUiCss(
      join(import.meta.dirname, '../../web-ui/src/intelligent-ui/styles.css'),
    )
    expect(await readFile(join(output, 'style.css'), 'utf8')).toContain(intelligentUiCss.trim())
    expect(await readFile(join(output, 'style.css'), 'utf8')).toContain('var(--agnes-bg-card)')
    expect(await readFile(join(output, 'style.css'), 'utf8')).toContain('.x-markdown')
    expect(await readFile(join(output, 'style.css'), 'utf8')).toContain('.x-markdown-dark')
    expect(await readFile(join(output, 'style.css'), 'utf8')).toContain('.conversation-markdown')
    const styles = await readFile(join(output, 'style.css'), 'utf8')
    expect(styles).toContain('@layer vendor {')
    expect(styles).not.toMatch(
      /(?:background(?:-color)?|color): var\(--(?:light-bg|dark-bg|text-color)\) !important/,
    )
    expect(styles).toContain('background: var(--light-bg);')
    expect(styles).toContain('background: var(--dark-bg);')
    await expect(readFile(join(output, 'vendor/conversation.css'), 'utf8')).rejects.toThrow()
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
      'vendor/recharts.js',
      'vendor/conversation.js',
      'vendor/x.js',
      'vendor/cordis.js',
      'vendor/web-client.js',
      'vendor/web-ui.js',
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
