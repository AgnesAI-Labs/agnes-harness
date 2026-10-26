// Role lens (design 2026-10-22): which records concern a demo role. Pure functions over the board
// snapshot, no React, so node tests import this file directly. A lens is a view: it never changes
// who may act, and a kind or role without a rule below is simply "not related".

/** Decision roles: everything waiting for their decision concerns them. */
const DECIDERS = ['技术负责人', '分技术中心主任', 'IPMT']
const HOUR = 3_600_000

/**
 * "软件设计师 林涛" is held by 软件设计师. The whole role is compared (not the text before the first
 * space) because "RAMS 工程师" contains a space itself.
 */
const holds = (role, who) => {
  if (typeof who !== 'string') return false
  // The coordinator signs as "研发协调员 · 系统设计师（需求）": the role it acted as holds the record.
  const name = who.replace(/^研发协调员 · /, '')
  return name === role || [' ', '（', '('].some((suffix) => name.startsWith(role + suffix))
}
const among = (role, ...roles) => roles.includes(role)
const stageOf = (data, gate) => data.stages.find((s) => s.id === gate.stageId)
/** A running approval of this record that is waiting for the role. */
const waitingFor = (role, data, type, id) =>
  data.approvals.some(
    (a) =>
      a.state === 'RUNNING' &&
      a.subject.type === type &&
      a.subject.id === id &&
      a.waitingRoles.includes(role),
  )

const REQ_LEVELS = {
  机械设计师: [],
  电气设计师: [],
  软件设计师: ['SWR', 'DES'],
  系统设计师: ['CUS', 'SYS'],
  产品经理: ['CUS', 'SYS'],
  验证工程师: ['TC'],
  客户代表: ['CUS'],
}
const REQ_DISCIPLINE = { 机械设计师: 'MECH', 电气设计师: 'ELEC', 软件设计师: 'SW' }
const TASK_ROLES = {
  DEVELOPMENT: ['软件设计师'],
  TESTING: ['验证工程师'],
  AUTO_RELEASE: ['配置管理员'],
  REQUIREMENT_BREAKDOWN: ['系统设计师', '产品经理'],
  SECURITY_CHECK: ['质量工程师', 'RAMS 工程师'],
}

/**
 * The project manager is the default demo role. Besides tasks it follows what moves the plan:
 * changed requirements, changes before the CCB, severe open defects, unapproved trials, open 8Ds.
 */
const PM = '项目经理'

/** kind → (role, item, data) => boolean. */
const RULES = {
  stage: (role, s) => s.author === role,
  gate: (role, g, data) => g.approverRoles.includes(role) || stageOf(data, g)?.author === role,
  artifact: (role, a) => a.authorRole === role,
  req: (role, r) =>
    (role === PM && r.status === 'CHANGED') ||
    (Object.hasOwn(REQ_LEVELS, role) &&
      (REQ_LEVELS[role].includes(r.level) ||
        (Boolean(r.discipline) && r.discipline === REQ_DISCIPLINE[role]))),
  task: (role, t) => role === PM || (Object.hasOwn(TASK_ROLES, t.type) && TASK_ROLES[t.type].includes(role)),
  change: (role, c, data) =>
    holds(role, c.raisedBy) ||
    among(role, '技术负责人', '分技术中心主任') ||
    ((role === PM || DECIDERS.includes(role)) && c.state === 'CCB_REVIEW') ||
    (role === '配置管理员' && Boolean(c.ecn)) ||
    waitingFor(role, data, 'change', c.id),
  defect: (role, d) =>
    holds(role, d.owner) ||
    among(role, '质量工程师', '验证工程师') ||
    (role === PM && ['A', 'B'].includes(d.severity) && d.state !== 'CLOSED'),
  testRun: (role) => among(role, '验证工程师', '质量工程师'),
  trial: (role, t) =>
    among(role, '验证工程师', '质量工程师') ||
    (role === PM && t.state !== 'APPROVED') ||
    (role === '工艺工程师' && t.type === 'FAI') ||
    (among(role, '机械设计师', '电气设计师') && t.type === 'TYPE_TEST'),
  fault: (role, f) =>
    among(role, '诊断工程师', 'RAMS 工程师', '质量工程师') || (role === '客服工程师' && f.source === '客服'),
  problem: (role, p) =>
    role === '质量工程师' ||
    (role === PM && p.state !== 'CLOSED') ||
    Boolean(p.steps?.D1?.text?.includes(role)),
  configBaseline: (role) => role === '配置管理员',
  approval: (role, a) => a.nodes.some((n) => n.roles.includes(role)) || a.initiator?.role === role,
  intervention: (role, i) => role === PM || holds(role, i.handler),
}

