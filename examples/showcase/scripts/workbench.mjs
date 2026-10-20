/** Scripted, isolated browser acceptance of the declared application workbench. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { runtime, toolResult, until } from '../pharma-gmp/scripts/runtime.mjs'

if (!process.env.AGH_SHOWCASE_SKIP_BUILD)
  execFileSync(process.execPath, ['tools/toolchain/run.mjs', '--filter', '@agnes/cli', 'build:local'], {
    stdio: 'inherit',
  })
const descriptor = JSON.parse(
  await readFile(new URL('../aerospace-quality/client/agnes.client.json', import.meta.url), 'utf8'),
)
const brandModes = descriptor.skins[0].tokens['--agnes-brand-primary']
let rt
const output = resolve(process.env.AGH_SHOWCASE_SHOTS ?? 'outputs/aerospace-workbench')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const evidence = {
  roots: [],
  node: process.version,
  model: 'demo-model',
  usd: 0,
  screenshots: [],
  sessions: [],
  sessionBudgets: [],
  errors: [],
  passed: false,
}
console.log(JSON.stringify({ roots: [], output }))
const packageId = '@agnes-showcase/aerospace-quality'
let active, activeTurn
async function shot(page, label, locale, theme) {
  await page.locator('.sidebar-head').waitFor({ state: 'attached', timeout: 30000 })
  if (!['01-gallery', '02-install-review', '03-adoption-consent'].includes(label))
    await page.waitForFunction(
      (expected) =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--agnes-brand-primary')
          .trim()
          .toLowerCase() === expected,
      brandModes[theme].toLowerCase(),
      { timeout: 45000 },
    )
  await page.evaluate(() => document.fonts.ready)
  if (await page.locator('.task-heading').isVisible())
    assert.ok(!(await page.locator('.task-heading').innerText()).includes('applicationId'))
  const file = `${label}-${locale}-${theme}.png`
  await page.mouse.move(1598, 1098)
  await page.locator('[role="tooltip"]:visible').waitFor({ state: 'hidden' })
  await page.screenshot({ path: join(output, file), fullPage: true, animations: 'disabled' })
  evidence.screenshots.push(file)
}
async function launch(page, button) {
  const previousSession = new URL(page.url()).searchParams.get('session')
  await button.click()
  await page.getByTestId('agent-launch-review').waitFor({ timeout: 45000 })
  await page.getByTestId('agent-launch-confirm').click()
  await page.waitForURL(
    (url) => {
      const id = url.searchParams.get('session')
      return Boolean(id && id !== previousSession)
    },
    { timeout: 45000 },
  )
  const id = new URL(page.url()).searchParams.get('session')
  assert.ok(id)
  const session = await rt.client.session.load(id, {
    onPermissionRequest: async (request) => ({
      optionId: request.options.find((option) => option.kind === 'allow_once').optionId,
    }),
  })
  await session.attach()
  await session.setModel({ slot: 'primary', route: 'demo', model: 'demo-model' })
  evidence.sessions.push(id)
  active = session
  await page.locator('#view-chat').click()
  return session
}
async function selectTab(page, id, title, zh) {
  const tab = page.getByTestId(`workbench-tab-application.${id}`)
  if (await tab.isVisible()) await tab.click()
  else {
    await page
      .locator('#workbench-right')
      .getByRole('button', { name: zh ? '更多' : 'More', exact: true })
      .click()
    await page.getByRole('menuitem', { name: title, exact: true }).click()
  }
}
async function checkAlignment(page) {
  const boxes = await page.evaluate(() =>
    ['#composer', '.application-work-actions'].map((selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect()
      return { x: rect.x, width: rect.width }
    }),
  )
  assert.ok(Math.abs(boxes[0].x - boxes[1].x) < 2, JSON.stringify(boxes))
  assert.ok(Math.abs(boxes[0].width - boxes[1].width) < 2, JSON.stringify(boxes))
  assert.ok(!(await page.locator('#prompt').inputValue()).includes('applicationId'))
}
async function call(session, name, input) {
  const result = await session.prompt(`call ${name} ${JSON.stringify(input)}`, {
    signal: AbortSignal.timeout(90000),
  })
  assert.equal(result.reason, 'completed')
  return toolResult(session, name)
}
try {
  for (const [locale, theme] of [
    ['zh-CN', 'light'],
    ['en', 'dark'],
  ]) {
    const zh = locale === 'zh-CN'
    const sessionOffset = evidence.sessions.length
    rt = await runtime(false, 'aerospace-quality', { demoModel: true })
    evidence.roots.push(rt.root)
    console.log(JSON.stringify({ root: rt.root, locale }))
    await rt.startWeb()
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1100 },
      locale,
      colorScheme: theme,
    })
    await context.addInitScript(
      ({ locale, theme }) => {
        if (window === window.top) {
          localStorage.setItem('agnes-locale', locale)
          localStorage.setItem('agnes-theme', theme)
        }
      },
      { locale, theme },
    )
    const page = await context.newPage()
    page.on('pageerror', (error) => evidence.errors.push(error.message))
    await page.goto(rt.url + '/?page=agents')
    const card = page.locator(`[data-application="${packageId}"]`)
    await card.waitFor({ timeout: 45000 })
    await page
      .getByTestId('general-agent')
      .locator('.ant-select-content-has-value')
      .waitFor({ timeout: 45000 })
    assert.equal(await card.locator('.application-scenarios li').count(), 3)
    await shot(page, '01-gallery', locale, theme)
    await card.getByRole('button', { name: zh ? '安装并采用' : 'Install and adopt', exact: true }).click()
    await page.getByTestId('install-review').waitFor({ timeout: 45000 })
    await shot(page, '02-install-review', locale, theme)
    await page
      .getByRole('button', { name: zh ? '安装、信任并启用' : 'Install, trust and enable', exact: true })
      .click()
    await page.getByTestId('consent-summary').waitFor({ timeout: 120000 })
    await shot(page, '03-adoption-consent', locale, theme)
    await page.getByRole('button', { name: zh ? '采用此预览' : 'Adopt this preview', exact: true }).click()
    await page.locator('[data-aero-page="aero-home"] h1').waitFor({ timeout: 45000 })
    await page.locator('.aero-kpi').first().waitFor({ timeout: 45000 })
    await page.getByTestId('home-entry-aero-tasks').waitFor({ timeout: 30000 })
    assert.equal(await page.getByTestId('home-entry-aero-mrb').isVisible(), false)
    await shot(page, '04-slim-overview', locale, theme)
    const investigation = await launch(
      page,
      page.getByRole('button', { name: zh ? '调查异常' : 'Investigate anomaly', exact: true }).first(),
    )
    await page.getByTestId('aero-object-dossier').waitFor({ timeout: 45000 })
    assert.equal(
      await page.getByTestId('workbench-tab-application.current-object').getAttribute('aria-selected'),
      'true',
    )
    assert.ok(!(await page.locator('#prompt').inputValue()).includes('applicationId'))
    assert.ok(
      (await page.locator('#composer [data-testid=application-work-chip]').innerText()).includes('AN-027'),
    )
    await checkAlignment(page)
    await shot(page, '05-object-conversation', locale, theme)
    await page.locator('#send').click()
    await until(
      async () => {
        const timeline = await investigation.projectUI(undefined, { surface: 'web' })
        return (
          timeline.opState === null &&
          timeline.nodes.some(
            (node) =>
              node.kind === 'user' &&
              node.content.some((block) => block.type === 'text' && block.text.includes('AN-027')),
          )
        )
      },
      Boolean,
      'editable work request submitted',
    )
    await page
      .locator('.process-identity [data-testid=application-attribution]')
      .first()
      .waitFor({ timeout: 30000 })
    await call(investigation, 'aero_investigate', { anomalyId: 'AN-027' })
    const restored = await context.newPage()
    await restored.goto(`${rt.url}/?session=${investigation.id}`)
    await restored.locator('#view-chat').click()
    await restored.getByTestId('aero-object-dossier').waitFor({ timeout: 45000 })
    assert.ok((await restored.getByTestId('aero-object-dossier').innerText()).includes('AN-027'))
    assert.ok(
      (
        await restored.locator('#transcript [data-testid=application-work-chip]').first().innerText()
      ).includes('AN-027'),
    )
    assert.ok(!(await restored.locator('#transcript').innerText()).includes('applicationId'))
    await shot(restored, '05b-restored-object', locale, theme)
    await restored.close()
    const mrb = await launch(
      page,
      page
        .locator('.application-work-actions')
        .getByRole('button', { name: zh ? '起草 MRB 处置' : 'Draft MRB disposition', exact: true }),
    )
    await page.getByTestId('aero-object-dossier').waitFor({ timeout: 45000 })
    assert.ok((await page.getByTestId('aero-object-dossier').innerText()).includes('NCR-018'))
    await shot(page, '06-quick-action', locale, theme)
    await checkAlignment(page)
    await page
      .locator('#workbench-right')
      .getByRole('button', { name: zh ? '关闭此停靠面板' : 'Close this dock', exact: true })
      .click()
    await page.setViewportSize({ width: 760, height: 1100 })
    await checkAlignment(page)
    await shot(page, '06b-narrow-actions', locale, theme)
    await page.setViewportSize({ width: 400, height: 900 })
    await checkAlignment(page)
    await shot(page, '06c-mobile-actions', locale, theme)
    await page.setViewportSize({ width: 1600, height: 1100 })
    const initial = await call(mrb, 'aero_quality', { view: 'dashboard' })
    await page.getByTestId('workbench-right-toggle').click()
    await selectTab(page, 'current-object', zh ? '当前对象' : 'Current object', zh)
    const revision = initial.revision
    const rationale = zh
      ? '受控返工：隔离 L2609-B，恢复图纸要求，复验 PVD-011/012/013。'
      : 'Controlled rework: quarantine L2609-B, restore drawing, re-verify PVD-011/012/013.'
    await call(mrb, 'aero_mrb_draft', {
      ncrId: 'NCR-018',
      disposition: 'rework',
      rationale,
      expectedRevision: revision,
    })
    await page
      .getByTestId('aero-object-dossier')
      .getByText(rationale, { exact: true })
      .waitFor({ timeout: 30000 })
    await shot(page, '07-live-tool-write', locale, theme)
    const pending = mrb.prompt(
      `call aero_decide ${JSON.stringify({ kind: 'mrb', id: 'NCR-018', expectedRevision: revision + 1 })}`,
      { signal: AbortSignal.timeout(90000) },
    )
    activeTurn = pending
    await until(
      async () =>
        (await rt.client.approval.list(mrb.id)).decisions.find(
          (decision) =>
            decision.request.spec.purpose === 'business.confirm' &&
            !decision.result &&
            !decision.invalidation,
        ),
      Boolean,
      'business signature',
    )
    await selectTab(page, 'signatures', zh ? '待签署' : 'Pending signatures', zh)
    const signature = page.locator('#workbench-approval-content')
    await signature.locator('[data-approval-action="durable:allowed-once"]').waitFor({ timeout: 45000 })
    await shot(page, '08-sign-in-place', locale, theme)
    await signature.locator('[data-approval-action="durable:allowed-once"]').click()
    assert.equal((await pending).reason, 'completed')
    activeTurn = undefined
    const signed = await toolResult(mrb, 'aero_decide')
    assert.equal(signed.data.signature.purpose, 'business.confirm')
    await selectTab(page, 'current-object', zh ? '当前对象' : 'Current object', zh)
    await page
      .getByTestId('aero-object-dossier')
      .getByText(zh ? '已批准处置 · 待实施' : 'Disposition approved · execution pending', { exact: true })
      .waitFor({ timeout: 30000 })
    const quality = await launch(
      page,
      page
        .locator('.application-work-actions')
        .getByRole('button', { name: zh ? '生成归零报告' : 'Generate closure report', exact: true }),
    )
    await call(quality, 'aero_report', { kind: 'zeroing', locale })
    await selectTab(page, 'evidence', zh ? '证据与报告' : 'Evidence & reports', zh)
    await page.locator('.application-panel').getByRole('button', { name: /HTML/ }).waitFor({ timeout: 30000 })
    await page.locator('.application-panel').getByRole('button', { name: /HTML/ }).scrollIntoViewIfNeeded()
    await shot(page, '09-evidence-reports', locale, theme)
    await page.locator('.application-panel').getByRole('button', { name: /HTML/ }).click()
    await page.getByTestId('file-view-preview').click()
    await page.locator('[data-document-preview="html"] iframe').waitFor({ timeout: 30000 })
    await page.frameLocator('[data-document-preview="html"] iframe').locator('h1').waitFor({ timeout: 30000 })
    await shot(page, '10-report-preview', locale, theme)
    for (const id of evidence.sessions.slice(sessionOffset)) {
      const budget = await rt.client.sessions.get(id).budget()
      assert.equal(budget.state.creditsUsed, 0)
      evidence.sessionBudgets.push({ id, creditsUsed: budget.state.creditsUsed })
    }
    await context.close()
    await rt.dispose()
    rt = undefined
  }
  assert.deepEqual(evidence.errors, [])
  evidence.passed = true
} catch (error) {
  evidence.failure = String(error.stack ?? error)
  for (const context of browser.contexts())
    for (const page of context.pages())
      await page.screenshot({ path: join(output, 'diagnostic-failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally {
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2).replaceAll(homedir(), '~'))
  await browser.close()
  if (activeTurn) {
    await active?.cancel().catch(() => {})
    await activeTurn.catch(() => {})
  }
  await rt?.dispose()
}
