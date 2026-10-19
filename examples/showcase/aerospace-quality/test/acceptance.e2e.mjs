// Explicit bounded application acceptance, never included in the test suite.
// Run from repository root via toolchain + heavy-lock + web-gate-lock.
// Demo: ... run.mjs exec node --import tsx examples/showcase/aerospace-quality/test/acceptance.e2e.mjs
// Paid: inject AGH_DEMO_API_KEY from the named keychain item per command and append --real.
// Keys are handled only by the existing isolated real-runtime helper and never logged here.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { pause, realRuntime, snapshot } from '../../../../tools/authoring/real-runtime.mjs'
import { testOperatorSignatures } from '../../scripts/signatures.mjs'

if (process.argv.includes('--real')) {
  process.argv.splice(2, 0, 'aerospace-quality')
  await import('../../scripts/presentation.mjs')
  process.exit(process.exitCode ?? 0)
}

const real = process.argv.includes('--real')
const previousUsd = real ? Number(process.env.AERO_PREVIOUS_USD ?? 0) : 0
assert.ok(Number.isFinite(previousUsd) && previousUsd >= 0 && previousUsd < 3)
const root =
  process.env.AERO_EVAL_ROOT ??
  join(homedir(), 'agh-real-eval', `${Date.now().toString(36)}-aerospace-${real ? 'real' : 'demo'}`)
const rt = await realRuntime('aerospace', root)
execFileSync(
  process.execPath,
  ['tools/toolchain/run.mjs', '--filter', '@agnes-showcase/aerospace-quality', 'build'],
  { stdio: 'inherit' },
)
execFileSync(process.execPath, ['tools/toolchain/run.mjs', '--filter', '@agnes/cli', 'build:local'], {
  stdio: 'inherit',
})
const packageId = '@agnes-showcase/aerospace-quality',
  profile = 'local-dev'
const evidence = {
  mode: real ? 'DeepSeek real model' : 'Demo deterministic model',
  node: process.version,
  root,
  checks: [],
  sessions: [],
  screenshots: [],
  usd: previousUsd,
  previousUsd,
  requestedModel: real ? (process.env.AGH_DEMO_MODEL ?? 'deepseek/deepseek-flash') : 'demo/demo-model',
}
console.log(JSON.stringify({ root, mode: evidence.mode, stage: 'starting' }))
let browser,
  page,
  scheduleId,
  approvalTarget,
  pendingSkillApproval,
  allow = true
