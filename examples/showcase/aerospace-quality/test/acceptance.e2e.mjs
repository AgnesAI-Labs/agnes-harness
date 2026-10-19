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
import { join, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { realRuntime, snapshot, pause } from '../../../../tools/authoring/real-runtime.mjs'
const real = process.argv.includes('--real')
const root =
  process.env.AERO_EVAL_ROOT ??
  join(homedir(), 'agh-real-eval', `${Date.now().toString(36)}-aerospace-${real ? 'real' : 'demo'}`)
const rt = await realRuntime('aerospace', root)
execFileSync(
  process.execPath,
  ['tools/toolchain/run.mjs', '--filter', '@agnes-showcase/aerospace-quality', 'build'],
  { stdio: 'inherit' },
)
const packageId = '@agnes-showcase/aerospace-quality',
  profile = 'local-dev'
const evidence = {
  mode: real ? 'DeepSeek real model' : 'Demo deterministic model',
  node: process.version,
  root,
  checks: [],
  sessions: [],
  screenshots: [],
  usd: 0,
}
console.log(JSON.stringify({ root, mode: evidence.mode, stage: 'starting' }))
let browser,
  page,
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
    evidence.checks.push(`native-approval:${allow ? 'allow' : 'reject'}`)
    if (page && JSON.stringify(r.toolCall).includes('aero_decide') && !evidence.approvalScreenshot) {
      await page.goto(`${rt.url}/?session=${s.id}&lang=zh-CN`)
      await page.getByTestId('approval-card').waitFor({ timeout: 15000 })
      await shot('native-human-mrb-approval')
      evidence.approvalScreenshot = true
    }
    const option =
      r.options.find((o) => o.kind === (allow ? 'allow_once' : 'reject_once')) ??
      r.options.find((o) => o.kind.startsWith(allow ? 'allow' : 'reject'))
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
  if (evidence.usd >= 2.8) throw new Error('Application $3 real-model budget cap reached')
  let watching = false
  const monitor = setInterval(async () => {
    if (watching) return
    watching = true
    try {
      const p = await s.projectUI()
      costs.set(s.id, (p.usage?.cost?.usdMicros ?? 0) / 1e6)
      evidence.usd = [...costs.values()].reduce((a, b) => a + b, 0)
      if (evidence.usd > 2.8) await s.cancel()
    } catch (error) {
      evidence.monitorError = rt.redact(error.message)
      if (real) await s.cancel().catch(() => {})
    } finally {
      watching = false
    }
  }, 1000)
  try {
    const result = await s.prompt(prompt, { signal: AbortSignal.timeout(180000) })
    const data = await snapshot(s)
    costs.set(s.id, (data.timeline.usage?.cost?.usdMicros ?? 0) / 1e6)
    evidence.usd = [...costs.values()].reduce((a, b) => a + b, 0)
    await rt.save(`${label}.json`, { result, ...data })
    evidence.sessions.push({
      label,
      id: s.id,
      reason: result.reason,
      tools: data.tools.map((t) => ({ name: t.name, isError: t.result?.isError ?? false })),
      usage: data.timeline.usage,
    })
    assert.equal(result.reason, 'completed', `${label} did not complete`)
    assert.ok(evidence.usd < 3, 'Application exceeded $3 cap')
    return data
  } finally {
    clearInterval(monitor)
  }
}
const call = (s, name, args, label) => run(s, `call ${name} ${JSON.stringify(args)}`, label)
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
  evidence.stage = 'install'
  await rt.cli(['plugins', 'add', resolve('examples/showcase/aerospace-quality'), '--yes'])
  // Package activation may restart the worker; reconnect only this isolated runtime.
  evidence.stage = 'restart-after-install'
  await rt.restart()
  evidence.stage = 'resolve-quality'
  await rt.client.agents.resolve(`${packageId}#quality`)
  let installed
  for (let i = 0; i < 150; i++) {
    installed = (await rt.client.packages.list({ profile })).packages.find((p) => p.id === packageId)
    if (installed?.actual === 'running' || installed?.actual === 'failed') break
    await pause(200)
  }
  await rt.save('installed-package.json', installed)
  assert.equal(installed?.actual, 'running', JSON.stringify({ actual: installed?.actual, blockers: installed?.blockers, status: installed?.primaryStatus }))
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
  }
  await rt.startWeb()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } })
  await context.addInitScript(() => {
    const params = new URL(location.href).searchParams
    if (params.has('lang')) localStorage.setItem('agnes-locale', params.get('lang'))
    if (params.has('theme')) localStorage.setItem('agnes-theme', params.get('theme'))
  })
  page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
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
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile page overflow')
  await shot('zh-dark-mobile-home')
  await page.setViewportSize({ width: 1440, height: 1050 })
  const investigator = await open('investigator')
  const diagnosis = await run(
    investigator,
    real
      ? '先调用 aero_playbook，再调用 aero_investigate 调查 AN-027。引用峰值、限值、批次更改与相似 NCR，区分事实/假设，提出替代解释和复现试验。不批准处置。'
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
  await shot('demo-deliverables-and-provenance')
  const scheduled = await rt.client.request('_agnes/v1/schedules.upsert', {
    agent: `${packageId}#quality`,
    title: 'QV-X27 weekly NCR digest / 每周 NCR 摘要',
    prompt: 'call aero_report {"kind":"digest","locale":"zh-CN"}',
    selector: { weekly: { time: '09:00', timeZone: 'Asia/Shanghai', weekdays: [1] } },
    target: { kind: 'new-session', cwd: rt.workspace, unattendedApproval: 'refuse' },
  })
  assert.ok(scheduled.id)
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
  const digestData = await snapshot(digest)
  assert.ok(digestData.tools.some((t) => t.name === 'aero_report' && !t.result?.isError))
  costs.set(digest.id, (digestData.timeline.usage?.cost?.usdMicros ?? 0) / 1e6)
  evidence.usd = [...costs.values()].reduce((a, b) => a + b, 0)
  await rt.save('digest-run.json', digestData)
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
  evidence.browserErrors = errors
  assert.deepEqual(errors, [])
  assert.ok(evidence.usd < 3)
  evidence.passed = true
} catch (error) {
  evidence.error = rt.redact(error.stack ?? error.message)
  evidence.errorData = rt.redact(JSON.stringify(error.data ?? null))
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
