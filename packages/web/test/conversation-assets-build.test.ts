import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, expect, it } from 'vitest'

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
    readFile(resolve(web, 'public/style.css'), 'utf8'),
    readFile(resolve(repository, 'packages/web-ui/src/conversation/messages.css'), 'utf8'),
    readFile(resolve(web, 'dist/web/style.css'), 'utf8'),
    readdir(resolve(web, 'dist/web')),
  ])
  expect(built.startsWith(base)).toBe(true)
  expect(built).toContain(conversation.trim())
  for (const sheet of ['runtime-process.css'])
    expect(built).toContain((await readFile(resolve(web, 'public', sheet), 'utf8')).trim())
  expect(built).not.toContain('.jev-decision-graph')
  expect(built).not.toContain('.comparison-workspace')
  expect(files).not.toContain('jev-workspace.css')
  expect(files).not.toContain('jev-graph.css')
  for (const file of files.filter((file) => file.endsWith('.js.map'))) {
    const map = JSON.parse(await readFile(resolve(web, 'dist/web', file), 'utf8')) as { sources: string[] }
    expect(map.sources.filter((source) => /\/(jev-web|jev-runtime|jev-trace)\//.test(source))).toEqual([])
  }
  expect(built).toContain('.x-markdown')
  expect(built).toContain('.x-markdown-light')
  expect(built).toContain('.x-markdown-dark')
  expect(built).toContain('.conversation-markdown')
  expect(built).toContain('--text-color: var(--agnes-text-primary)')
  expect(files).not.toContain('messages.css')
  expect(files).not.toContain('assistant-ui.css')

  for (const page of ['index', 'admin', 'resources']) {
    const html = await readFile(resolve(web, `dist/web/${page}.html`), 'utf8')
    expect(html).toContain('href="/style.css"')
    expect(html).not.toContain('messages.css')
  }
}, 30_000)

it('resolves assistant-ui from the shared vendor instead of bundling a second app copy', async () => {
  const output = resolve(web, 'dist/web')
  const license = await readFile(resolve(output, 'THIRD-PARTY-NOTICES/ant-design-x-markdown.txt'), 'utf8')
  expect(license).toContain('Copyright (c) 2015-present Ant UED')
  const app = await readFile(resolve(output, 'app.js'), 'utf8')
  expect(/from\s+["']@agnes\/web-ui\/assistant-ui["']/.test(app)).toBe(true)

  const appMaps = (await readdir(output)).filter((file) => file.endsWith('.js.map'))
  const duplicated = []
  for (const file of appMaps) {
    const map = JSON.parse(await readFile(resolve(output, file), 'utf8')) as { sources: string[] }
    if (map.sources.some((source) => source.includes('node_modules/@assistant-ui/'))) duplicated.push(file)
  }
  expect(duplicated).toEqual([])

  const vendor = JSON.parse(await readFile(resolve(output, 'vendor/assistant-ui.js.map'), 'utf8')) as {
    sources: string[]
  }
  expect(vendor.sources.some((source) => source.includes('node_modules/@assistant-ui/react/'))).toBe(true)
  expect(vendor.sources.some((source) => source.includes('@ant-design/x-markdown/'))).toBe(true)
  expect(vendor.sources.some((source) => source.includes('html-react-parser/'))).toBe(true)
  expect(
    vendor.sources.some(
      (source) => source.includes('node_modules/react/') || source.includes('node_modules/react-dom/'),
    ),
  ).toBe(false)
  for (const page of ['index', 'admin', 'resources']) {
    const html = await readFile(resolve(output, `${page}.html`), 'utf8')
    expect(html).toContain('"@agnes/web-ui/assistant-ui": "/vendor/assistant-ui.js"')
  }
}, 30_000)
