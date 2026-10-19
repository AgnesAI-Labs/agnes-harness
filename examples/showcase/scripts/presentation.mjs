/** Bounded investor acceptance: natural questions only; operator actions use reviewed public APIs. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { runtime, toolResult, until } from '../pharma-gmp/scripts/runtime.mjs'

const app = process.argv[2]
assert.ok(['pharma-gmp', 'aerospace-quality'].includes(app))
const real = process.argv.includes('--real')
const pharma = app === 'pharma-gmp',
  packageId = `@agnes-showcase/${app}`
execFileSync(process.execPath, ['tools/toolchain/run.mjs', '--filter', '@agnes/cli', 'build:local'], {
  stdio: 'inherit',
})
const brandModes = JSON.parse(
  await readFile(join('examples/showcase', app, 'client/agnes.client.json'), 'utf8'),
).skins[0].tokens['--agnes-brand-primary']
const rt = await runtime(real, app)
const output = process.env.AGH_SHOWCASE_SHOTS ?? join(rt.root, 'screenshots')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const evidence = {
  app,
  real,
  root: rt.root,
  node: process.version,
  steps: [],
  signatures: [],
  screenshots: [],
  errors: [],
  usd: Number(process.env.AGH_SHOWCASE_PRIOR_USD ?? 0),
  passed: false,
}
assert.ok(Number.isFinite(evidence.usd) && evidence.usd >= 0 && evidence.usd < 3)
const prior = evidence.usd,
  sessions = new Map(),
  costs = new Map(),
  pages = []
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
      if (window !== window.top) return
      localStorage.setItem('agnes-locale', locale)
      localStorage.setItem('agnes-theme', theme)
    },
    { locale, theme },
  )
  const page = await context.newPage()
  page.on('pageerror', (error) => evidence.errors.push(error.message))
  page.on('response', async (response) => {
    if (!response.ok() && /\/application\/preview$/.test(new URL(response.url()).pathname))
      evidence.previewFailures = [
        ...(evidence.previewFailures ?? []),
        { status: response.status(), body: await response.json().catch(() => null) },
      ]
  })
  pages.push({ page, locale, theme })
}
async function shot(label, item) {
  await item.page.evaluate(() => document.fonts.ready)
  const file = `${label}-${item.locale}-${item.theme}.png`
  await item.page.screenshot({ path: join(output, file), fullPage: true, animations: 'disabled' })
  evidence.screenshots = evidence.screenshots.filter((shot) => shot.file !== file)
  evidence.screenshots.push({ file, label, locale: item.locale, theme: item.theme })
}
async function capture(label, path, selector) {
  for (const item of pages) {
    await item.page.goto(`${rt.url}${path}`)
    if (selector && path.startsWith('/?session=')) {
      await item.page.locator(selector).first().waitFor({ state: 'attached', timeout: 45000 })
      await until(
        async () => {
          await item.page.locator('#view-chat').click()
          return item.page.locator(selector).first().isVisible()
        },
        (visible) => visible,
        'conversation view ready',
        15000,
      )
    }
    if (selector) await item.page.locator(selector).first().waitFor({ timeout: 45000 })
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
    if (label === '06-investigation-evidence') {
      await item.page.getByTestId('turn-process-toggle').first().click()
      for (const toggle of await item.page.getByTestId('turn-activity-toggle').all()) {
        if ((await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) !== 'true')
          await toggle.click()
      }
      const card = item.page.locator(pharma ? '.ph-evidence-card' : '.aero-evidence-card').first()
      await card.waitFor({ state: 'visible', timeout: 30000 })
      await card.scrollIntoViewIfNeeded()
    }
    if (['07-report', '11-automated-report'].includes(label)) {
      const report = item.page
        .getByTestId('turn-deliverables')
        .getByTestId('deliverable-file')
        .filter({ hasText: /\.html/ })
        .first()
      await report.waitFor({ timeout: 45000 })
      await report.locator('.agh-list-row-title').click()
      const preview = item.page.locator('[data-document-preview="html"] iframe').first()
      await preview.waitFor({ timeout: 30000 })
      const expand = item.page
        .locator('#workbench-right')
        .getByRole('button', { name: item.locale === 'en' ? 'Expand' : '展开', exact: true })
      if (await expand.count()) {
        await expand.click()
        await until(
          async () => (await item.page.locator('#workbench-right').boundingBox())?.width ?? 0,
          (width) => width > 700,
          'expanded report preview',
        )
      }
      await preview.scrollIntoViewIfNeeded()
      await preview
        .contentFrame()
        .locator('body')
        .filter({ hasText: pharma ? /Sableleaf|沙叶/ : /QV-X27/ })
        .waitFor({ timeout: 30000 })
    }
    await shot(label, item)
  }
}
async function account(s) {
  const timeline = await s.projectUI(undefined, { surface: 'web' })
  costs.set(s.id, (timeline.usage?.cost?.usdMicros ?? 0) / 1e6)
  evidence.usd = prior + [...costs.values()].reduce((a, b) => a + b, 0)
  assert.ok(evidence.usd < 3, 'Application $3 cap')
  return timeline
}
async function open(role, fullAccess = false) {
  const plan = await rt.client.agents.resolve(`${packageId}#${role}`)
  const s = await rt.client.session.new({
    cwd: rt.workspace,
    agent: plan.ref,
    agentDigest: plan.digest,
    sessionKey: randomUUID(),
  })
  s.onPermissionRequest(async (request) => {
    evidence.steps.push({
      kind: 'ordinary-permission',
      session: s.id,
      requestId: request.requestId,
      reviewedTool: request.toolCall,
    })
    const option = request.options.find((o) => o.kind === 'allow_once')
    assert.ok(option)
    return { optionId: option.optionId }
  })
  await s.attach()
  if (real) await s.setModel({ slot: 'primary', route: 'account-pharma-eval', model: 'deepseek-flash' })
  if (fullAccess) await rt.client.request('session/set_mode', { sessionId: s.id, modeId: 'full-access' })
  sessions.set(s.id, s)
  return s
}
async function run(s, prompt, label, required = [], signatureOption = 'allowed-once') {
  for (const active of sessions.values()) await account(active)
  assert.ok(evidence.usd < 1.7, 'Reserve $1.30 for in-flight reasoning and automation')
  console.log(JSON.stringify({ step: label, usd: evidence.usd }))
  let stopped = false,
    failure
  // The test operator answers the durable business request through authenticated human ingress.
  // The model never receives a permission or signer argument that can manufacture a signature.
  const responding = (async () => {
    while (!stopped) {
      const { decisions } = await rt.client.approval.list(s.id)
      for (const snapshot of decisions) {
        if (snapshot.request.spec.purpose !== 'business.confirm' || snapshot.result || snapshot.invalidation)
          continue
        const count = evidence.signatures.length + 1
        await capture(
          `signature-${count}`,
          `/?session=${encodeURIComponent(s.id)}`,
          '[data-testid="approval-card"]',
        )
        await rt.client.approval.decide({
          ...snapshot.handle,
          revision: snapshot.revision,
          commandId: randomUUID(),
          response: { option: signatureOption, value: null },
        })
        evidence.signatures.push({
          handle: snapshot.handle,
          subject: snapshot.request.spec.subject,
          purpose: snapshot.request.spec.purpose,
          option: signatureOption,
        })
      }
      await new Promise((done) => setTimeout(done, 200))
    }
  })().catch((error) => {
    failure = error
    void s.cancel()
  })
  try {
    const result = await s.prompt(prompt, {
      signal: AbortSignal.timeout(240000),
      ...(real ? { creditLimit: Math.min(0.85, 2.6 - evidence.usd) } : {}),
    })
    if (failure) throw failure
    assert.equal(result.reason, 'completed', JSON.stringify(result))
    const timeline = await account(s)
    if (real)
      assert.ok(
        timeline.usage?.billingComplete && (timeline.usage?.cost?.usdMicros ?? 0) > 0,
        'Real-model acceptance needs complete AGH billing',
      )
    const tools = []
    for (const node of timeline.nodes.filter((n) => n.kind === 'tool' && n.resultSeq !== undefined)) {
      const detail = await s.readToolDetail(node.seq, node.resultSeq)
      tools.push({ name: node.name, args: detail.call?.args, result: detail.result })
    }
    const before = evidence.steps.filter((step) => step.session === s.id && step.tools).at(-1)?.toolCount ?? 0
    const current = tools.slice(before)
    await rt.save(`${label}.json`, { result, timeline, tools: current })
    for (const name of required)
      assert.ok(
        current.some((tool) => tool.name === name && !tool.result?.isError),
        `${label}: missing successful ${name}`,
      )
    evidence.steps.push({
      label,
      session: s.id,
      prompt,
      tools: current,
      toolCount: tools.length,
      usage: timeline.usage,
    })
    await rt.save(`${label}.json`, { result, timeline, tools: current })
    await writeFile(join(output, 'evidence.json'), rt.redact(JSON.stringify(evidence, null, 2)))
    return current
  } finally {
    stopped = true
    await responding
  }
}
const home = pharma ? 'pharma-home' : 'aero-home'
const pagePath = (id) => `/?page=${id}&pagePackage=${encodeURIComponent(packageId)}`
try {
  await rt.startWeb()
  evidence.doctor = await rt.client.request('_agnes/v1/doctor.run', { probeAccounts: false })
  assert.ok(!evidence.doctor.checks.some((check) => check.status === 'fail'), JSON.stringify(evidence.doctor))
  for (const item of pages) {
    await item.page.goto(`${rt.url}/?page=agents`)
    const card = item.page.locator(`[data-application="${packageId}"]`)
    await card.waitFor({ timeout: 45000 })
    assert.equal(await card.count(), 1)
    assert.equal(await card.locator('.application-roles li').count(), 5)
    assert.equal(await item.page.locator(`[data-agent-ref^="${packageId}#"]`).count(), 0)
    await item.page
      .locator('[data-testid="general-agent"] .ant-select-content-has-value')
      .waitFor({ timeout: 30000 })
    await item.page
      .locator('[data-testid="general-agent"] button')
      .filter({ hasText: item.locale === 'en' ? 'Start now' : '一键开始' })
      .waitFor()
    await item.page.locator('.sidebar-head').waitFor({ state: 'visible', timeout: 30000 })
    await shot('01-gallery', item)
    await card
      .getByRole('button', { name: item.locale === 'en' ? 'Install and adopt' : '安装并采用', exact: true })
      .click()
    await item.page.getByTestId('install-review').waitFor({ timeout: 45000 })
    await shot('02-install-review', item)
  }
  const primary = pages[0].page
  await primary.getByRole('button', { name: '安装、信任并启用', exact: true }).click()
  await primary.getByTestId('consent-summary').waitFor({ timeout: 120000 })
  await shot('03-adoption-consent', pages[0])
  await pages[1].page.goto(`${rt.url}/?page=agents`)
  await pages[1].page
    .locator(`[data-application="${packageId}"]`)
    .getByRole('button', { name: 'Install and adopt', exact: true })
    .click()
  await pages[1].page.getByTestId('consent-summary').waitFor({ timeout: 45000 })
  await shot('03-adoption-consent', pages[1])
  await primary.getByRole('button', { name: '采用此预览', exact: true }).click()
  await primary.waitForURL(`${rt.url}/`, { timeout: 45000 })
  await capture(
    '04-transformed-home',
    '/',
    pharma ? '[data-pharma-page="home"] .ph-card' : '[data-aero-page] .aero-kpis',
  )
  if (pharma) evidence.initialRft = await primary.locator('.ph-kpi').nth(3).locator('strong').innerText()
  const adopted = await rt.client.request('_agnes/v1/applications.get', { profile: 'local-dev' })
  assert.equal(adopted.status, 'active')
  evidence.adoption = { id: adopted.effective.id, consent: adopted.selection.consentDigest }
  await capture(
    '05-incident',
    pagePath(pharma ? 'pharma-deviations' : 'aero-tests'),
    pharma ? '[data-pharma-page="deviations"] .ph-card' : '[data-aero-page] .aero-chart-section',
  )
  if (pharma)
    await capture('05b-em-alert-action', pagePath('pharma-em'), '[data-pharma-page="em"] figure svg')
  const s = await open(pharma ? 'hub' : 'quality')
  if (pharma) {
    const investigator = await open('investigator')
    await run(
      investigator,
      '使用 gmp-review 技能。B-2410-017 的干燥 LOD 超限了，同房间还有 EM 警戒，帮我调查一下，给出 CAPA 建议并说明其他批次是否受影响。先不要改档案。给中英文同事看，请用中文解释并附简短英文摘要。',
      'investigation',
      ['pharma_inspect', 'pharma_dossier'],
    )
    await capture(
      '06-investigation-evidence',
      `/?session=${investigator.id}`,
      '[data-testid="conversation-turn"]',
    )
    await run(
      s,
      '使用 gmp-review 技能。我确认将上述待验证假设登记为 B-2410-017 的调查记录。请现在发起登记，让我在系统的质量签名中审阅；我们使用隔离演示的合成证据。',
      'record-investigation',
      ['pharma_record'],
    )
    await run(
      s,
      '合成证据 SIM-CAL-017 已复核：T02 as-found +4.1°C，as-left 校准合格，016/017/018 回顾评估完成。把调查推进到 CAPA。',
      'capa',
      ['pharma_record'],
    )
    await run(
      s,
      '合成返工方案、独立 LOD 1.9% 复验、QC、清洁和 EM 鉴别/重采样证据 SIM-REPROCESS-017 已复核，请登记并进入有效性评价。',
      'retest',
      ['pharma_record'],
    )
    await run(
      s,
      '连续三批合成有效性确认和逾期升级机制验证 SIM-EFFECT-017 已完成，请完成偏差结案。',
      'closure-review',
      ['pharma_record'],
    )
    const reviewer = await open('reviewer')
    const reviewedBpr = await run(
      reviewer,
      '使用 gmp-review 技能。请独立复核 B-2410-017 的批记录和完整质量证据，发起我的质量复核签名；原始 LOD 超限与合成复验必须一起保留。',
      'bpr-review',
      ['pharma_dossier'],
    )
    if (!reviewedBpr.some((tool) => tool.name === 'pharma_record' && !tool.result?.isError))
      await run(
        reviewer,
        '这次签名是确认已完成的独立批记录复核，不是最终批次放行。其余五项已满足，请登记我的复核结论并发起质量记录签名。',
        'bpr-signature',
        ['pharma_record'],
      )
    const qa = await open('release')
    const releaseReview = await run(
      qa,
      '使用 gmp-review 技能。我已审阅 B-2410-017 的完整档案。请核对当前放行清单；若全部通过，按档案中的签名含义立即发起我的放行签名。原始超限记录必须保留。',
      'release',
      ['pharma_dossier'],
    )
    if (!releaseReview.some((tool) => tool.name === 'pharma_release' && !tool.result?.isError))
      await run(
        qa,
        '我确认已审阅独立审核员的 BPR 复核记录和全部合成质量证据，同意对 B-2410-017 当前版本发起放行签名。请使用档案的固定签名含义，由我在系统中签署。',
        'release-signature',
        ['pharma_release'],
      )
    const released = await toolResult(qa, 'pharma_release')
    assert.ok(released.dossier.certificate.approvalId)
    assert.equal(released.dossier.certificate.dossierRevision, 5)
    evidence.certificate = released.dossier.certificate
    await run(
      qa,
      '请生成中文放行档案和 APQR 节选，展示可打印报告，并告诉我如何追溯到证据、审批人和插件版本。',
      'report',
      ['pharma_report'],
    )
    await capture('07-report', `/?session=${qa.id}`, '[data-testid="conversation-turn"]')
    await run(
      s,
      '使用 gmp-review 技能的成长规程。把“设备使用日期距校准到期 0–7 天预警、逾期单列”做成可复用的只读技能候选。读取当前工具作者指南，候选必须同时包含实际可运行的只读日期检查工具和技能说明；输入使用日期与到期日，返回剩余天数、是否预警与是否逾期，测试覆盖距到期 3、7、8 天和已逾期，不能只写说明。创建、测试并提交审阅；发布由我批准。',
      'skill-candidate',
      ['plugin_helper_create'],
    )
    const created = await toolResult(s, 'plugin_helper_create')
    let review = await rt.client.request('_agnes/v1/plugins.candidates.show', {
      profile: 'local-dev',
      candidateId: created.candidateId,
    })
    for (let repair = 0; repair < 2 && review.state !== 'review'; repair++) {
      await run(
        s,
        '候选测试还未通过，请根据当前公开作者指南、同一草稿源码和失败摘要继续自行修复、重测并提交审阅。已有授权允许修改尚未发布的草稿，不必另问许可。注册入口须完整；插件同时声明工具与技能时，作者测试须提供声明的技能注册服务，满足依赖后再调用真实工具。不要删除工具调用断言。按宿主回执契约读取结构化结果；日期差与边界断言必须准确。',
        `candidate-repair-${repair + 1}`,
        [],
      )
      review = await rt.client.request('_agnes/v1/plugins.candidates.show', {
        profile: 'local-dev',
        candidateId: created.candidateId,
      })
    }
    assert.equal(review.state, 'review')
    assert.equal(review.tests.state, 'passed')
    evidence.candidate = review
    await rt.save('candidate-review.json', review)
    console.log(JSON.stringify({ step: 'candidate-review', root: rt.root, hash: review.candidateHash }))
    if (process.env.AGH_SHOWCASE_REQUIRE_REVIEW === '1')
      await until(
        async () => {
          try {
            return JSON.parse(await readFile(join(rt.root, 'review-approved.json'), 'utf8'))
          } catch {
            return null
          }
        },
        (value) => value?.candidateHash === review.candidateHash && value?.reviewHash === review.reviewHash,
        'test operator review of exact candidate files',
        240000,
      )
    await capture(
      '09-reviewed-candidate',
      `/?page=plugins&tab=review&view=${encodeURIComponent(`review:${created.candidateId}`)}`,
      '[data-testid="candidate-review"]',
    )
    await rt.client.request('_agnes/v1/plugins.candidates.approve', {
      ...(await rt.command()),
      candidateId: created.candidateId,
      expectedHash: review.candidateHash,
      reviewHash: review.reviewHash,
    })
    await until(
      () => rt.client.packages.list({ profile: 'local-dev' }),
      (result) => result.packages.some((p) => p.id === review.packageId && p.actual === 'running'),
      'reviewed plugin ready',
    )
    // A new ordinary session admits the newly reviewed capabilities instead of changing the old pin.
    const next = await rt.client.session.new({ cwd: rt.workspace, sessionKey: randomUUID() })
    sessions.set(next.id, next)
    await next.attach()
    await run(
      next,
      '使用刚人工发布的校准到期预警技能：设备 2024-10-17 使用、校准 2024-10-20 到期，是否应预警？请实际验证规则。',
      'learned-next-run',
      ['skill_read'],
    )
    const learnedTools = evidence.steps.at(-1).tools
    assert.ok(
      learnedTools.some((tool) => {
        const output = tool.result?.structured
        return (
          !tool.name.startsWith('plugin_helper') &&
          !tool.result?.isError &&
          output &&
          Object.entries(output).some(([key, value]) => /warn|alert|soon/i.test(key) && value === true) &&
          Object.entries(output).some(([key, value]) => /day/i.test(key) && value === 3)
        )
      }),
      'Published calibration tool must actually flag the three-day window',
    )
  } else {
    const investigator = await open('investigator')
    const mrb = await open('mrb')
    const analyst = await open('trace')
    await run(
      investigator,
      'TVAC 冷平台那次电流越限是怎么回事？影响哪些需求和器件？给我证据与替代解释，先别批准任何处置。给中英文同事看，请用中文解释并附简短英文摘要。',
      'investigation',
      ['aero_investigate'],
    )
    await capture(
      '06-investigation-evidence',
      `/?session=${investigator.id}`,
      '[data-testid="conversation-turn"]',
    )
    await run(
      mrb,
      '比较 NCR-018 的五种处置方案。请起草返工：隔离 L2609-B，按受控图样恢复 PVD-011/012/013 并复验。保存草案，先不要批准。',
      'mrb-draft',
      ['aero_mrb_draft'],
    )
    const refused = await run(
      mrb,
      '我已审阅这份返工草案，请发起正式质量签名。先演示一次拒绝，不改变处置。',
      'mrb-refusal',
      [],
      'rejected',
    )
    assert.ok(refused.some((tool) => tool.name === 'aero_decide' && tool.result?.isError))
    await run(
      mrb,
      '我已重新审阅这个返工草案，请再次发起我的正式签署；实施、复验与放行仍是后续独立步骤。',
      'mrb-signature',
      ['aero_decide'],
    )
    await run(
      analyst,
      'ECR-016 会影响哪些需求、接口与复验？请把没有覆盖和尚未通过的项目列清楚。先别改变基线。',
      'traceability',
      ['aero_change_review'],
    )
    await run(
      s,
      '生成中文双五条归零报告和可打印交付物。明确哪些证据仍缺失，并让我追溯到试验、处置签名和插件版本，不能宣称已归零。',
      'report',
      ['aero_report'],
    )
    await capture('07-report', `/?session=${s.id}`, '[data-testid="conversation-turn"]')
    await run(
      s,
      '把热循环组件更换批次应追加 TVAC 筛选的经验提议为项目规则，并准备原生可复用技能候选，展示文件与摘要，等我审阅。',
      'skill-candidate',
      ['aero_rule_propose', 'aero_skill_candidate'],
    )
    await capture('09-reviewed-candidate', `/?session=${s.id}`, '[data-testid="conversation-turn"]')
    await run(s, '我已审阅候选，请提交安装请求，让我在宿主确认，然后查询最终安装状态。', 'skill-install', [
      'aero_skill_candidate',
    ])
    const installedSkill = await toolResult(s, 'aero_skill_candidate')
    assert.equal(installedSkill.data.state, 'ready')
    evidence.installedSkill = installedSkill.data
    await capture('09-reviewed-candidate', `/?session=${s.id}`, '[data-testid="conversation-turn"]')
    await run(s, '请请求我签署 TVAC-LOT-001 项目规则的启用。', 'rule-signature', ['aero_decide'])
    const configuration = await open('configuration')
    await run(
      configuration,
      '请使用刚审阅安装的 TVAC 筛选技能重新分析 ECR-016，告诉我新规则是否生效及新增验证。先别改变基线。',
      'learned-next-run',
      ['skill_read', 'aero_change_review'],
    )
    const learnedSkill = await toolResult(configuration, 'skill_read')
    assert.equal(learnedSkill.name, evidence.installedSkill.name)
    const learned = await toolResult(configuration, 'aero_change_review')
    assert.equal(learned.data.screeningRequired, true)
    await run(
      configuration,
      '请请求我签署 ECR-016 技术状态更改；新增试验保持待执行。',
      'configuration-signature',
      ['aero_decide'],
    )
  }
  // Real execution/provenance UI, rather than a rendered synthetic trace.
  for (const item of pages) {
    await item.page.goto(`${rt.url}/?session=${s.id}`)
    await item.page.getByTestId('conversation-turn').first().waitFor({ timeout: 45000 })
    await until(
      async () => {
        await item.page.locator('#view-trace').click()
        return item.page.locator('#view-trace').getAttribute('aria-selected')
      },
      (selected) => selected === 'true',
      'trace tab ready',
      15000,
    )
    await item.page.locator('#trace-panel .trace-row').first().waitFor({ timeout: 30000 })
    const requestRow = item.page
      .locator('#trace-panel .trace-row')
      .filter({ has: item.page.locator('.kind-assistant') })
      .last()
    await requestRow.click()
    await item.page
      .locator('.trace-inspector')
      .getByRole('tab', { name: item.locale === 'en' ? 'Source' : '来源', exact: true })
      .click()
    await item.page.getByTestId('trace-provenance').waitFor({ timeout: 30000 })
    await shot('08-trace-provenance', item)
  }
  const scheduled = await rt.client.request('_agnes/v1/schedules.upsert', {
    agent: `${packageId}#${pharma ? 'em' : 'quality'}`,
    title: pharma ? '每日环境趋势 / Daily EM review' : '每周质量摘要 / Weekly quality digest',
    prompt: pharma
      ? '使用 gmp-review 技能。请生成今晚的中文环境趋势报告，区分警戒和行动限，引用当前证据，不执行质量处置。'
      : '请生成本周中文 NCR 质量摘要并展示可打印交付物；只报告当前证据，不批准硬件处置。',
    selector: pharma
      ? { daily: { time: '02:00', timeZone: 'Asia/Shanghai' } }
      : { weekly: { time: '09:00', timeZone: 'Asia/Shanghai', weekdays: [1] } },
    target: { kind: 'new-session', cwd: rt.workspace, unattendedApproval: 'refuse' },
  })
  evidence.schedule = scheduled
  await rt.client.request('_agnes/v1/schedules.control', { id: scheduled.id, action: 'run' })
  const ran = await until(
    async () =>
      (await rt.client.request('_agnes/v1/schedules.list', { scope: 'all' })).schedules.find(
        (r) => r.id === scheduled.id,
      ),
    (value) => value.runs.some((r) => ['ran', 'failed', 'needs_attention'].includes(r.outcome)),
    'scheduled report',
    180000,
  )
  await rt.client.request('_agnes/v1/schedules.control', { id: scheduled.id, action: 'pause' })
  assert.equal(ran.runs.at(-1).outcome, 'ran', JSON.stringify(ran.runs))
  const job = await rt.client.session.load(ran.runs.at(-1).sessionKey, { cwd: rt.workspace })
  sessions.set(job.id, job)
  await job.attach()
  await account(job)
  await toolResult(job, pharma ? 'pharma_report' : 'aero_report')
  await capture('10-automation', '/?page=automation', '[data-testid="schedules-row"]')
  await capture('11-automated-report', `/?session=${job.id}`, '[data-testid="conversation-turn"]')
  await capture(
    '12-final-home',
    pagePath(home),
    pharma ? '[data-pharma-page="home"] .ph-card' : '[data-aero-page] .aero-kpis',
  )
  if (pharma) {
    evidence.finalRft = await primary.locator('.ph-kpi').nth(3).locator('strong').innerText()
    assert.equal(
      evidence.finalRft,
      evidence.initialRft,
      'Retrospective correction must not improve historical first-pass yield',
    )
  }
  for (const item of pages) {
    await item.page.goto(`${rt.url}/?settings=application`)
    await item.page
      .getByRole('button', {
        name: item.locale === 'en' ? 'Clear application and interface choices' : '清除应用与界面实现选择',
        exact: true,
      })
      .waitFor({ timeout: 30000 })
    await until(
      () =>
        item.page
          .getByRole('button', {
            name: item.locale === 'en' ? 'Clear application and interface choices' : '清除应用与界面实现选择',
            exact: true,
          })
          .isEnabled(),
      Boolean,
      'application settings loaded',
    )
    await shot('13-restore-in-settings', item)
  }
  await pages[0].page.getByRole('button', { name: '清除应用与界面实现选择', exact: true }).click()
  await until(
    () => rt.client.request('_agnes/v1/applications.get', { profile: 'local-dev' }),
    (state) => state.status === 'host' && state.selection === null,
    'one-click default restoration',
  )
  evidence.defaultRestoredInOneClick = true
  assert.deepEqual(evidence.errors, [])
  evidence.passed = true
} catch (error) {
  for (const item of pages) {
    await shot('failure', item).catch(() => {})
    evidence.failureBody = await item.page
      .locator('body')
      .innerText()
      .catch(() => '')
  }
  evidence.error = rt.redact(error.stack)
  console.error(evidence.error)
  process.exitCode = 1
} finally {
  for (const s of sessions.values()) await account(s).catch(() => {})
  await rt.save('presentation.json', evidence)
  await writeFile(join(output, 'evidence.json'), rt.redact(JSON.stringify(evidence, null, 2)))
  await writeFile(
    join(output, 'index.md'),
    `# ${app} investor presentation\n\nMode: ${real ? 'DeepSeek real model' : 'Demo'}; passed: ${evidence.passed}; AGH cost including previous attempts: $${evidence.usd.toFixed(6)}.\n\n${evidence.screenshots.map((item) => `- [${item.label} · ${item.locale} · ${item.theme}](${item.file})`).join('\n')}\n`,
  )
  await browser.close()
  await rt.dispose()
  console.log(JSON.stringify({ app, passed: evidence.passed, usd: evidence.usd, root: rt.root, output }))
}