const costs = new Map()
async function open(role) {
  const agent = `${packageId}#${role}`
  const plan = await rt.client.agents.resolve(agent)
  assert.equal(plan.ref, agent)
  const s = await rt.client.session.new({
    cwd: rt.workspace,
    agent,
    agentDigest: plan.digest,
    sessionKey: randomUUID(),
  })
  s.onPermissionRequest(async (r) => {
    const requestText = JSON.stringify(r.toolCall)
    const expected =
      (pendingSkillApproval &&
        requestText.toLowerCase().includes('skill') &&
        !requestText.includes('aero_decide')) ||
      (approvalTarget && requestText.includes(approvalTarget.id) && requestText.includes(approvalTarget.kind))
    const approve = Boolean(expected && allow)
    if (!expected) {
      evidence.unexpectedApprovals ??= []
      evidence.unexpectedApprovals.push({ label: evidence.activeStep, tool: r.toolCall })
    }
    evidence.checks.push(`native-approval:${approve ? 'allow' : 'reject'}`)
    if (page && JSON.stringify(r.toolCall).includes('aero_decide') && !evidence.approvalScreenshot) {
      await page.goto(`${rt.url}/?session=${s.id}&lang=zh-CN`)
      await page.getByTestId('approval-card').waitFor({ timeout: 15000 })
      await shot('native-human-mrb-approval')
      evidence.approvalScreenshot = true
    }
    const option =
      r.options.find((o) => o.kind === (approve ? 'allow_once' : 'reject_once')) ??
      r.options.find((o) => o.kind.startsWith(approve ? 'allow' : 'reject'))
    assert.ok(option, 'Expected native permission option')
    return { optionId: option.optionId }
  })
  await s.attach()
  if (real)
    await s.setModel({
      slot: 'primary',
      route: 'account-real-eval',
      model: (process.env.AGH_DEMO_MODEL ?? 'deepseek/deepseek-flash').split('/').slice(1).join('/'),
    })
  return s
}
async function run(s, prompt, label) {
  evidence.activeStep = label
  if (evidence.usd >= 2) throw new Error('Application $3 real-model budget cap reached')
  let watching = false
  const monitor = setInterval(async () => {
    if (watching) return
    watching = true
    try {
      const p = await s.projectUI()
      costs.set(s.id, (p.usage?.cost?.usdMicros ?? 0) / 1e6)
      evidence.usd = previousUsd + [...costs.values()].reduce((a, b) => a + b, 0)
      if (evidence.usd > 2) await s.cancel()
    } catch (error) {
      evidence.monitorError = rt.redact(error.message)
      if (real) await s.cancel().catch(() => {})
    } finally {
      watching = false
    }
  }, 1000)
  try {
    const signing = testOperatorSignatures(rt.client, s, {
      answer: () => (allow ? 'allowed-once' : 'rejected'),
    })
    const result = await s
      .prompt(prompt, {
        signal: AbortSignal.timeout(180000),
        ...(real ? { creditLimit: 0.8 } : {}),
      })
      .finally(() => signing.stop())
    const data = await snapshot(s)
    await rt.save(`${label}.json`, { result, ...data })
    assert.equal(result.reason, 'completed', `${label} did not complete: ${JSON.stringify(result)}`)
    if (real)
      assert.ok(
        data.timeline.usage?.billingComplete && (data.timeline.usage?.cost?.usdMicros ?? 0) > 0,
        'Real acceptance requires AGH-recorded complete billing',
      )
    costs.set(s.id, (data.timeline.usage?.cost?.usdMicros ?? 0) / 1e6)
    evidence.usd = previousUsd + [...costs.values()].reduce((a, b) => a + b, 0)
    evidence.sessions.push({
      label,
      id: s.id,
      reason: result.reason,
      tools: data.tools.map((t) => ({ name: t.name, isError: t.result?.isError ?? false })),
      usage: data.timeline.usage,
    })
    assert.ok(evidence.usd < 3, 'Application exceeded $3 cap')
    return data
  } finally {
    clearInterval(monitor)
  }
}
async function call(s, name, args, label) {
  if (name === 'aero_skill_candidate' && args.action === 'commit') pendingSkillApproval = args.proposalId
  approvalTarget =
    name === 'aero_decide'
      ? { kind: args.kind, id: args.id }
      : name === 'aero_skill_candidate' && args.action === 'commit'
        ? { skill: true }
        : undefined
  try {
    const prompt = `call ${name} ${JSON.stringify(args)}`
    return await run(
      s,
      real
        ? `本轮只执行下面这一项准确调用，不调用其他工具、不推进后续流程；返回结果后即停止。技能中的流程是背景，不是本轮额外授权。\n${prompt}`
        : prompt,
      label,
    )
  } finally {
    approvalTarget = undefined
  }
}

