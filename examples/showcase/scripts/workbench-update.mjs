/** Isolated old-version installation against the current reserved bundled catalogue. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { runtime, until } from '../pharma-gmp/scripts/runtime.mjs'

const browser = await chromium.launch({ headless: true })
const baseline = process.env.AGH_SHOWCASE_OLD_REF ?? '955207c2bbedea45c8fd856edb7e5723622d9516'
let rt, payload, backup, activeOutput
try {
  for (const app of ['aerospace-quality', 'pharma-gmp']) {
    rt = await runtime(false, app, { demoModel: true })
    const output = resolve(
      process.env.AGH_SHOWCASE_UPDATE_SHOTS ?? 'outputs/workbench-updates',
      app,
      'workbench2',
    )
    await mkdir(output, { recursive: true })
    activeOutput = output
    payload = resolve('packages/cli/dist/local/bundled-examples/showcase', app)
    backup = join(rt.root, 'current-payload')
    await cp(payload, backup, { recursive: true })
    const current = JSON.parse(await readFile(join(payload, 'package.json'), 'utf8'))
    assert.equal(current.version, '1.1.0')
    const old = JSON.parse(
      execFileSync('git', ['show', `${baseline}:examples/showcase/${app}/package.json`], {
        encoding: 'utf8',
      }),
    )
    await writeFile(
      join(payload, 'package.json'),
      JSON.stringify(
        { ...current, version: old.version, agnes: { ...current.agnes, application: old.agnes.application } },
        null,
        2,
      ),
    )
    const clientFiles = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', baseline, '--', `examples/showcase/${app}/client`],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
    for (const file of clientFiles) {
      const local = file.slice(`examples/showcase/${app}/`.length)
      await writeFile(join(payload, local), execFileSync('git', ['show', `${baseline}:${file}`]))
    }
    // Refresh this task's daemon catalogue after changing only this task's built fixture payload.
    await rt.restart()
    const source = { type: 'file', ref: `file:./bundled-examples/showcase/${app}` }
    const inspected = await rt.completed(
      await rt.client.packages.inspect({ ...(await rt.command()), source }),
    )
    assert.equal(inspected.preview.version, '1.0.0')
    assert.deepEqual(inspected.preview.blockers, [])
    await rt.completed(
      await rt.client.packages.install({
        ...(await rt.command()),
        source,
        expectedIntegrity: inspected.preview.integrity,
      }),
    )
    await rt.completed(
      await rt.client.packages.trust({
        ...(await rt.command()),
        id: current.name,
        expectedIntegrity: inspected.preview.integrity,
        capabilityHash: inspected.preview.capabilityHash,
      }),
    )
    await rt.completed(await rt.client.packages.enable({ ...(await rt.command()), id: current.name }))
    await rm(payload, { recursive: true })
    await cp(backup, payload, { recursive: true })
    backup = undefined
    await rt.restart()
    await rt.startWeb()
    const evidence = {
      app,
      node: process.version,
      from: '1.0.0',
      to: '1.1.0',
      source,
      root: rt.root.replace(homedir(), '~'),
      screenshots: [],
      passed: false,
    }
    for (const [locale, theme] of [
      ['zh-CN', 'light'],
      ['en', 'dark'],
    ]) {
      const context = await browser.newContext({
        viewport: { width: 1600, height: 1100 },
        locale,
        colorScheme: theme,
      })
      await context.addInitScript(
        ({ locale, theme }) => {
          localStorage.setItem('agnes-locale', locale)
          localStorage.setItem('agnes-theme', theme)
        },
        { locale, theme },
      )
      const page = await context.newPage()
      await page.goto(`${rt.url}/?page=plugins`)
      const row = page.locator(`.plugin-row[data-plugin-id="${current.name}"]`)
      await row.waitFor({ timeout: 60000 })
      await row.locator('.agh-list-row-title, .plugin-details-button').first().click()
      await page.getByTestId('plugin-versions-tab').waitFor({ timeout: 30000 })
      assert.ok((await page.locator('#plugin-detail').innerText()).includes('1.0.0 → 1.1.0'))
      await page.getByTestId('plugin-versions-tab').click()
      const update = page.getByRole('button', { name: locale === 'en' ? /Review update/ : /审核更新/ })
      await update.waitFor()
      await until(() => update.isEnabled(), Boolean, 'update review enabled', 30000)
      assert.equal(await update.isEnabled(), true)
      const file = `11-bundled-update-${locale}-${theme}.png`
      await page.screenshot({ path: join(output, file), fullPage: true, animations: 'disabled' })
      evidence.screenshots.push(file)
      await update.click()
      const review = page.locator('.install-review:visible')
      await review.waitFor({ timeout: 30000 })
      assert.ok((await review.innerText()).includes('1.1.0'))
      const reviewFile = `12-update-review-${locale}-${theme}.png`
      await page.screenshot({ path: join(output, reviewFile), fullPage: true, animations: 'disabled' })
      evidence.screenshots.push(reviewFile)
      await context.close()
    }
    evidence.passed = true
    await writeFile(join(output, 'update-evidence.json'), JSON.stringify(evidence, null, 2))
    await rt.dispose()
    rt = undefined
  }
} catch (error) {
  if (activeOutput) {
    for (const context of browser.contexts())
      for (const page of context.pages())
        await page
          .screenshot({ path: join(activeOutput, 'diagnostic-update-failure.png'), fullPage: true })
          .catch(() => {})
    await writeFile(
      join(activeOutput, 'update-failure.json'),
      JSON.stringify({ failure: String(error.stack ?? error), root: rt?.root }, null, 2).replaceAll(
        homedir(),
        '~',
      ),
    )
  }
  throw error
} finally {
  if (backup) {
    await rm(payload, { recursive: true })
    await cp(backup, payload, { recursive: true })
  }
  await rt?.dispose()
  await browser.close()
}