/** Does `item` of this `kind` concern `role`? `data` is the board snapshot (stages and approvals are looked up). */
export function relevant(role, kind, item, data) {
  if (typeof role !== 'string' || !role || !Object.hasOwn(RULES, kind)) return false
  return RULES[kind](role, item, data) === true
}

/** kind → collection of the snapshot. */
export const COLLECTION = {
  stage: 'stages',
  gate: 'gates',
  artifact: 'artifacts',
  req: 'reqs',
  task: 'tasks',
  change: 'changes',
  defect: 'defects',
  testRun: 'testRuns',
  trial: 'trials',
  fault: 'faults',
  problem: 'problems',
  configBaseline: 'configBaselines',
  approval: 'approvals',
  intervention: 'interventions',
}

/** Metric → [card label, kind, is the record still open]. */
export const METRICS = {
  stage: ['进行中的阶段', 'stage', (s) => ['IN_PROGRESS', 'IN_REVIEW', 'REWORK'].includes(s.state)],
  gate: ['待决议评审门', 'gate', (g) => g.decision === 'PENDING'],
  artifact: ['未定稿交付物', 'artifact', (a) => a.status !== 'BASELINED'],
  reqs: ['相关需求', 'req', () => true],
  req: ['待确认需求', 'req', (r) => r.status === 'DRAFT' || r.status === 'CHANGED'],
  task: ['未完成任务', 'task', (t) => !['COMPLETED', 'CANCELLED'].includes(t.state)],
  change: ['未关闭变更', 'change', (c) => !['CLOSED', 'REJECTED'].includes(c.state)],
  defect: ['未关闭缺陷', 'defect', (d) => d.state !== 'CLOSED'],
  trial: ['未批准试验', 'trial', (t) => t.state !== 'APPROVED'],
  review: ['待审试验报告', 'trial', (t) => t.state === 'REPORTED'],
  fault: ['未关闭预警', 'fault', (f) => f.state !== 'CLOSED'],
  problem: ['未关闭 8D', 'problem', (p) => p.state !== 'CLOSED'],
  baseline: ['配置基线', 'configBaseline', () => true],
  flow: ['流转中的审批', 'approval', (a) => a.state === 'RUNNING'],
  joined: ['参与的审批流程', 'approval', () => true],
}

/** The metric cards of each role's home next to "待我处理"; roles without an entry use the default. */
const CARDS = {
  项目经理: ['stage', 'gate', 'task'],
  产品经理: ['reqs', 'stage', 'artifact'],
  系统设计师: ['reqs', 'stage', 'change'],
  机械设计师: ['reqs', 'trial', 'flow'],
  电气设计师: ['reqs', 'trial', 'flow'],
  软件设计师: ['defect', 'req', 'task'],
  验证工程师: ['trial', 'defect', 'stage'],
  质量工程师: ['defect', 'problem', 'review'],
  'RAMS 工程师': ['fault', 'flow', 'joined'],
  配置管理员: ['baseline', 'change', 'task'],
  诊断工程师: ['fault', 'problem', 'change'],
  客服工程师: ['fault', 'problem'],
  技术负责人: ['gate', 'change', 'flow'],
  分技术中心主任: ['gate', 'change', 'flow'],
  IPMT: ['gate', 'change', 'flow'],
  客户代表: ['reqs', 'gate', 'change'],
  标准化工程师: ['flow', 'joined'],
  工艺工程师: ['trial', 'flow', 'joined'],
}
export const cardsOf = (role) => (Object.hasOwn(CARDS, role) ? CARDS[role] : ['flow', 'gate', 'change'])

/** Where an urgent record opens: [home entry, detail page of that entry, badge text]. */
const OPENS = {
  approval: ['devboard-reviews', 'approval', '审批'],
  gate: ['devboard-reviews', 'gate', '评审门'],
  intervention: ['devboard-reviews', 'intervention', '人工介入'],
  change: ['devboard-changes', 'detail', '变更'],
  defect: ['devboard-quality', 'detail', '缺陷'],
  trial: ['trials', 'detail', '试验'],
  problem: ['service', 'problem', '8D'],
  fault: ['service', 'fault', '预警'],
}

