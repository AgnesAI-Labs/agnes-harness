// Build Web and @agnes/jev-web first. This exercises real browser ESM/CSS loading and roster disposal.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

if (!process.env.AGNES_PLAYWRIGHT_MODULE)
  throw Error('Set AGNES_PLAYWRIGHT_MODULE to an installed Playwright entry')
const { chromium } = await import(pathToFileURL(process.env.AGNES_PLAYWRIGHT_MODULE).href)
const require = createRequire(resolve('packages/web/package.json'))
const { build } = require('esbuild')
const temporary = await mkdtemp(join(tmpdir(), 'agh-jev-plugin-browser-'))
const evidence = process.env.AGNES_BROWSER_EVIDENCE ?? temporary
await mkdir(evidence, { recursive: true })
const web = resolve('packages/web/dist/web')
const plugin = resolve('packages/jev-web/client')
await build({
  entryPoints: [resolve('tools/acceptance/jev-client-plugin-fixture.mjs')],
  outfile: join(temporary, 'fixture.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2023',
  external: ['@agnes/cordis', '@agnes/web-client'],
})
const original = await readFile(join(web, 'index.html'), 'utf8')
const html = original.replace(
  /<script[^>]*src="\/app.js"[^>]*><\/script>/,
  '<script type="module" src="/fixture.js"></script>',
)
assert.notEqual(html, original, 'fixture must replace the host app entry')
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname
    if (pathname === '/') {
      response.setHeader('Content-Type', 'text/html')
      response.end(html)
      return
    }
    const file =
      pathname === '/fixture.js'
        ? join(temporary, 'fixture.js')
        : pathname.startsWith('/plugin/')
          ? join(plugin, pathname.slice(8))
          : join(web, pathname.slice(1))
    if (![temporary, plugin, web].some((root) => resolve(file).startsWith(`${root}/`))) {
      response.writeHead(403).end()
      return
    }
    response.setHeader(
      'Content-Type',
      { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' }[
        extname(file)
      ] ?? 'application/octet-stream',
    )
    response.end(await readFile(file))
  } catch {
    response.writeHead(404).end()
  }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const browser = await chromium.launch({
  headless: true,
  ...(process.env.AGNES_CHROMIUM_EXECUTABLE ? { executablePath: process.env.AGNES_CHROMIUM_EXECUTABLE } : {}),
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  await page.waitForFunction(() => window.fixture)
  assert.equal(await page.locator('.jev-decision-graph').count(), 0)
  await page.evaluate(() => window.fixture.enable(true))
  await page.locator('.jev-open-comparison').waitFor({ state: 'attached' })
  assert.equal(await page.locator('.jev-open-comparison').isVisible(), false)
  await page.evaluate(() => window.fixture.newDraft())
  await page.locator('.jev-open-comparison').waitFor({ state: 'visible' })
  assert.equal(await page.locator('[data-workbench-surface=aside]').isVisible(), false)
  await page.evaluate(() => window.fixture.selectJev())
  await page.locator('[data-workbench-surface=aside]').waitFor({ state: 'visible' })
  assert.equal(await page.locator('.jev-open-comparison').isVisible(), false)
  await page.screenshot({ path: join(evidence, 'jev-plugin-desktop.png') })
  await page.setViewportSize({ width: 650, height: 850 })
  await page.locator('.jev-workspace-views [data-workspace-view=graph]').click()
  await page.locator('.jev-workspace-views [data-workspace-view=chat]').click()
  assert.equal(await page.locator('[data-workbench-surface=conversation]').isVisible(), true)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.evaluate(() => window.fixture.openComparison())
  await page.waitForFunction(() => document.querySelectorAll('.comparison-lane[data-cut="0"]').length === 2)
  await page.waitForFunction(
    () => Number(getComputedStyle(document.querySelector('.comparison-workspace')).opacity) >= 0.99,
  )
  assert.equal(await page.locator('[data-workbench-surface=workspace]').isVisible(), false)
  const columns = await page
    .locator('.comparison-panes')
    .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
  assert.equal(columns, 3, 'graph + Jev chat + Native chat must render as three columns')
  await page.screenshot({ path: join(evidence, 'jev-plugin-comparison.png') })
  await page.evaluate(() => window.fixture.enable(false))
  assert.equal(await page.locator('.comparison-workspace').count(), 0)
  assert.equal(await page.locator('link[data-plugin="@agnes/jev-web"]').count(), 0)
  assert.equal(await page.evaluate(() => window.fixture.trySubmit()), 'refused')
  await page.evaluate(() => window.fixture.enable(true))
  await page.waitForFunction(() => document.querySelectorAll('.comparison-lane[data-cut="0"]').length === 2)
  await page.waitForFunction(
    () => Number(getComputedStyle(document.querySelector('.comparison-workspace')).opacity) >= 0.99,
  )
  await page.evaluate(() => window.fixture.selectNative())
  for (let cycle = 0; cycle < 10; cycle++) {
    await page.evaluate(() => window.fixture.enable(false))
    assert.equal(
      await page.locator('.jev-decision-graph,.comparison-workspace,.jev-open-comparison').count(),
      0,
    )
    await page.evaluate(() => window.fixture.enable(true))
    assert.equal(await page.locator('.jev-open-comparison').count(), 1)
  }
  await page.evaluate(() => window.fixture.enable(false))
  assert.deepEqual(await page.evaluate(() => window.fixture.state()), {
    forbidden: 0,
    listeners: 0,
    target: undefined,
  })
  assert.deepEqual(errors, [])
  const result = {
    status: 'passed',
    cycles: 10,
    desktop: true,
    mobileRoundTrip: true,
    comparisonColumns: columns,
    unavailableTargetRefused: true,
    backendEffects: 0,
    pageErrors: errors,
  }
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ...result, evidence }))
} finally {
  await browser.close()
  await new Promise((done) => server.close(done))
  if (evidence !== temporary) await rm(temporary, { recursive: true, force: true })
}
