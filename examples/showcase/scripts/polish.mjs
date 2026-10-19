/** Model-free presentation regression. Reuses the demo runner's isolated runtime and real APIs. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { runtime, toolResult, until } from '../pharma-gmp/scripts/runtime.mjs'

const app = process.argv[2],
  pharma = app === 'pharma-gmp',
  packageId = `@agnes-showcase/${app}`
const brandModes = JSON.parse(
  await readFile(join('examples/showcase', app, 'client/agnes.client.json'), 'utf8'),
).skins[0].tokens['--agnes-brand-primary']
const rt = await runtime(false, app, { demoModel: true })
const output = process.env.AGH_SHOWCASE_SHOTS ?? join(rt.root, 'screenshots')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const pages = [],
  sessions = [],
  evidence = {
    app,
    root: rt.root,
    node: process.version,
    usd: 0,
    screenshots: [],
    signatures: [],
    errors: [],
    passed: false,
  }
console.log(JSON.stringify({ app, root: rt.root, output }))
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
      if (window === window.top) {
        localStorage.setItem('agnes-locale', locale)
        localStorage.setItem('agnes-theme', theme)
      }
    },
    { locale, theme },
  )
  const page = await context.newPage()
  page.on('pageerror', (error) => evidence.errors.push(error.message))
  pages.push({ page, locale, theme })
}
const primary = pages[0].page,
  home = pharma ? 'pharma-home' : 'aero-home'
const path = (id) => `/?page=${id}&pagePackage=${encodeURIComponent(packageId)}`
async function shot(label, item) {
  await item.page.locator('.sidebar-head').waitFor({ state: 'visible', timeout: 30000 })
  await item.page.evaluate(() => document.fonts.ready)
  await item.page.mouse.move(1550, 20)
  const file = `${label}-${item.locale}-${item.theme}.png`
  await item.page.screenshot({ path: join(output, file), fullPage: true, animations: 'disabled' })
  evidence.screenshots.push({ file, label, locale: item.locale, theme: item.theme })
}
async function capture(label, target, selector, prepare) {
  for (const item of pages) {
    await item.page.goto(rt.url + target)
    await item.page
      .locator(selector)
      .first()
      .waitFor({ state: target.includes('session=') ? 'attached' : 'visible', timeout: 45000 })
    if (target.includes('session=')) {
      await until(
        async () => {
          await item.page.locator('#view-chat').click()
          return item.page.locator('#view-chat').getAttribute('aria-selected')
        },
        (value) => value === 'true',
        'conversation tab ready',
        15000,
      )
      await item.page.locator(selector).first().waitFor({ state: 'visible', timeout: 45000 })
    }
    await item.page.getByTestId(`home-entry-${home}`).waitFor({ timeout: 45000 })
    await item.page.waitForFunction(
      (expected) =>
        getComputedStyle(document.documentElement)
          .getPropertyValue('--agnes-brand-primary')
          .trim()
          .toLowerCase() === expected,
      brandModes[item.theme].toLowerCase(),
      { timeout: 45000 },
    )
    if (prepare) await prepare(item)
    await shot(label, item)
  }
}
async function open(role) {
  const ref = `${packageId}#${role}`,
    plan = await rt.client.agents.resolve(ref)
  const session = await rt.client.session.new({
    cwd: rt.workspace,
    sessionKey: randomUUID(),
    agent: ref,
    agentDigest: plan.digest,
  })
  session.onPermissionRequest(async (request) => ({
    optionId: request.options.find((o) => o.kind === 'allow_once').optionId,
  }))
  await session.attach()
  await session.setModel({ slot: 'primary', route: 'demo', model: 'demo-model' })
  sessions.push(session)
  return session
}
async function call(session, name, args, signature) {
  const pending = session.prompt(`call ${name} ${JSON.stringify(args)}`, {
    signal: AbortSignal.timeout(90000),
  })
  if (signature) {
    const snapshot = await until(
      async () =>
        (await rt.client.approval.list(session.id)).decisions.find(
          (d) => d.request.spec.purpose === 'business.confirm' && !d.result && !d.invalidation,
        ),
      Boolean,
      'business signature',
    )
    const number = evidence.signatures.length + 1
    await capture(
      `signature-${number}`,
      `/?session=${session.id}`,
      '[data-testid="approval-card"]',
      async (item) => {
        const card = item.page.getByTestId('approval-card'),
          view = snapshot.request.spec.presentation[item.locale]
        assert.equal(await card.locator('.agh-decision-fields dd').nth(2).innerText(), view.responseValue)
        assert.ok(!(await card.innerText()).includes(' / Human quality signature'))
        assert.ok(
          !(
            await card.locator('.approval-summary-text').evaluate((el) => getComputedStyle(el).fontFamily)
          ).includes('mono'),
        )
        assert.equal(
          await card.locator('.agh-decision-fields a').getAttribute('href'),
          `/?session=${session.id}`,
        )
        const rail = item.page.locator('.turn-nav-rail')
        if (await rail.count()) assert.equal(await rail.evaluate((el) => getComputedStyle(el).opacity), '0')
      },
    )
    const item = pages[number % 2],
      value = snapshot.request.spec.presentation[item.locale].responseValue
    const option = signature === 'reject' ? 'rejected' : 'allowed-once'
    await item.page.locator(`[data-approval-action="durable:${option}"]`).click()
    evidence.signatures.push({ handle: snapshot.handle, locale: item.locale, option, meaning: value })
  }
  const done = await pending
  assert.equal(done.reason, 'completed', JSON.stringify(done))
  if (signature === 'reject') return
  const result = await toolResult(session, name)
  if (signature)
    assert.equal(
      (pharma ? result.signature : result.data.signature).meaning,
      evidence.signatures.at(-1).meaning,
    )
  return result
}
async function openReport({ page, locale }) {
  const file = page
    .getByTestId('turn-deliverables')
    .getByTestId('deliverable-file')
    .filter({ hasText: /\.html/ })
    .last()
  await file.locator('.agh-list-row-title').click()
  const frame = page.locator('[data-document-preview="html"] iframe').first()
  await frame.waitFor({ timeout: 30000 })
  await page.frameLocator('[data-document-preview="html"] iframe').locator('h1').waitFor({ timeout: 30000 })
  const expand = page
    .locator('#workbench-right')
    .getByRole('button', { name: locale === 'en' ? 'Expand' : '展开', exact: true })
  if (await expand.count()) {
    await expand.click()
    await until(
      async () => (await page.locator('#workbench-right').boundingBox())?.width ?? 0,
      (width) => width > 600,
      'expanded report',
    )
  }
}
async function report(session, args, label) {
  await call(session, pharma ? 'pharma_report' : 'aero_report', args)
  await capture(label, `/?session=${session.id}`, '[data-testid="conversation-turn"]', openReport)
}

try {
  await rt.startWeb()
  for (const item of pages) {
    await item.page.goto(rt.url + '/?page=agents')
    const general = item.page.getByTestId('general-agent')
    await general.locator('.ant-select-content-has-value').waitFor({ timeout: 45000 })
    assert.ok(!(await general.innerText()).includes('agnes.default'))
    await shot('01-gallery', item)
    await item.page
      .locator(`[data-application="${packageId}"]`)
      .getByRole('button', { name: item.locale === 'en' ? 'Install and adopt' : '安装并采用', exact: true })
      .click()
    await item.page.getByTestId('install-review').waitFor({ timeout: 45000 })
    await shot('02-install-review', item)
  }
  await primary.getByRole('button', { name: '安装、信任并启用', exact: true }).click()
  await primary.getByTestId('consent-summary').waitFor({ timeout: 120000 })
  await shot('03-adoption-consent', pages[0])
  await pages[1].page.goto(rt.url + '/?page=agents')
  await pages[1].page
    .locator(`[data-application="${packageId}"]`)
    .getByRole('button', { name: 'Install and adopt', exact: true })
    .click()
  await pages[1].page.getByTestId('consent-summary').waitFor({ timeout: 45000 })
  await shot('03-adoption-consent', pages[1])
  await primary.getByRole('button', { name: '采用此预览', exact: true }).click()
  await primary.waitForURL(rt.url + '/', { timeout: 45000 })
  await capture('04-transformed-home', '/', pharma ? '.ph-card' : '.aero-kpis', async ({ page }) => {
    for (const caption of await page.locator('caption[data-repeats-heading]').all())
      assert.ok((await caption.boundingBox()).height <= 1)
  })
  await capture(
    '05-incident',
    path(pharma ? 'pharma-deviations' : 'aero-tests'),
    pharma ? '.ph-card' : '.aero-chart-section',
  )
  if (pharma) await capture('05b-em-alert-action', path('pharma-em'), '.ph-app figure svg')
  const investigation = await open('investigator')
  await call(
    investigation,
    pharma ? 'pharma_inspect' : 'aero_investigate',
    pharma ? { batch: 'B-2410-017' } : { anomalyId: 'AN-027' },
  )
  if (pharma) await call(investigation, 'pharma_dossier', { batch: 'B-2410-017' })
  await capture(
    '06-investigation-evidence',
    `/?session=${investigation.id}`,
    '[data-testid="conversation-turn"]',
    async ({ page }) => {
      for (const toggle of await page.getByTestId('turn-process-toggle').all())
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
      for (const toggle of await page.getByTestId('turn-activity-toggle').all())
        if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) !== 'true')
          await toggle.click()
      await page
        .locator(pharma ? '.ph-evidence-card' : '.aero-evidence-card')
        .first()
        .waitFor({ state: 'visible', timeout: 30000 })
    },
  )
  let quality
  if (pharma) {
    for (const [revision, action, proof] of [
      [0, 'investigate'],
      [
        1,
        'advance',
        'SIM-CAL-017 synthetic as-found +4.1 C; as-left calibration reviewed; 016/017/018 assessed',
      ],
      [
        2,
        'advance',
        'SIM-REPROCESS-017 approved synthetic reprocessing, independent LOD 1.9%, QC, cleaning and EM identification/resampling reviewed',
      ],
      [
        3,
        'advance',
        'SIM-EFFECT-017 three synthetic verification batches and overdue escalation effectiveness reviewed',
      ],
    ]) {
      await call(
        investigation,
        'pharma_record',
        { batch: 'B-2410-017', action, expectedRevision: revision, ...(proof ? { evidence: proof } : {}) },
        'sign',
      )
    }
    const reviewer = await open('reviewer')
    await call(
      reviewer,
      'pharma_record',
      { batch: 'B-2410-017', action: 'review', expectedRevision: 4 },
      'sign',
    )
    quality = await open('release')
    const dossier = await call(quality, 'pharma_dossier', { batch: 'B-2410-017' })
    const released = await call(
      quality,
      'pharma_release',
      { batch: 'B-2410-017', expectedRevision: 5, meaning: dossier.signatureMeaning },
      'sign',
    )
    assert.equal(released.dossier.certificate.meaning, evidence.signatures.at(-1).meaning)
    await report(quality, { kind: 'dossier', batch: 'B-2410-017', locale: 'zh-CN' }, '07-report')
  } else {
    const mrb = await open('mrb')
    await call(mrb, 'aero_mrb_draft', {
      ncrId: 'NCR-018',
      disposition: 'rework',
      rationale: 'Quarantine L2609-B; restore controlled drawing and re-verify PVD-011/012/013.',
      expectedRevision: 1,
    })
    await call(mrb, 'aero_decide', { kind: 'mrb', id: 'NCR-018', expectedRevision: 2 }, 'reject')
    await call(mrb, 'aero_decide', { kind: 'mrb', id: 'NCR-018', expectedRevision: 2 }, 'sign')
    quality = await open('quality')
    await report(quality, { kind: 'zeroing', locale: 'zh-CN' }, '07-report')
    await call(quality, 'aero_rule_propose', { expectedRevision: 3 })
    await call(quality, 'aero_skill_candidate', { action: 'prepare' })
    await capture('09-reviewed-candidate', `/?session=${quality.id}`, '[data-testid="conversation-turn"]')
    await call(quality, 'aero_decide', { kind: 'rule', id: 'TVAC-LOT-001', expectedRevision: 4 }, 'sign')
    const configuration = await open('configuration')
    await call(configuration, 'aero_change_review', { ecrId: 'ECR-016' })
    await call(
      configuration,
      'aero_decide',
      { kind: 'configuration', id: 'ECR-016', expectedRevision: 5 },
      'sign',
    )
  }
  await capture(
    '08-trace-provenance',
    `/?session=${quality.id}`,
    '[data-testid="conversation-turn"]',
    async ({ page, locale }) => {
      await page.locator('#view-trace').click()
      const row = page
        .locator('#trace-panel .trace-row')
        .filter({ has: page.locator('.kind-assistant') })
        .last()
      await row.waitFor({ timeout: 30000 })
      await row.click()
      await page
        .locator('.trace-inspector')
        .getByRole('tab', { name: locale === 'en' ? 'Source' : '来源', exact: true })
        .click()
      await page.getByTestId('trace-provenance').waitFor({ timeout: 30000 })
    },
  )
  const job = await rt.client.request('_agnes/v1/schedules.upsert', {
    agent: `${packageId}#${pharma ? 'em' : 'quality'}`,
    title: pharma ? '每日环境趋势' : '每周质量摘要',
    prompt: `call ${pharma ? 'pharma_report' : 'aero_report'} ${JSON.stringify(pharma ? { kind: 'em', locale: 'zh-CN' } : { kind: 'digest', locale: 'zh-CN' })}`,
    selector: { daily: { time: '02:00', timeZone: 'Asia/Shanghai' } },
    target: { kind: 'new-session', cwd: rt.workspace, unattendedApproval: 'refuse' },
  })
  await rt.client.request('_agnes/v1/schedules.control', { id: job.id, action: 'run' })
  const ran = await until(
    async () =>
      (await rt.client.request('_agnes/v1/schedules.list', { scope: 'all' })).schedules.find(
        (s) => s.id === job.id,
      ),
    (s) => s.runs.some((r) => ['ran', 'failed', 'needs_attention'].includes(r.outcome)),
    'scheduled local report',
    120000,
  )
  await rt.client.request('_agnes/v1/schedules.control', { id: job.id, action: 'pause' })
  assert.equal(ran.runs.at(-1).outcome, 'ran', JSON.stringify(ran.runs))
  await capture('10-automation', '/?page=automation', '[data-testid="schedules-row"]')
  const automated = await rt.client.session.load(ran.runs.at(-1).sessionKey, { cwd: rt.workspace })
  sessions.push(automated)
  await automated.attach()
  await capture(
    '11-automated-report',
    `/?session=${automated.id}`,
    '[data-testid="conversation-turn"]',
    openReport,
  )
  await capture('12-final-home', path(home), pharma ? '.ph-card' : '.aero-kpis')
  await capture('13-restore-in-settings', '/?settings=application', 'body', async ({ page, locale }) => {
    await page
      .getByRole('button', {
        name: locale === 'en' ? 'Clear application and interface choices' : '清除应用与界面实现选择',
        exact: true,
      })
      .waitFor({ timeout: 30000 })
    await until(
      () =>
        page
          .getByRole('button', {
            name: locale === 'en' ? 'Clear application and interface choices' : '清除应用与界面实现选择',
            exact: true,
          })
          .isEnabled(),
      Boolean,
      'application settings loaded',
    )
  })
  for (const session of sessions) assert.equal((await session.budget()).state.creditsUsed, 0)
  assert.deepEqual(evidence.errors, [])
  evidence.passed = true
} catch (error) {
  evidence.error = error.stack
  console.error(error.stack)
  for (const item of pages) await shot('failure', item).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(output, 'evidence.json'), JSON.stringify(evidence, null, 2))
  await writeFile(
    join(output, 'index.md'),
    `# ${app} local presentation regression\n\nLocal scripted Demo; paid model cost $0; passed: ${evidence.passed}.\n\n${evidence.screenshots.map((s) => `- [${s.label} · ${s.locale} · ${s.theme}](${s.file})`).join('\n')}\n`,
  )
  await browser.close()
  await rt.dispose()
  console.log(
    JSON.stringify({
      app,
      passed: evidence.passed,
      root: rt.root,
      output,
      screenshots: evidence.screenshots.length,
    }),
  )
}
