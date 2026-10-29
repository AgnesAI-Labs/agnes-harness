import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import { readUiCss, readWebStyleSource } from '../../../tools/web-style-source.mjs'

const repository = resolve(import.meta.dirname, '../../..')
const web = resolve(repository, 'packages/web')

// The build runs through `process.execPath` plus the `tsx` loader rather than through the `pnpm`
// shim. On Windows `pnpm` is a `.cmd`, and `execFileSync` does not use a shell, so spawning it by
// name failed the whole file with `spawnSync pnpm ENOENT`. This mirrors how the package's own
// `build` script runs the file (`tsx tools/build.ts`), minus the package-manager layer, and the
// repository already drives Node with `--import tsx` elsewhere (see
// `packages/cli/test/acp-concurrency.e2e.test.ts`).
beforeAll(() => {
  execFileSync(process.execPath, ['--import', 'tsx', 'tools/build.ts'], { cwd: web, stdio: 'pipe' })
}, 30_000)

it('ships private conversation styles in the existing three-page style asset', async () => {
  const [base, conversation, built, files] = await Promise.all([
    readWebStyleSource(resolve(web, 'public/style.css')),
    readUiCss(resolve(repository, 'packages/web-ui/src/conversation/messages.css')),
    readFile(resolve(web, 'dist/web/style.css'), 'utf8'),
    readdir(resolve(web, 'dist/web')),
  ])
  expect(built.startsWith(base)).toBe(true)
  expect(built).not.toContain('@import "./styles/')
  expect(files).not.toContain('styles')
  expect(built).toContain(conversation.trim())
  expect(built).toContain('.x-markdown')
  expect(built).toContain('.x-markdown-light')
  expect(built).toContain('.x-markdown-dark')
  expect(built).toContain('.conversation-markdown')
  expect(built).toContain('--text-color: var(--agnes-text-primary)')
  expect(built).not.toContain('.aui\\:')
  expect(files).not.toContain('messages.css')
  expect(files).not.toContain('conversation.css')
  expect(files).not.toContain('conversation-tailwind.css')

  for (const page of ['index', 'admin', 'resources']) {
    const html = await readFile(resolve(web, `dist/web/${page}.html`), 'utf8')
    expect(html).toContain('href="/style.css"')
    expect(html).not.toContain('messages.css')
  }
}, 30_000)

it('resolves the conversation layer from the shared vendor instead of bundling a second app copy', async () => {
  const output = resolve(web, 'dist/web')
  const license = await readFile(resolve(output, 'THIRD-PARTY-NOTICES/ant-design-x-markdown.txt'), 'utf8')
  expect(license).toContain('Copyright (c) 2015-present Ant UED')
  // The presentation can move to a shared chunk; every app module still uses the vendor import.
  const appModules = await Promise.all(
    (await readdir(output))
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFile(resolve(output, file), 'utf8')),
  )
  expect(appModules.some((source) => /\bfrom\s*["']@agnes\/web-ui\/conversation["']/.test(source))).toBe(true)

  const appMaps = (await readdir(output)).filter((file) => file.endsWith('.js.map'))
  const duplicated = []
  for (const file of appMaps) {
    const map = JSON.parse(await readFile(resolve(output, file), 'utf8')) as { sources: string[] }
    if (map.sources.some((source) => source.includes('@ant-design/x-markdown/'))) duplicated.push(file)
  }
  expect(duplicated).toEqual([])

  // The vendor build splits shared modules into hashed chunks that the entry re-exports, so the
  // entry's own map is empty. Follow its imports to the files that actually carry the sources.
  const entry = await readFile(resolve(output, 'vendor/conversation.js'), 'utf8')
  const chunks = [...entry.matchAll(/\.\/(chunk-[\w-]+\.js)/g)].map((match) => `${match[1]}.map`)
  const vendorSources: string[] = []
  for (const file of ['conversation.js.map', ...chunks]) {
    const map = JSON.parse(await readFile(resolve(output, 'vendor', file), 'utf8')) as {
      sources: string[]
    }
    vendorSources.push(...map.sources)
  }
  expect(vendorSources.some((source) => source.includes('node_modules/@assistant-ui/'))).toBe(false)
  expect(vendorSources.some((source) => source.includes('@ant-design/x-markdown/'))).toBe(true)
  expect(vendorSources.some((source) => source.includes('html-react-parser/'))).toBe(true)
  expect(
    vendorSources.some(
      (source) => source.includes('node_modules/react/') || source.includes('node_modules/react-dom/'),
    ),
  ).toBe(false)
  for (const page of ['index', 'admin', 'resources']) {
    const html = await readFile(resolve(output, `${page}.html`), 'utf8')
    expect(html).toContain('"@agnes/web-ui/conversation": "/vendor/conversation.js"')
  }
}, 30_000)
