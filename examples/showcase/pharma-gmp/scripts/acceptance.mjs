import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { testOperatorSignatures } from '../../scripts/signatures.mjs'
import { captureBrowser, captureFeaturedGallery } from './browser.mjs'
import { ruleFiles } from './rule-candidate.mjs'
import { runtime, toolResult, until } from './runtime.mjs'

if (process.argv.includes('--real')) {
  process.argv.splice(2, 0, 'pharma-gmp')
  await import('../../scripts/presentation.mjs')
  process.exit(process.exitCode ?? 0)
}

const real = process.argv.includes('--real'),
  browser = process.argv.includes('--browser')
const rt = await runtime(real),
  evidence = { real, root: rt.root, checks: [], sessions: {}, passed: false }
console.log(JSON.stringify({ root: rt.root, mode: real ? 'DeepSeek' : 'Demo' }))
let browserRun
let turns = 0
const activeSessions = new Map()
const priorUsd = Number(process.env.AGH_PHARMA_PRIOR_USD ?? 0)
assert.ok(Number.isFinite(priorUsd) && priorUsd >= 0 && priorUsd < 3)
const spentUsd = () =>
  priorUsd + Object.values(evidence.sessions).reduce((sum, s) => sum + (s.budget?.state?.creditsUsed ?? 0), 0)
