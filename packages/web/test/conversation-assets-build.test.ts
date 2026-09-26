import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { beforeAll, expect, it } from 'vitest'

const repository = resolve(import.meta.dirname, '../../..')
const web = resolve(repository, 'packages/web')

beforeAll(() => {
  execFileSync('pnpm', ['--filter', '@agnes/web', 'build'], { cwd: repository, stdio: 'pipe' })
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
  expect(files).not.toContain('messages.css')

  for (const page of ['index', 'admin', 'resources']) {
    const html = await readFile(resolve(web, `dist/web/${page}.html`), 'utf8')
    expect(html).toContain('href="/style.css"')
    expect(html).not.toContain('messages.css')
  }
}, 30_000)

it('resolves assistant-ui from the shared vendor instead of bundling a second app copy', async () => {
  const output = resolve(web, 'dist/web')
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