function output(data, name) {
  const r = data.tools.filter((t) => t.name === name).at(-1)?.result
  assert.ok(r && !r.isError, `${name} failed: ${JSON.stringify(r)}`)
  return r.structured.data
}
async function shot(name) {
  const path = join(root, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  evidence.screenshots.push(path)
}
try {
  evidence.stage = 'connect'
  await rt.connect()
  evidence.stage = 'fresh-gallery'
  await rt.startWeb()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } })
  await context.addInitScript(() => {
    const params = new URL(location.href).searchParams
    if (params.has('lang')) localStorage.setItem('agnes-locale', params.get('lang'))
    if (params.has('theme')) localStorage.setItem('agnes-theme', params.get('theme'))
  })
  page = await context.newPage()
  const catalog = await rt.client.packages.catalog.list({ profile, query: 'aerospace-quality' })
  const featured = catalog.items.find((p) => p.id === packageId)
  assert.ok(featured?.source.ref.includes('/showcase/'), 'Fresh catalog must feature the showcase source')
  await rt.save('fresh-featured-catalog.json', featured)
  await page.goto(`${rt.url}/?page=agents&lang=zh-CN&theme=light`)
  await page.locator(`[data-application="${packageId}"]`).waitFor({ timeout: 30000 })
  assert.equal(await page.locator(`[data-application="${packageId}"]`).count(), 1)
  assert.equal(await page.locator(`[data-agent-ref^="${packageId}#"]`).count(), 0)
  await shot('fresh-home-featured-gallery')
  evidence.checks.push('fresh-home-featured-showcase-gallery-five-role-agents')
  evidence.stage = 'install'
  await rt.cli(['plugins', 'add', 'file:./bundled-examples/showcase/aerospace-quality', '--yes'])
  // Package activation may restart the worker; reconnect only this isolated runtime.
  evidence.stage = 'restart-after-install'
  await rt.restart()
  evidence.stage = 'resolve-quality'
  try {
    await rt.client.agents.resolve(`${packageId}#quality`)
  } catch (error) {
    await rt.save('resolve-package-status.json', await rt.client.packages.list({ profile }))
    throw error
  }
  let installed
  for (let i = 0; i < 150; i++) {
    installed = (await rt.client.packages.list({ profile })).packages.find((p) => p.id === packageId)
    if (installed?.actual === 'running' || installed?.actual === 'failed') break
    await pause(200)
  }
  await rt.save('installed-package.json', installed)
  assert.equal(
    installed?.actual,
    'running',
    JSON.stringify({
      actual: installed?.actual,
      blockers: installed?.blockers,
      status: installed?.primaryStatus,
    }),
  )
  evidence.stage = 'adoption'
  const before = await rt.client.request('_agnes/v1/applications.get', { profile })
  assert.notEqual(before.effective?.id, 'qiongxu-aerospace-quality')
  const preview = await rt.client.request('_agnes/v1/applications.preview', { profile, packageId })
  await rt.save('adoption-preview.json', { ...preview, assets: Object.keys(preview.assets) })
  const adopted = await rt.client.request('_agnes/v1/applications.adopt', {
    profile,
    packageId,
    expectedRevision: before.revision,
    consentDigest: preview.consentDigest,
    clientId: await rt.client.clientId(),
    commandId: randomUUID(),
  })
  assert.equal(adopted.status, 'active')
  evidence.checks.push('install-inspect-explicit-adoption')
  if (real) {
    assert.ok(process.env.AGH_DEMO_API_KEY)
    await rt.configure()
    const smoke = await open('quality')
    await call(smoke, 'aero_quality', { view: 'dashboard' }, 'real-model-smoke')
  }
  await rt.startWeb()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  evidence.stage = 'page-matrix'
  for (const locale of ['zh-CN', 'en'])
    for (const theme of ['light', 'dark']) {
      for (const id of [
        'aero-home',
        'aero-requirements',
        'aero-tests',
        'aero-mrb',
        'aero-configuration',
        'aero-zeroing',
      ]) {
        await page.goto(`${rt.url}/?lang=${locale}&theme=${theme}&page=${id}`)
        await page.locator(`[data-aero-page="${id}"] h1`).waitFor({ timeout: 30000 })
        await page.locator('[data-aero-page] .aero-section').first().waitFor()
        await page.waitForFunction(
          () =>
            document.querySelector('[data-aero-page]')?.textContent.includes('QV-X27') &&
            !document.querySelector('[data-aero-page]')?.textContent.includes('Loading controlled'),
        )
        await pause(300)
        await shot(`${locale}-${theme}-${id}`)
        assert.ok(!(await page.locator('[data-aero-page] [role=alert]').count()), 'Page service failed')
      }
    }
  await page.goto(`${rt.url}/?lang=zh-CN&theme=light&page=aero-home`)
  await page.getByRole('button', { name: '调查异常', exact: true }).click()
  await page.locator('[data-aero-page=aero-tests] h1').waitFor()
  await page.locator('[data-aero-page] button').filter({ hasText: '查看证据' }).click()
  await page.getByRole('dialog').waitFor()
  await shot('anomaly-evidence-drawer')
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${rt.url}/?lang=zh-CN&theme=dark&page=aero-home`)
  await page.locator('[data-aero-page] h1').waitFor()
  await page.locator('[data-aero-page] .aero-section').first().waitFor()
  await pause(150)
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'Mobile page overflow',
  )
  await shot('zh-dark-mobile-home')
  await page.setViewportSize({ width: 1440, height: 1050 })
  evidence.stage = 'profile-service-effect'
  await page.goto(`${rt.url}/?lang=zh-CN&theme=light&page=aero-mrb`)
  await page
    .locator('article.aero-ncr')
    .filter({ hasText: 'NCR-018' })
    .getByRole('button', { name: '查看证据', exact: true })
    .click()
  await page
    .getByRole('dialog')
    .locator('textarea')
    .fill(
      'Quarantine L2609-B and restore affected units to the controlled drawing; re-verify VT-001/004/008 before release.',
    )
  await page.getByRole('button', { name: '保存审理草案', exact: true }).click()
  await page.getByText('已保存；请核对证据与审计记录。', { exact: true }).waitFor()
  await shot('profile-service-mrb-draft')
  await page.keyboard.press('Escape')
  evidence.checks.push('browser-profile-service-effect-persisted-draft')
  evidence.stage = 'investigation'
  const investigator = await open('investigator')
  await call(investigator, 'skill_read', { name: 'aerospace-quality-playbook' }, 'domain-skill-read')
  const diagnosis = await run(
    investigator,
    real
      ? '先调用 skill_read(name=aerospace-quality-playbook) 和 aero_playbook，再调用 aero_investigate 调查 AN-027。引用峰值、限值、批次更改与相似 NCR，区分事实/假设，提出替代解释和复现试验。不批准处置。'
      : 'call aero_investigate {"anomalyId":"AN-027"}',
    'investigation',
  )
  assert.ok(diagnosis.tools.some((t) => t.name === 'aero_investigate'))
  const brief = output(
    await call(investigator, 'aero_briefing', { locale: 'zh-CN' }, 'intelligent-evidence-briefing'),
    'aero_briefing',
  )
  const surfaces = await investigator.uiRead()
  assert.ok(surfaces.surfaces.some((s) => s.surface.id === brief.surfaceId))
  await page.goto(`${rt.url}/?session=${investigator.id}&surface=${brief.surfaceId}&lang=zh-CN`)
  await page.getByText('AN-027 证据简报', { exact: true }).first().waitFor({ timeout: 30000 })
  await shot('intelligent-ui-evidence-workbench')
  const quality = await open('quality')
  const dashboard = async (label) =>
    output(await call(quality, 'aero_quality', { view: 'dashboard' }, label), 'aero_quality')
  let h = await dashboard('before-mrb')
  const mrb = await open('mrb')
  const draft = real
    ? await run(
        mrb,
        `先读 aero_playbook 并调查 AN-027。比较 use-as-is/rework/repair/scrap/return-to-supplier，指出返工和修理的区别。根据受控证据，用 aero_mrb_draft 为 NCR-018 保存 rework 草案，expectedRevision=${h.revision}。隔离并拒收 L2609-B，恢复 PVD-011/012/013 原图样并复验 VT-001/004/008；不能把焊点疲劳说成已证实原因。不调用 aero_decide。`,
        'mrb-draft',
      )
    : await call(
        mrb,
        'aero_mrb_draft',
        {
          ncrId: 'NCR-018',
          disposition: 'rework',
          rationale:
            'Quarantine and reject L2609-B; restore PVD-011/012/013 to the controlled drawing and re-verify VT-001/004/008. Investigate solder fatigue without assuming causality.',
          expectedRevision: h.revision,
        },
        'mrb-draft',
      )
  output(draft, 'aero_mrb_draft')
  h = await dashboard('after-draft')
  allow = false
  await call(
    quality,
    'aero_decide',
    { kind: 'mrb', id: 'NCR-018', expectedRevision: h.revision },
    'mrb-refused',
  )
  assert.equal((await dashboard('after-refusal')).revision, h.revision)
  allow = true
  output(
    await call(
      quality,
      'aero_decide',
      { kind: 'mrb', id: 'NCR-018', expectedRevision: h.revision },
      'mrb-approved',
    ),
    'aero_decide',
  )
  const trace = await open('trace')
  output(
    await run(
      trace,
      real
        ? '先读 aero_playbook，然后调用 aero_trace 和 aero_change_review(ecrId=ECR-016)，指出需求、接口、复验影响与孤立/未测试缺口。'
        : 'call aero_trace {}',
      'traceability',
    ),
    'aero_trace',
  )
  output(
    await call(quality, 'aero_report', { kind: 'zeroing', locale: 'zh-CN' }, 'zeroing-report'),
    'aero_report',
  )
  h = await dashboard('before-rule')
  output(
    await call(quality, 'aero_rule_propose', { expectedRevision: h.revision }, 'rule-proposed'),
    'aero_rule_propose',
  )
  evidence.stage = 'native-skill'
  const candidate = output(
    await call(quality, 'aero_skill_candidate', { action: 'prepare' }, 'skill-prepared'),
    'aero_skill_candidate',
  )
  assert.ok(candidate.proposalId)
  let skill = output(
    await call(
      quality,
      'aero_skill_candidate',
      { action: 'commit', proposalId: candidate.proposalId },
      'skill-installed',
    ),
    'aero_skill_candidate',
  )
  for (let i = 0; i < 10 && ['prepared', 'running'].includes(skill.state); i++) {
    await pause(300)
    skill = output(
      await call(
        quality,
        'aero_skill_candidate',
        { action: 'status', proposalId: candidate.proposalId },
        `skill-status-${i}`,
      ),
      'aero_skill_candidate',
    )
  }
  assert.equal(skill.state, 'ready', JSON.stringify(skill))
  pendingSkillApproval = undefined
  assert.equal(skill.effective, 'next-turn')
  const skillRead = await call(
    quality,
    'skill_read',
    { name: 'aerospace-tvac-lot-screening' },
    'next-turn-native-skill-read',
  )
  assert.ok(skillRead.tools.some((t) => t.name === 'skill_read' && !t.result?.isError))
  h = await dashboard('before-rule-approval')
  output(
    await call(
      quality,
      'aero_decide',
      { kind: 'rule', id: 'TVAC-LOT-001', expectedRevision: h.revision },
      'rule-approved',
    ),
    'aero_decide',
  )
  const configuration = await open('configuration')
  const review = output(
    await call(configuration, 'aero_change_review', { ecrId: 'ECR-016' }, 'next-run-rule'),
    'aero_change_review',
  )
  assert.equal(review.screeningRequired, true)
  assert.equal(review.ruleVersion, 1)
  await page.goto(`${rt.url}/?lang=zh-CN&theme=light&page=aero-configuration`)
  await page.getByRole('heading', { name: /ECR-016/ }).scrollIntoViewIfNeeded()
  await page.locator('.aero-impact').waitFor()
  await shot('ecr-impact-screening-rule-v1')
  h = await dashboard('before-configuration')
  output(
    await call(
      quality,
      'aero_decide',
      { kind: 'configuration', id: 'ECR-016', expectedRevision: h.revision },
      'configuration-approved',
    ),
    'aero_decide',
  )
  evidence.checks.push('diagnosis-mrb-refusal-approval-trace-report-native-skill-next-run-configuration')
  await page.goto(`${rt.url}/?lang=zh-CN&theme=light&page=aero-zeroing`)
  await page.locator('[data-aero-page] h1').waitFor()
  await page.locator('[data-aero-page] .aero-section').first().waitFor()
  await shot('zeroing-after-demo')
  await page.goto(`${rt.url}/?session=${quality.id}&lang=zh-CN`)
  await page.getByTestId('conversation-turn').first().waitFor({ timeout: 30000 })
  await shot('demo-deliverables')
  await page.locator('#view-trace').click()
  await page.locator('#trace-panel').waitFor({ state: 'visible' })
  await page.locator('.trace-row').first().waitFor()
  await shot('native-execution-record')
  await page.locator('#view-chat').click()
  evidence.stage = 'automation'
  const scheduled = await rt.client.request('_agnes/v1/schedules.upsert', {
    agent: `${packageId}#quality`,
    title: 'QV-X27 weekly NCR digest / 每周 NCR 摘要',
    prompt: 'call aero_report {"kind":"digest","locale":"zh-CN"}',
    selector: { weekly: { time: '09:00', timeZone: 'Asia/Shanghai', weekdays: [1] } },
    target: { kind: 'new-session', cwd: rt.workspace, unattendedApproval: 'refuse' },
  })
  assert.ok(scheduled.id)
  scheduleId = scheduled.id
  await rt.client.request('_agnes/v1/schedules.control', { id: scheduled.id, action: 'run' })
  let schedule
  for (let i = 0; i < 150; i++) {
    schedule = (await rt.client.request('_agnes/v1/schedules.list', { scope: 'all' })).schedules.find(
      (s) => s.id === scheduled.id,
    )
    if (schedule.runs.some((r) => ['ran', 'failed', 'needs_attention'].includes(r.outcome))) break
    await pause(500)
  }
  await rt.save('automation.json', schedule)
  const last = schedule.runs.at(-1)
  assert.equal(last?.outcome, 'ran', JSON.stringify(schedule))
  const digest = await rt.client.session.load(last.sessionKey, { cwd: rt.workspace })
  await pause(real ? 10000 : 100)
  const digestData = await snapshot(digest)
  if (real)
    assert.ok(
      digestData.timeline.usage?.billingComplete && digestData.timeline.usage?.cost,
      'Scheduled real run needs AGH billing',
    )
  await rt.save('digest-run.json', digestData)
  assert.ok(digestData.tools.some((t) => t.name === 'aero_report' && !t.result?.isError))
  costs.set(digest.id, (digestData.timeline.usage?.cost?.usdMicros ?? 0) / 1e6)
  evidence.usd = previousUsd + [...costs.values()].reduce((a, b) => a + b, 0)
  await rt.client.request('_agnes/v1/schedules.control', { id: scheduled.id, action: 'pause' })
  evidence.checks.push('scheduled-weekly-digest-generated')
  await rt.restart()
  await rt.startWeb()
  const again = await open('quality')
  const after = output(
    await call(again, 'aero_change_review', { ecrId: 'ECR-016' }, 'restart-persistence'),
    'aero_change_review',
  )
  assert.equal(after.screeningRequired, true)
  assert.equal(after.ecr.status, 'approved')
  await page.goto(`${rt.url}/?lang=en&theme=dark&page=aero-configuration`)
  await page.locator('[data-aero-page] h1').waitFor()
  await page.locator('[data-aero-page] .aero-section').first().waitFor()
  await shot('restart-configuration-en-dark')
  evidence.checks.push('host-restart-persistence')
  const finalUsage = []
  for (const id of costs.keys()) {
    const session = await rt.client.session.load(id, { cwd: rt.workspace, history: 'none' })
    const usage = (await session.projectUI()).usage
    if (real) assert.ok(usage?.billingComplete && usage?.cost, 'Final real usage needs complete AGH billing')
    costs.set(id, (usage?.cost?.usdMicros ?? 0) / 1e6)
    finalUsage.push({ id, usage })
  }
  evidence.usd = previousUsd + [...costs.values()].reduce((a, b) => a + b, 0)
  await rt.save('final-usage.json', { previousUsd, totalUsd: evidence.usd, sessions: finalUsage })
  evidence.browserErrors = errors
  assert.deepEqual(errors, [])
  assert.deepEqual(evidence.unexpectedApprovals ?? [], [])
  assert.ok(evidence.usd < 3)
  if (real) assert.ok(evidence.usd > 0, 'Real-model acceptance must record non-zero AGH cost')
  evidence.passed = true
} catch (error) {
  evidence.error = rt.redact(error.stack ?? error.message)
  evidence.errorData = rt.redact(JSON.stringify(error.data ?? null))
  await rt.save('failure-roster.json', await rt.client.clientModules.list(profile).catch(() => null))
  evidence.passed = false
  if (page) {
    await shot('failure').catch(() => {})
    evidence.pageText = await page
      .locator('body')
      .innerText()
      .catch(() => '')
  }
  process.exitCode = 1
} finally {
  if (scheduleId)
    await rt.client
      .request('_agnes/v1/schedules.control', { id: scheduleId, action: 'pause' })
      .catch(() => {})
  await mkdir(root, { recursive: true })
  await rt.save('acceptance.json', evidence)
  await browser?.close()
  await rt.dispose().catch((error) => console.error(rt.redact(error.message)))
  console.log(
    JSON.stringify({
      root,
      mode: evidence.mode,
      passed: evidence.passed,
      error: evidence.error,
      errorData: evidence.errorData,
      stage: evidence.stage,
      usd: evidence.usd,
      checks: evidence.checks,
      screenshots: evidence.screenshots.length,
    }),
  )
}