async function run(session, prompt, label, expectedTool) {
  assert.ok(++turns <= 40, 'Maximum 40 budgeted turns')
  if (real) for (const [id, handle] of activeSessions) evidence.sessions[id].budget = await handle.budget()
  // The catalogue reserves up to 384k output tokens (~$0.46), even for a short tool call.
  // Keep at least $1.50 for the nightly job and background accounting; never spend the whole cap.
  const creditLimit = real ? Math.min(0.75, 1.5 - spentUsd()) : undefined
  if (real) assert.ok(creditLimit > 0, 'Application reasoning budget exhausted')
  const signing = testOperatorSignatures(rt.client, session)
  const result = await session
    .prompt(prompt, {
      signal: AbortSignal.timeout(150000),
      creditLimit,
    })
    .finally(() => signing.stop())
  const timeline = await session.projectUI(undefined, { surface: 'web' }),
    budget = await session.budget()
  evidence.sessions[session.id] = { timeline, budget, pin: await session.capabilities() }
  activeSessions.set(session.id, session)
  await rt.save('acceptance.json', evidence)
  assert.equal(result.reason, 'completed', `${label}: ${JSON.stringify(result)}`)
  if (expectedTool) return toolResult(session, expectedTool)
}
async function call(s, name, args, label = name) {
  const instruction =
    real && name.startsWith('plugin_helper_')
      ? 'Execute only the following explicitly authorized tool call. Preserve every supplied JSON argument and file content exactly, including imports and manifest fields; the fixture uses the current public SDK. Do not rewrite it to a guide template or perform extra candidate operations. This step is authorized separately from the earlier proposal-only turn.\n'
      : ''
  return run(s, `${instruction}call ${name} ${JSON.stringify(args)}`, label, name)
}
try {
  if (browser) {
    await rt.startWeb()
    await captureFeaturedGallery(rt)
    evidence.checks.push('fresh-home-featured-gallery-five-roles')
  }
  const preview = await rt.install('examples/showcase/pharma-gmp')
  assert.equal(preview.id, '@agnes-showcase/pharma-gmp')
  assert.equal(preview.application.id, 'sableleaf-quality')
  const before = await rt.client.request('_agnes/v1/applications.get', { profile: 'local-dev' })
  assert.notEqual(before.effective?.id, 'sableleaf-quality')
  const adoption = await rt.client.request('_agnes/v1/applications.preview', {
    profile: 'local-dev',
    packageId: preview.id,
  })
  const selected = await rt.client.request('_agnes/v1/applications.adopt', {
    profile: 'local-dev',
    packageId: preview.id,
    expectedRevision: before.revision,
    consentDigest: adoption.consentDigest,
    clientId: await rt.client.clientId(),
    commandId: randomUUID(),
  })
  assert.equal(selected.status, 'active')
  evidence.adoption = {
    status: selected.status,
    application: selected.effective?.id,
    consentDigest: adoption.consentDigest,
  }
  for (const role of ['hub', 'reviewer', 'investigator', 'em', 'release']) {
    const plan = await rt.client.agents.resolve(`${preview.id}#${role}`)
    assert.equal(plan.preset, 'gmp')
    assert.ok(plan.permission.tools.includes('pharma_inspect'))
  }
  evidence.checks.push('inspect-install-adopt-five-agents')
  if (browser) {
    browserRun = await captureBrowser(rt)
    evidence.browser = browserRun.evidence
  }
  const investigator = await rt.session('investigator'),
    qa = await rt.session('release'),
    reviewer = await rt.session('reviewer'),
    em = await rt.session('em'),
    hub = await rt.session('hub')
  const inspected = await call(investigator, 'pharma_inspect', { batch: 'B-2410-017' })
  assert.deepEqual(inspected.relatedBatches, ['B-2410-016', 'B-2410-018'])
  assert.ok(inspected.em.every((s) => s.viable === 72))
  if (real) {
    await run(
      investigator,
      '使用 gmp-review 技能（宿主若已注入，不要重复读取），根据刚才工具证据，用中文提出 5-Why、根因假设、CAPA 责任人及期限、其他批次影响。按清单逐项核对阻断数量。必须明确 72 CFU/m³ 仅超过警戒而非行动值，EM 相关性不是因果，探头漂移尚需证据确认；不要写入。',
      'investigation reasoning',
    )
    const skillLoaded = evidence.sessions[investigator.id].timeline.nodes.find(
      (node) =>
        node.kind === 'context' &&
        typeof node.text === 'string' &&
        node.text.startsWith('[skill loaded]') &&
        node.text.includes('name: gmp-review') &&
        node.text.includes('GMP 质量工作规程'),
    )
    assert.ok(skillLoaded, 'Host must inject the registered trusted domain playbook')
    evidence.playbook = { loaded: true, seq: skillLoaded.seq }
    evidence.checks.push('real-agent-loads-domain-playbook')
  }
  const blocked = await call(qa, 'pharma_dossier', { batch: 'B-2410-017' })
  assert.equal(blocked.ready, false)
  if (real)
    await run(
      qa,
      '使用 gmp-review 技能，用中文解释清单为何阻止 B-2410-017 放行，指出还需要哪些独立证据、人工签名和版本绑定。不要尝试放行。',
      'release blocker reasoning',
    )
  evidence.checks.push('evidence-correlated-release-blocked')
  let revision = 0
  for (const action of ['investigate', 'advance', 'advance', 'advance']) {
    const args = {
      action,
      batch: 'B-2410-017',
      expectedRevision: revision,
      ...(action === 'advance'
        ? {
            evidence: [
              '',
              'SIM-CAL-017: synthetic as-found T02 +4.1 C and as-left calibration reviewed; retrospective 016/017/018 impact assessment',
              'SIM-REPROCESS-017: approved synthetic reprocessing protocol, independent LOD 1.9%, QC, cleaning and EM identification/resampling reviewed',
              'SIM-EFFECT-017: three synthetic verification batches and overdue escalation effectiveness confirmed',
            ][revision],
          }
        : {}),
    }
    const changed = await call(investigator, 'pharma_record', args)
    assert.equal(changed.revision, ++revision)
  }
  const reviewed = await call(reviewer, 'pharma_record', {
    action: 'review',
    batch: 'B-2410-017',
    expectedRevision: revision,
  })
  revision++
  assert.equal(reviewed.dossier.ready, true)
  // The signing role must itself read the reviewed dossier, rather than rely on another role's receipt.
  const signable = await call(qa, 'pharma_dossier', { batch: 'B-2410-017' })
  assert.equal(signable.revision, revision)
  assert.equal(signable.ready, true)
  assert.deepEqual(signable.blockers, [])
  if (browserRun) await browserRun.capture('pre-signature', 'release')
  const meaning =
    'I approve this batch for release after reviewing the complete quality dossier. / 我已审核完整质量档案，批准本批放行。'
  if (browserRun)
    rt.onApproval(async (sessionId, request) => {
      if (JSON.stringify(request.toolCall).includes('pharma_release'))
        await browserRun.captureApproval(sessionId)
    })
  const released = await call(qa, 'pharma_release', {
    batch: 'B-2410-017',
    expectedRevision: revision,
    meaning,
  })
  revision++
  rt.onApproval(undefined)
  assert.ok(released.dossier.certificate.approvalId)
  assert.equal(released.dossier.certificate.meaning, '我已审核完整质量档案，批准本批放行。')
  assert.equal(released.dossier.certificate.dossierRevision, 5)
  evidence.certificate = released.dossier.certificate
  evidence.checks.push('approved-capa-retest-bpr-release')
  for (const kind of ['dossier', 'apqr', 'deviations']) {
    const output = await call(qa, 'pharma_report', { kind, batch: 'B-2410-017', locale: 'zh-CN' })
    for (const file of output.files)
      assert.ok((await readFile(join(rt.workspace, file), 'utf8')).length > 300)
  }
  evidence.checks.push('markdown-html-present-deliverables')
  const retainedGeneration = (await qa.capabilities()).codePin.generationId
  if (real) {
    await call(hub, 'pharma_dossier', { batch: 'B-2410-017' })
    await run(
      hub,
      '根据刚读取的 B-2410-017/DR-02 证据，提出一个“设备使用日期距校准到期 0–7 天预警，逾期单独报告”的可复用只读检查规则，说明边界、测试和人工审阅。本轮仅提议；之后我会另行给出创建、测试、提交审阅的明确指令。不要猜测批次编号。',
      'reviewed skill proposal',
    )
  }
  const files = ruleFiles()
  const draft = await call(hub, 'plugin_helper_create', { files })
  const candidate = await rt.client.request('_agnes/v1/plugins.candidates.show', {
    profile: 'local-dev',
    candidateId: draft.candidateId,
  })
  assert.equal(candidate.state, 'draft')
  assert.deepEqual(
    Object.fromEntries(candidate.sourceFiles.map((f) => [f.path, f.content])),
    Object.fromEntries(files.map((f) => [f.path, f.content])),
    'Agent must preserve the exact reviewed fixture source',
  )
  await call(hub, 'plugin_helper_install', { action: 'test', proposalId: draft.candidateId })
  await call(hub, 'plugin_helper_install', { action: 'commit', proposalId: draft.candidateId })
  const review = await rt.client.request('_agnes/v1/plugins.candidates.show', {
    profile: 'local-dev',
    candidateId: draft.candidateId,
  })
  assert.equal(review.state, 'review')
  assert.equal(review.tests.state, 'passed')
  assert.equal(review.tests.hash, review.candidateHash)
  await rt.client.request('_agnes/v1/plugins.candidates.approve', {
    ...(await rt.command()),
    candidateId: draft.candidateId,
    expectedHash: review.candidateHash,
    reviewHash: review.reviewHash,
  })
  await until(
    () => rt.client.packages.list({ profile: 'local-dev' }),
    (status) =>
      status.packages.some((p) => p.id === 'sableleaf-calibration-window' && p.actual === 'running'),
    'reviewed candidate activation',
  )
  const provenance = await rt.client.request('_agnes/v1/packages.provenance', {
    profile: 'local-dev',
    id: 'sableleaf-calibration-window',
  })
  assert.equal(provenance.installer, 'agent')
  assert.equal((await qa.capabilities()).codePin.generationId, retainedGeneration)
  evidence.retainedGeneration = retainedGeneration
  const fresh = await rt.client.session.new({
    sessionKey: randomUUID(),
    cwd: rt.workspace,
    preset: 'standard',
    bundles: [],
  })
  fresh.onPermissionRequest(async (r) => ({
    optionId: r.options.find((o) => o.kind === 'allow_once').optionId,
  }))
  await fresh.attach()
  if (real) await fresh.setModel({ slot: 'primary', route: 'account-pharma-eval', model: 'deepseek-flash' })
  assert.deepEqual(
    await call(fresh, 'sableleaf_calibration_window', {
      processedOn: '2024-10-16',
      calibrationDue: '2024-10-16',
    }),
    { days: 0, nearExpiry: true, expired: false },
  )
  assert.deepEqual(
    await call(fresh, 'sableleaf_calibration_window', {
      processedOn: '2024-10-17',
      calibrationDue: '2024-10-16',
    }),
    { days: -1, nearExpiry: false, expired: true },
  )
  evidence.growth = {
    candidateId: draft.candidateId,
    hash: review.candidateHash,
    reviewHash: review.reviewHash,
    state: 'published',
    provenance,
  }
  evidence.checks.push('reviewed-candidate-published-next-session-rule', 'existing-session-retains-code-pin')
  await call(em, 'pharma_report', { kind: 'em', locale: 'zh-CN' })
  const schedule = await rt.client.request('_agnes/v1/schedules.upsert', {
    agent: `${preview.id}#em`,
    title: '沙叶夜间 EM / Sableleaf nightly EM',
    prompt: 'call pharma_report {"kind":"em","locale":"zh-CN"}',
    selector: { daily: { time: '02:00', timeZone: 'Asia/Shanghai' } },
    target: { kind: 'new-session', cwd: rt.workspace, unattendedApproval: 'refuse' },
  })
  assert.ok(schedule.target.bundles.includes(`${preview.id}#em`))
  await rt.client.request('_agnes/v1/schedules.control', { id: schedule.id, action: 'run' })
  const ran = await until(
    async () =>
      (await rt.client.request('_agnes/v1/schedules.list', { scope: 'all' })).schedules.find(
        (s) => s.id === schedule.id,
      ),
    (s) => s.runs.some((r) => ['ran', 'failed', 'needs_attention'].includes(r.outcome)),
    'nightly automation',
    150000,
  )
  assert.equal(ran.runs.at(-1).outcome, 'ran', JSON.stringify(ran.runs))
  evidence.schedule = ran
  const scheduled = await rt.client.session.load(ran.runs.at(-1).sessionKey, { cwd: rt.workspace })
  await scheduled.attach()
  evidence.sessions[scheduled.id] = {
    timeline: await scheduled.projectUI(undefined, { surface: 'web' }),
    budget: await scheduled.budget(),
  }
  activeSessions.set(scheduled.id, scheduled)
  await rt.save('acceptance.json', evidence)
  await toolResult(scheduled, 'pharma_report')
  await rt.client.request('_agnes/v1/schedules.control', { id: schedule.id, action: 'pause' })
  evidence.schedule = ran
  evidence.checks.push('nightly-agent-target-run-deliverable')
  if (browserRun) {
    await browserRun.capture('certificate', 'release')
    await browserRun.capture('audit-after-release', 'audit')
    await browserRun.close()
    browserRun = undefined
  }
  for (const [id, handle] of activeSessions) evidence.sessions[id].budget = await handle.budget()
  activeSessions.clear()
  await rt.restart()
  const after = await rt.session('release')
  const persisted = await call(after, 'pharma_dossier', { batch: 'B-2410-017' })
  assert.deepEqual(persisted.certificate, evidence.certificate)
  assert.deepEqual(persisted.blockers, [])
  assert.equal(persisted.evidence.retests.at(-1).value, 1.9)
  if (real) {
    await run(
      after,
      '使用 gmp-review 技能，根据刚返回的完整档案，解释历史原始发现与当前阻断的区别、返工复验和偏差结案证据，以及证书 dossierRevision 与当前状态 revision 的关系。只读，不重复放行。',
      'released dossier interpretation',
    )
    assert.ok(
      evidence.sessions[after.id].timeline.nodes.some(
        (n) =>
          n.kind === 'context' && n.text?.startsWith('[skill loaded]') && n.text.includes('name: gmp-review'),
      ),
      'Registered domain playbook must remain invocable after restart',
    )
    evidence.playbook.afterRestartLoaded = true
  }
  evidence.checks.push('host-restart-retains-certificate')
  evidence.passed = true
} catch (error) {
  evidence.error = rt.redact(error.message)
  if (error.data) {
    evidence.errorDetails = JSON.parse(rt.redact(JSON.stringify(error.data)))
    console.error(JSON.stringify(evidence.errorDetails))
  }
  console.error(rt.redact(error.stack))
  process.exitCode = 1
} finally {
  await browserRun?.close().catch(() => {})
  evidence.priorAttemptsUsd = priorUsd
  evidence.aghEstimatedUsd = spentUsd()
  if (evidence.aghEstimatedUsd >= 3) {
    evidence.passed = false
    evidence.error = 'Application cost cap exceeded'
    process.exitCode = 1
  }
  await rt.save('acceptance.json', evidence)
  await rt.dispose()
  console.log(
    JSON.stringify({
      root: rt.root,
      passed: evidence.passed,
      checks: evidence.checks,
      error: evidence.error,
    }),
  )
}
