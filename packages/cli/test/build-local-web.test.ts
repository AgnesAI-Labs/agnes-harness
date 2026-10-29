import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWebServer } from '@agnes/web/server'
import { expect, it } from 'vitest'
import { assertClientExternals } from '../../../tools/web-client-externals.mjs'
import { readUiCss } from '../../../tools/web-style-source.mjs'
import { resolveLaunchResources } from '../launch/resources.js'

it('builds local web assets with the shared platform vendor modules', async () => {
  const output = await mkdtemp(join(tmpdir(), 'agnes-local-web-build-'))
  try {
    const { buildLocalWeb } = await import('../tools/build-local.js')
    const builds = await buildLocalWeb(output)

    // Gate the emitted static module graph, including import-map vendors. Dynamic page chunks
    // must stay outside it. Bytes are deterministic and avoid machine-dependent build time gates.
    const base = resolve('packages/web')
    const emitted = new Map(
      builds
        .flatMap((build) => Object.entries(build.metafile?.outputs ?? {}))
        .map(([file, metadata]) => [resolve(base, file), metadata] as const),
    )
    const pageHtml = await readFile(join(output, 'index.html'), 'utf8')
    const imports: Record<string, string> = JSON.parse(
      pageHtml.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? '{}',
    ).imports
    // bootstrap chooses recovery or the normal workbench with import(). The workbench is
    // mandatory on a normal cold load even though that first edge is dynamic.
    const workbench = [...emitted].find(([, metadata]) => metadata.entryPoint === 'src/app.ts')
    expect(workbench, 'normal workbench entry').toBeDefined()
    const cold = new Set<string>()
    const pending = [join(output, 'app.js'), join(output, 'theme.js'), workbench?.[0] ?? '']
    while (pending.length) {
      const file = pending.pop()
      if (!file || cold.has(file)) continue
      const metadata = emitted.get(file)
      if (!metadata) throw new Error(`Missing emitted module: ${file}`)
      cold.add(file)
      for (const dependency of metadata.imports) {
        if (dependency.kind === 'dynamic-import') continue
        const mapped = imports[dependency.path]
        pending.push(dependency.external && mapped ? join(output, mapped) : resolve(base, dependency.path))
      }
    }
    const coldJsBytes = [...cold].reduce((bytes, file) => bytes + (emitted.get(file)?.bytes ?? 0), 0)
    // Keep the plot engine and offline diagnostics renderer out of home; allow a small
    // margin above the measured delivery graph, rather than the old 9 MiB ceiling.
    expect(coldJsBytes).toBeLessThan(6.75 * 1024 * 1024)
    for (const file of cold)
      for (const input of Object.keys(emitted.get(file)?.inputs ?? {}))
        expect(input).not.toMatch(
          /pages\/(agents|plugins|automation)-page|chart-plot|diagnostics-(bundle|viewer)|react-dom-server|node_modules\/recharts\//,
        )

    // Retrying this optional asset must not retain a failed child-module fetch.
    const chart = builds
      .flatMap((build) => Object.entries(build.metafile?.outputs ?? {}))
      .find(([file]) => file.endsWith('/vendor/recharts.js'))
    expect(chart).toBeDefined()
    const diagnostics = builds
      .flatMap((build) => Object.entries(build.metafile?.outputs ?? {}))
      .find(([file]) => file.endsWith('/vendor/chunk-diagnostics.js'))
    expect(diagnostics).toBeDefined()
    expect(diagnostics?.[1].imports.every((dependency) => dependency.external)).toBe(true)
    expect(
      chart?.[1].imports.every(
        (dependency) =>
          dependency.external &&
          ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].includes(
            dependency.path,
          ),
      ),
    ).toBe(true)

    // Check the actual local distribution, including lazy entries and all vendor/shared chunks.
    const assets = (await readdir(output, { recursive: true })).filter((file) => /\.(js|css|map)$/.test(file))
    expect(assets.some((file) => /^terminal-[A-Z0-9]{8}\.js$/.test(file))).toBe(true)
    expect(assets.filter((file) => file.startsWith('vendor/') && file.endsWith('.css'))).toEqual([])
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
      const favicon = await fetch(`${server.url}/favicon.ico`)
      expect(favicon.status).toBe(200)
      expect(favicon.headers.get('content-type')).toBe('image/png; charset=utf-8')
      expect(Buffer.from(await favicon.arrayBuffer())).toEqual(await readFile(join(output, 'favicon.png')))
      for (const file of assets) {
        const response = await fetch(`${server.url}/${file}`)
        expect(response.status, file).toBe(200)
        expect(Buffer.from(await response.arrayBuffer()), file).toEqual(await readFile(join(output, file)))
      }
    } finally {
      await server.close()
    }
    const app = await readFile(join(output, 'app.js'), 'utf8')
    const moduleSources = await Promise.all(
      Object.keys(builds[0]?.metafile?.outputs ?? {})
        .filter((file) => file.endsWith('.js'))
        .map((file) => readFile(resolve(base, file), 'utf8')),
    )
    const html = await readFile(join(output, 'index.html'), 'utf8')
    const antdVendor = await readFile(join(output, 'vendor', 'antd.js'), 'utf8')
    // antd 产物不自包含是正常情况：另一个 vendor 入口（比如 conversation）只要也引用 antd，esbuild 就会把
    // 共享代码提成 chunk，antd.js 只剩再导出的壳，连带 react-is 的版权声明一起搬进 chunk。所以顺着 chunk 找。
    const antdVendorChunks = [...antdVendor.matchAll(/(?:from\s*)?["'](\.\/chunk-[\w-]+\.js)["']/g)].map(
      (match) => match[1],
    )
    const antdVendorSources = [
      antdVendor,
      ...(await Promise.all(
        antdVendorChunks.map((chunk) => readFile(join(output, 'vendor', chunk ?? ''), 'utf8')),
      )),
    ]
    const markdownVendor = await readFile(join(output, 'vendor', 'conversation.js'), 'utf8')
    // Renderers share markdown code with the public presentation entry. Follow actual imports:
    // an entry may now be a re-export facade rather than containing the library implementation.
    const markdownFiles = new Set<string>()
    const markdownPending = [join(output, 'vendor/conversation.js')]
    const markdownSources: string[] = []
    while (markdownPending.length) {
      const file = markdownPending.pop()
      if (!file || markdownFiles.has(file)) continue
      markdownFiles.add(file)
      markdownSources.push(await readFile(file, 'utf8'))
      for (const dependency of emitted.get(file)?.imports ?? []) {
        if (dependency.kind === 'dynamic-import') continue
        const mapped = imports[dependency.path]
        markdownPending.push(
          dependency.external && mapped ? join(output, mapped) : resolve(base, dependency.path),
        )
      }
    }
    const markdownLicense = await readFile(
      join(output, 'THIRD-PARTY-NOTICES/ant-design-x-markdown.txt'),
      'utf8',
    )
    expect(markdownLicense).toContain('Copyright (c) 2015-present Ant UED')
    expect(app).toMatch(/from\s*["']react["']/)
    expect(moduleSources.some((source) => /from\s*["']@agnes\/web-ui["']/.test(source))).toBe(true)
    expect(moduleSources.some((source) => /from\s*["']@agnes\/web-ui\/conversation["']/.test(source))).toBe(
      true,
    )
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
    expect(markdownVendor).toContain('ConversationMarkdown')
    expect(markdownSources.some((source) => source.includes('x-markdown'))).toBe(true)
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
      expect(source).toContain('<link rel="icon" href="/favicon.png" type="image/png"')
      const importMap = source.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1]
      expect(importMap, `${page} import map`).toBeDefined()
      const imports = (JSON.parse(importMap ?? '{}') as { imports: Record<string, string> }).imports
      for (const build of builds) {
        for (const [file, metadata] of Object.entries(build.metafile?.outputs ?? {})) {
          // The platform's explicit CJS bridge binds only React to the import-map singleton.
          for (const dependency of metadata.imports.filter((item) => item.kind === 'require-call')) {
            expect(dependency.path).toBe('react')
            expect(await readFile(resolve(base, file), 'utf8')).toContain(
              "if (id === 'react') return __agnesSharedReact",
            )
          }
          assertClientExternals(
            {
              outputs: {
                [file]: { imports: metadata.imports.filter((item) => item.kind !== 'require-call') },
              },
            },
            imports,
          )
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
      'vendor/protocol.js',
      'vendor/sdk-browser.js',
      'vendor/web-units-shell.js',
      'vendor/web-locale-catalog.js',
      'vendor/goal-renderers.js',
      'vendor/interaction-renderer.js',
      'vendor/presentation-renderers.js',
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