const dueOf = (iso) => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t
}

/** The open records of the role that are late or about to be: { kind, entry, page, id, title, meta, overdue, due, dueLabel }. */
function urgentOf(role, data) {
  const now = Date.parse(data.now)
  const mine = (kind, open) => data[COLLECTION[kind]].filter((x) => relevant(role, kind, x, data) && open(x))
  const out = []
  const add = (kind, x, title, meta, overdue, due = Number.POSITIVE_INFINITY, dueLabel = '') => {
    const [entry, page, label] = OPENS[kind]
    out.push({ kind: label, entry, page, id: x.id, title, meta, overdue: Boolean(overdue), due, dueLabel })
  }
  for (const a of mine('approval', METRICS.flow[2])) {
    const node = a.nodes[a.current]
    const due = node ? dueOf(node.enteredAt) + node.dueHours * HOUR : undefined
    const meta = `${node?.name ?? ''}待 ${a.waitingRoles.join('、')}${a.overdue ? ' · 已超时' : ''} · ${a.projectId}`
    add('approval', a, a.title, meta, a.overdue, due, '节点到期')
  }
  for (const g of mine('gate', METRICS.gate[2])) {
    const stage = stageOf(data, g)
    const due = dueOf(stage?.plannedEnd)
    add(
      'gate',
      g,
      `${g.code} · ${g.name} · ${stage?.projectId ?? ''}`,
      `待 ${g.approverRoles.filter((r) => !(g.signatures ?? []).some((s) => s.role === r)).join('、')}`,
      due < now,
      due,
      '阶段计划完成',
    )
  }
  for (const i of mine('intervention', (x) => x.state === 'OPEN' || x.state === 'EXPIRED'))
    add('intervention', i, i.ask, '待人工处理', i.state === 'EXPIRED', dueOf(i.dueAt), '截止')
  for (const t of mine(
    'trial',
    (x) => x.state !== 'APPROVED' && (x.result === 'FAIL' || x.state === 'REPORTED'),
  )) {
    const meta = `${t.result === 'FAIL' ? '不合格' : '待审报告'} · ${t.projectId}`
    add('trial', t, t.title, meta, t.result === 'FAIL', dueOf(t.plannedAt), '计划试验')
  }
  for (const c of mine('change', METRICS.change[2]))
    add(
      'change',
      c,
      c.title,
      `${c.state === 'CCB_REVIEW' ? '待 CCB 决议' : '未关闭'} · ${c.projectId}`,
      false,
    )
  for (const d of mine('defect', (x) => x.state !== 'CLOSED' && (x.severity === 'A' || x.severity === 'B')))
    add('defect', d, d.title, `${d.severity} 级 · ${d.owner ?? '未分配'}`, d.severity === 'A')
  for (const p of mine('problem', METRICS.problem[2]))
    add('problem', p, p.title, `等级 ${p.severity} · ${p.projectId}`, false)
  return out
}

/** Human-intervention requests waiting for the role: every open or expired one, except for engineers. */
export const waitingInterventions = (role, data) =>
  /工程师$/.test(role) ? [] : data.interventions.filter((i) => i.state === 'OPEN' || i.state === 'EXPIRED')

/**
 * What the role's home shows: how many records wait for the role, how many open records of each metric
 * concern it, and the (at most five) most urgent ones - late first, then by due date.
 */
export function lensSummary(role, data) {
  const pending =
    data.approvals.filter((a) => a.state === 'RUNNING' && a.waitingRoles.includes(role)).length +
    data.gates.filter(
      (g) =>
        g.decision === 'PENDING' &&
        g.approverRoles.includes(role) &&
        !(g.signatures ?? []).some((s) => s.role === role) &&
        stageOf(data, g)?.author !== role,
    ).length +
    waitingInterventions(role, data).length
  const counts = Object.fromEntries(
    Object.entries(METRICS).map(([key, [, kind, open]]) => [
      key,
      data[COLLECTION[kind]].filter((x) => relevant(role, kind, x, data) && open(x)).length,
    ]),
  )
  const urgent = urgentOf(role, data)
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.due === b.due ? 0 : a.due < b.due ? -1 : 1))
    .slice(0, 5)
  return { pending, counts, urgent }
}
