// Fast-forward: a new live project taken to a review gate from the sample project shipped in assets/fastforward/ (assets/ is part of the packaged payload).
// The board moves only through the domain functions, in the order a real run takes, so every rule applies.
// Files come from the shipped templates and land only below the new project's workspaceDir.
import { readFileSync } from 'node:fs'
import {
  create,
  DomainError,
  decideGate,
  projectPath,
  read,
  recordArtifact,
  recordTestRun,
  submitGate,
  transition,
  update,
  upsertReqs,
} from './domain.mjs'

/** The only input: the gate the new project waits at. DONE is ADCP approved. */
export const GATES = ['CDCP', 'TR1', 'TR3', 'TR5', 'DONE']
export const PROJECT_NAME = '车门健康监测看板（演示快进）'
export const UNIT_TOTAL = 18

const AGENT = '研发协调员'
const HOUR = 3_600_000
const PEOPLE = { IPMT: 'IPMT 周明远', 技术负责人: '技术负责人 郭海涛', 质量工程师: '质量工程师 许静' }

// [level it first appears at, path relative to the project directory]; level 0 CDCP … 4 DONE.
export const FILES = [
  [0, 'docs/PROJECT-PLAN.md'],
  [1, 'docs/SRS.md'],
  [1, 'docs/RTM.md'],
  [2, 'docs/SAD.md'],
  [3, 'package.json'],
  [3, 'README.md'],
  [3, 'server.js'],
  [3, 'src/app.js'],
  [3, 'src/health.js'],
  [3, 'src/page.js'],
  [3, 'src/signals.js'],
  [3, 'test/app.test.js'],
  [3, 'test/health.test.js'],
  [3, 'test/signals.test.js'],
  [3, 'docs/TEST-REPORT.md'],
  [3, 'docs/ACCEPTANCE.md'],
  [4, 'docs/RELEASE-NOTE.md'],
]

const ARTIFACTS = [
  ['INITIATION', 'PLAN', 'docs/PROJECT-PLAN.md', '项目计划'],
  ['REQUIREMENTS', 'SRS', 'docs/SRS.md', '软件需求规格说明书'],
  ['REQUIREMENTS', 'RTM', 'docs/RTM.md', '需求追溯矩阵'],
  ['DESIGN', 'SAD', 'docs/SAD.md', '软件架构设计说明书'],
  ['IMPLEMENTATION', 'CODE', 'README.md', '源代码与运行说明'],
  ['VERIFICATION', 'TEST_REPORT', 'docs/TEST-REPORT.md', '系统测试报告'],
  ['VERIFICATION', 'ACCEPTANCE', 'docs/ACCEPTANCE.md', '浏览器验收记录'],
  ['RELEASE', 'RELEASE_NOTE', 'docs/RELEASE-NOTE.md', '发布说明'],
]

