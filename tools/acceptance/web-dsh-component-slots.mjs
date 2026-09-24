#!/usr/bin/env node
/**
 * Opt-in real-browser acceptance for the DSH-aligned host tree.
 *
 * Set AGNES_PLAYWRIGHT_MODULE to an installed Playwright entry and
 * AGNES_DSH_ACCEPTANCE_URL to an already running Agnes Web URL. The script
 * checks the host tree, settings grid regression, navigation stability and
 * page errors. Set AGNES_DSH_ACCEPTANCE_PLUGINS=1 when the four local DSH
 * example packages are installed and the page has a live session.
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

export const DSH_REQUIRED_SURFACES = Object.freeze([
  ['shell-overlay', '[data-agnes-dsh-shell-overlay]'],
  ['sidebar', 'aside.sidebar'],
  ['settings-content-grid', '#config-form #settings-content-slots'],
  ['rightbar', '#rightbar-panel'],
  ['conversation-header', '[data-agnes-conversation-header]'],
  ['composer', '#composer'],
  ['conversation-view', '[data-slot="conversation.view"]'],
])

export const DSH_PLUGIN_SURFACES = Object.freeze([
  ['input-controls', '[data-demo-plugin="dsh-input-controls"]'],
  ['model-picker', '[data-demo-model]'],
  ['tool-view', '[data-demo-tool-view="bash"]'],
])

export function validateCapture(capture, { plugins = false } = {}) {
  assert.equal(capture.pageErrors.length, 0, `page errors: ${capture.pageErrors.join('; ')}`)
  assert.equal(capture.navigationEntries, 1, 'DSH acceptance must not navigate the page')
  for (const [name] of DSH_REQUIRED_SURFACES)
    assert.equal(capture.surfaces[name], true, `missing DSH host surface: ${name}`)
  if (plugins) {
    for (const [name] of DSH_PLUGIN_SURFACES)
      assert.equal(capture.plugins[name], true, `missing DSH example surface: ${name}`)
  }
  assert.equal(
    capture.settingsGrid,
    true,
    'settings DSH slots must remain inside the config form content grid',
  )
  return capture
}

export async function waitForDshApplicationReady(page) {
  await page.locator('body').waitFor()
  await page.locator('[data-agnes-conversation-header]').waitFor({
    state: 'attached',
    timeout: 15_000,
  })
}

export async function runSelfTest() {
  const capture = {
    pageErrors: [],
    navigationEntries: 1,
    settingsGrid: true,
    surfaces: Object.fromEntries(DSH_REQUIRED_SURFACES.map(([name]) => [name, true])),
    plugins: Object.fromEntries(DSH_PLUGIN_SURFACES.map(([name]) => [name, true])),
  }
  validateCapture(capture, { plugins: true })
  assert.throws(() => validateCapture({ ...capture, navigationEntries: 2 }), /must not navigate the page/)
  assert.throws(() => validateCapture({ ...capture, settingsGrid: false }), /settings DSH slots/)
  console.log(
    `SELF-TEST PASS ${DSH_REQUIRED_SURFACES.length} host surfaces; ${DSH_PLUGIN_SURFACES.length} plugin surfaces`,
  )
  const waited = []
  await waitForDshApplicationReady({
    locator(selector) {
      return {
        async waitFor(options) {
          if (selector === '[data-agnes-conversation-header]')
            assert.deepEqual(options, { state: 'attached', timeout: 15_000 })
          waited.push(selector)
        },
      }
    },
  })
  assert.deepEqual(waited, ['body', '[data-agnes-conversation-header]'])
  console.log('READY-SELF-TEST PASS body and conversation header')
}

async function loadPlaywright() {
  const modulePath = process.env.AGNES_PLAYWRIGHT_MODULE
  if (!modulePath) throw new Error('Set AGNES_PLAYWRIGHT_MODULE to an installed Playwright module entry')
  return import(pathToFileURL(modulePath).href)
}

export async function runBrowserAcceptance() {
  const url = process.env.AGNES_DSH_ACCEPTANCE_URL
  if (!url) throw new Error('Set AGNES_DSH_ACCEPTANCE_URL to a running Agnes Web URL')
  const { chromium } = await loadPlaywright()
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await waitForDshApplicationReady(page)
    const plugins = process.env.AGNES_DSH_ACCEPTANCE_PLUGINS === '1'
    const capture = await page.evaluate(
      ({ required, pluginSurfaces }) => {
        const has = (selector) => document.querySelector(selector) !== null
        return {
          navigationEntries: performance.getEntriesByType('navigation').length,
          settingsGrid: document.querySelector('#settings-content-slots')?.closest('#config-form') !== null,
          surfaces: Object.fromEntries(required.map(([name, selector]) => [name, has(selector)])),
          plugins: Object.fromEntries(pluginSurfaces.map(([name, selector]) => [name, has(selector)])),
        }
      },
      { required: DSH_REQUIRED_SURFACES, pluginSurfaces: DSH_PLUGIN_SURFACES },
    )
    validateCapture({ ...capture, pageErrors }, { plugins })
    console.log(
      `COMPLETE DSH browser acceptance; ${DSH_REQUIRED_SURFACES.length} host surfaces; ${plugins ? DSH_PLUGIN_SURFACES.length : 0} plugin surfaces`,
    )
    return capture
  } finally {
    await browser.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--self-test')) await runSelfTest()
  else await runBrowserAcceptance()
}