// Same ids as docs/SRS.md and docs/RTM.md (checked by the tests).
const CUS = [
  ['CUS-001', '按线路、车辆、车门三级展示车门健康评分', 'TA §3.1'],
  ['CUS-002', '列出最需要关注的车门，按严重程度排序', 'TA §3.2'],
  ['CUS-003', '数据为模拟 PHM 信号，页面须声明', 'TA §4.1'],
  ['CUS-004', '对外只提供只读 HTTP 接口，非法输入须拒绝', 'TA §4.2'],
].map(([id, text, clause]) => ({
  id,
  title: text,
  text,
  clause,
  compliance: 'COMPLY',
  responseNote: '按本项目 SRS 实现并在系统测试中验证。',
}))
const sub = (rows) => rows.map(([id, title, parent, extra]) => ({ id, title, text: title, parent, ...extra }))
const SYS = sub([
  ['SYS-001', '每扇门有 0 至 100 的健康评分和三档等级', ['CUS-001']],
  ['SYS-002', '页面支持线路、车辆、车门三级钻取', ['CUS-001']],
  ['SYS-003', '预警排行按评分从低到高列出前 N 扇门', ['CUS-002']],
  ['SYS-004', '信号由程序生成且可复现；接口只读并校验参数', ['CUS-003', 'CUS-004']],
])
const SWR = sub([
  ['SWR-001', '评分为五类信号的加权扣分，信号越界按边界处理', ['SYS-001']],
  ['SWR-002', '评分 80 及以上健康、60 及以上关注、其余告警；信号不低于 0.8 记为预警', ['SYS-001']],
  ['SWR-003', '页面先列线路，点线路列车辆，点车辆列车门；快速切换只显示最后一次选择', ['SYS-002']],
  ['SWR-004', '排行按评分升序，条数 1 至 50，默认 10', ['SYS-003']],
  ['SWR-005', '同一个种子生成同一批信号，覆盖 2 条线路共 56 扇门', ['SYS-004']],
  ['SWR-006', '只接受 GET；线路、车辆不存在或 limit 非法时返回 400', ['SYS-004']],
])
const TC = sub([
  ['TC-001', '评分：满分、零分、权重合计与信号越界', ['SWR-001']],
  ['TC-002', '等级在 80 与 60 的边界，预警信号阈值', ['SWR-002']],
  ['TC-003', '浏览器依次点线路、车辆，车门表与所选车辆一致', ['SWR-003']],
  ['TC-004', '排行升序与条数上限', ['SWR-004']],
  ['TC-005', '同种子同结果，56 扇门，信号取值在 0 至 1', ['SWR-005']],
  ['TC-006', '非 GET 返回 405，不存在的线路、车辆返回 400', ['SWR-006']],
  ['TC-007', '快速连续点两辆车，车门表显示最后点击的那辆', ['SWR-003']],
  ['TC-008', 'HTTP 取排行：limit 缺省、边界值与非法值', ['SWR-004']],
])
const DES = sub([
  [
    'DES-001',
    '评分、等级与排行（src/health.js）',
    ['SWR-001', 'SWR-002', 'SWR-004'],
    { module: 'src/health.js' },
  ],
  ['DES-002', '带种子的模拟信号（src/signals.js）', ['SWR-005'], { module: 'src/signals.js' }],
  ['DES-003', '路由与参数校验（src/app.js）', ['SWR-003', 'SWR-004', 'SWR-006'], { module: 'src/app.js' }],
  ['DES-004', '三级钻取页面（src/page.js）', ['SWR-003'], { module: 'src/page.js' }],
  ['DES-005', '启动入口与监听方式（server.js）', ['SWR-006'], { module: 'server.js' }],
])

const FINDINGS = [
  '评分函数对 undefined 信号未做保护，需补边界用例',
  '页面快速切换车辆时可能显示过期响应，需丢弃过期结果',
]

const cache = new Map()
/** The shipped template text of one file; the manifest is the only way in. */
export function templateText(rel) {
  if (!FILES.some(([, path]) => path === rel)) throw new DomainError(`模板中没有 ${rel}`)
  if (!cache.has(rel))
    cache.set(rel, readFileSync(new URL(`./assets/fastforward/${rel}`, import.meta.url), 'utf8'))
  return cache.get(rel)
}

// Hours after the project was created; the last event of each level happens eight hours before now.
const LAST_EVENT = [24, 72, 120, 250, 270]

/**
 * Advance a state to the gate, the way a real run does. Returns the new project and its newest gate.
 * `minSeq` skips project numbers whose directory already exists on disk (a reset keeps the files).
 */
function build(state, level, now, minSeq) {
  const t0 = now - (LAST_EVENT[level] + 8) * HOUR
  const at = (h) => t0 + h * HOUR
  const project = create(state, { kind: 'project', name: PROJECT_NAME, minSeq, by: AGENT }, t0)
  project.description =
    '宁川装备车门健康监测看板演示项目：由快进工具从包内样例推进到评审门，文件在工作区目录内。'
  const projectId = project.id
  const stageId = (stage) => `${projectId}/${stage}`
  // Register every deliverable of a stage, with the template text as the cached preview.
  const docs = (stage, h) => {
    for (const [s, kind, path, title] of ARTIFACTS)
      if (s === stage)
        recordArtifact(state, { projectId, stage, kind, path, title, markdown: templateText(path) }, at(h))
  }
  const start = (stage, h) =>
    transition(state, { kind: 'stage', id: stageId(stage), to: 'IN_PROGRESS', by: AGENT }, at(h))
  const submit = (stage, h, extra) =>
    submitGate(state, { stageId: stageId(stage), by: AGENT, ...extra }, at(h)).gate
  const approve = (gate, h) =>
    decideGate(state, { gateId: gate.id, decision: 'APPROVED', by: PEOPLE[gate.approverRoles[0]] }, at(h))
  const done = (gate) => ({ project, gate })

  // 概念
  docs('INITIATION', 4)
  let gate = submit('INITIATION', 24)
  if (level === 0) return done(gate)
  approve(gate, 30)

  // 需求
  start('REQUIREMENTS', 30)
  upsertReqs(state, { projectId, items: [...CUS, ...SYS, ...SWR, ...TC], by: AGENT }, at(52))
  docs('REQUIREMENTS', 54)
  gate = submit('REQUIREMENTS', 72)
  if (level === 1) return done(gate)
  approve(gate, 78)

  // 设计
  start('DESIGN', 78)
  upsertReqs(state, { projectId, items: DES.map((d) => ({ ...d, discipline: 'SW' })), by: AGENT }, at(100))
  docs('DESIGN', 102)
  gate = submit('DESIGN', 120)
  if (level === 2) return done(gate)
  approve(gate, 126)

  // 开发：TR4 的代码评审意见挂在门上，全部关闭后自动通过
  start('IMPLEMENTATION', 126)
  docs('IMPLEMENTATION', 150)
  gate = submit('IMPLEMENTATION', 172, { findings: FINDINGS })
  submit('IMPLEMENTATION', 190, {
    closeFindings: gate.findings.map((f) => ({ id: f.id, note: '已修复并由代码评审员复核' })),
  })

  // 验证
  start('VERIFICATION', 190)
  const run = (levelName, total, passed, failed, h, log) =>
    recordTestRun(state, { projectId, level: levelName, total, passed, failed, log }, at(h))
  run(
    'UNIT',
    UNIT_TOTAL,
    UNIT_TOTAL - 1,
    1,
    200,
    `node --test：${UNIT_TOTAL} 个用例，${UNIT_TOTAL - 1} 通过，1 失败（TC-002 等级边界）`,
  )
  run('UNIT', UNIT_TOTAL, UNIT_TOTAL, 0, 216, `node --test：${UNIT_TOTAL} 个用例全部通过（修复后复测）`)
  run('INTEGRATION', 8, 8, 0, 222, '真实 HTTP 请求 8 项全部通过（H-1 至 H-8）')
  run('SYSTEM', 12, 11, 1, 232, '真实浏览器 12 步，11 通过，B-9 失败（TC-007 快速切换车辆）')
  upsertReqs(
    state,
    {
      projectId,
      items: TC.filter((t) => t.id !== 'TC-007').map((t) => ({ id: t.id, status: 'VERIFIED' })),
      by: AGENT,
    },
    at(245),
  )
  docs('VERIFICATION', 248)
  gate = submit('VERIFICATION', 250)
  if (level === 3) return done(gate)
  approve(gate, 256)

  // 发布
  start('RELEASE', 256)
  docs('RELEASE', 260)
  gate = submit('RELEASE', 264)
  approve(gate, 270)
  return done(gate)
}

const exists = (fs, path) =>
  fs.stat(path).then(
    () => true,
    () => false,
  )

const NEXT = {
  CDCP: '请切换为 IPMT，在「我的待办」批准 CDCP，再点「继续推进」。',
  TR1: '请切换为技术负责人，在「我的待办」批准 TR1，再点「继续推进」。',
  TR3: '请切换为技术负责人，在「我的待办」批准 TR3，再点「继续推进」。',
  TR5: '请切换为质量工程师，在「我的待办」批准 TR5，再点「继续推进」。',
  ADCP: '项目已完成：在项目页的「交付成果」查看成果，点「启动并打开」运行应用。',
}

/** devboard_fastforward: write the stage's template files, then advance the board in one transaction. */
export async function fastForward(input, ctx) {
  const level = GATES.indexOf(input?.gate)
  if (level < 0) throw new DomainError(`gate 取值无效：${input?.gate}（可选 ${GATES.join(' / ')}）`)
  const now = Date.now()
  const rows = structuredClone(read(ctx.store, now))
  // Plan on a copy: the new project number, skipping directories that already exist on disk.
  let minSeq = 0
  let planned
  for (let tries = 0; tries < 50; tries++) {
    planned = build(structuredClone(rows), level, now, minSeq)
    if (!(await exists(ctx.fs, planned.project.workspaceDir))) break
    minSeq = Number(planned.project.id.split('-').at(-1)) + 1
    planned = undefined
  }
  if (!planned) throw new DomainError('devboard-projects/ 下已有太多旧项目目录，请先手动清理后再快进')
  const { project } = planned
  let files = 0
  for (const [from, rel] of FILES) {
    if (from > level) continue
    ctx.signal.throwIfAborted()
    await ctx.fs.write(projectPath(project, rel), templateText(rel))
    files++
  }
  ctx.signal.throwIfAborted()
  const { revision, result } = update(ctx.store, (state) => {
    const built = build(state, level, now, minSeq)
    if (built.project.id !== project.id) throw new DomainError('看板在快进期间发生变化，请重试')
    return built
  })
  const { gate } = result
  return {
    revision,
    data: {
      projectId: project.id,
      workspaceDir: project.workspaceDir,
      gate: gate.code,
      gateId: gate.id,
      decision: gate.decision,
      files,
      next: NEXT[gate.code],
    },
  }
}
