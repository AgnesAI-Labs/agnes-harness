// DevBoard domain: three state machines, linkage, overdue derivation, fictional seed data and
// store persistence. No host imports, so tests run against a plain in-memory store.

export const MACHINES = Object.freeze({
  requirement: {
    RAW: ['REFINED'],
    REFINED: ['RAW', 'ASSIGNED'],
    ASSIGNED: ['REFINED', 'IN_PROGRESS'],
    IN_PROGRESS: ['BLOCKED', 'COMPLETED'],
    BLOCKED: ['IN_PROGRESS'],
    COMPLETED: [],
  },
  task: {
    PENDING: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED'],
    IN_PROGRESS: ['COMPLETED', 'FAILED', 'BLOCKED'],
    BLOCKED: ['IN_PROGRESS', 'CANCELLED'],
    FAILED: ['PENDING', 'CANCELLED'],
    COMPLETED: [],
    CANCELLED: [],
  },
  // EXPIRED is never stored: an OPEN request past dueAt reads as EXPIRED and can still be claimed.
  intervention: {
    OPEN: ['CLAIMED'],
    EXPIRED: ['CLAIMED'],
    CLAIMED: ['OPEN', 'RESOLVED'],
    RESOLVED: [],
  },
})

export const LABELS = Object.freeze({
  state: {
    RAW: '原始',
    REFINED: '已细化',
    ASSIGNED: '已分配',
    IN_PROGRESS: '进行中',
    BLOCKED: '阻塞',
    COMPLETED: '已完成',
    PENDING: '待开始',
    FAILED: '失败',
    CANCELLED: '已取消',
    OPEN: '待处理',
    EXPIRED: '已超时',
    CLAIMED: '已认领',
    RESOLVED: '已处理',
  },
  taskType: {
    REQUIREMENT_BREAKDOWN: '需求拆解',
    DEVELOPMENT: '研发',
    TESTING: '测试',
    SECURITY_CHECK: '安全校验',
    AUTO_RELEASE: '自动发布',
  },
  interventionType: {
    REQUIREMENT_APPROVAL: '需求审批',
    ARCHITECTURE_APPROVAL: '架构审批',
    SECURITY_APPROVAL: '安全审批',
    RELEASE_APPROVAL: '发布审批',
    INCIDENT_HANDLING: '故障处理',
  },
  priority: { P0: 'P0 紧急', P1: 'P1 重要', P2: 'P2 一般' },
})

const COLLECTIONS = { requirement: 'requirements', task: 'tasks', intervention: 'interventions' }
const PREFIX = { requirement: 'REQ', task: 'TASK', intervention: 'HI' }
const HOUR = 3_600_000
const HISTORY_LIMIT = 30

export class DomainError extends Error {}
const fail = (message) => {
  throw new DomainError(message)
}

export function effectiveState(item, kind, now) {
  return kind === 'intervention' && item.state === 'OPEN' && Date.parse(item.dueAt) < now
    ? 'EXPIRED'
    : item.state
}

function find(state, kind, id) {
  const list = state[COLLECTIONS[kind]]
  if (!list) fail(`未知实体类型：${kind}`)
  return list.find((item) => item.id === id) ?? fail(`未找到 ${id}`)
}

function record(item, at, by, from, to, note) {
  item.history = [...item.history, { at, by, from, to, ...(note ? { note } : {}) }].slice(-HISTORY_LIMIT)
  item.state = to
}

/** The only write path for states. Refuses any move absent from the kind's table. */
export function transition(state, { kind, id, to, by, note }, now = Date.now()) {
  const item = find(state, kind, id)
  const from = effectiveState(item, kind, now)
  if (!MACHINES[kind][from]?.includes(to)) fail(`非法状态流转：${from} 不可流转至 ${to}`)
  const at = new Date(now).toISOString()
  const actor = by || '未署名'
  if (kind === 'intervention') {
    if (to === 'CLAIMED') item.handler = actor
    if (to === 'OPEN') item.handler = null
    if (to === 'RESOLVED') item.resolution = note || '已处理'
  }
  record(item, at, actor, from, to, note)
  if (kind === 'task') link(state, item, at)
  return item
}

// Two automatic requirement moves only; everything else is an explicit transition.
function link(state, task, at) {
  const requirement = state.requirements.find((r) => r.id === task.requirementId)
  if (!requirement) return
  if (task.state === 'IN_PROGRESS' && requirement.state === 'ASSIGNED')
    record(requirement, at, '系统联动', 'ASSIGNED', 'IN_PROGRESS', `${task.id} 已开始`)
  const related = state.tasks.filter((t) => t.requirementId === requirement.id)
  if (
    requirement.state === 'IN_PROGRESS' &&
    related.every((t) => t.state === 'COMPLETED' || t.state === 'CANCELLED')
  )
    record(requirement, at, '系统联动', 'IN_PROGRESS', 'COMPLETED', '关联任务全部完成或取消')
}

const text = (value, name, max = 2000) => {
  if (typeof value !== 'string' || !value.trim()) fail(`缺少字段：${name}`)
  return value.trim().slice(0, max)
}
const oneOf = (value, allowed, name) =>
  allowed.includes(value) ? value : fail(`${name} 取值无效：${value}（可选 ${allowed.join(' / ')}）`)
function nextId(state, kind) {
  const n = state[COLLECTIONS[kind]].reduce((max, item) => Math.max(max, Number(item.id.split('-')[1])), 0)
  return `${PREFIX[kind]}-${String(n + 1).padStart(3, '0')}`
}

/** New requirements start RAW, tasks PENDING, interventions OPEN. */
export function create(state, input, now = Date.now()) {
  const at = new Date(now).toISOString()
  const by = input.by || '未署名'
  const base = (kind, initial) => ({
    id: nextId(state, kind),
    state: initial,
    createdAt: at,
    history: [{ at, by, from: null, to: initial, note: '创建' }],
  })
  if (input.kind === 'requirement') {
    const item = {
      ...base('requirement', 'RAW'),
      title: text(input.title, 'title', 200),
      description: typeof input.description === 'string' ? input.description.slice(0, 2000) : '',
      priority: oneOf(input.priority ?? 'P1', Object.keys(LABELS.priority), 'priority'),
      owner: input.owner || '产品经理智能体',
    }
    state.requirements.push(item)
    return item
  }
  if (input.kind === 'task') {
    const requirement = find(state, 'requirement', text(input.requirementId, 'requirementId', 64))
    const dependsOn = Array.isArray(input.dependsOn) ? input.dependsOn : []
    for (const dep of dependsOn) find(state, 'task', dep)
    const item = {
      ...base('task', 'PENDING'),
      requirementId: requirement.id,
      title: text(input.title, 'title', 200),
      type: oneOf(input.type, Object.keys(LABELS.taskType), 'type'),
      owner: input.owner || '研发协调员',
      dependsOn,
    }
    state.tasks.push(item)
    return item
  }
  if (input.kind === 'intervention') {
    const entity = input.entity ?? fail('缺少字段：entity')
    oneOf(entity.kind, ['requirement', 'task'], 'entity.kind')
    find(state, entity.kind, entity.id)
    const hours = Number(input.dueInHours ?? 24)
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) fail('dueInHours 需在 0–720 之间')
    const item = {
      ...base('intervention', 'OPEN'),
      type: oneOf(input.type, Object.keys(LABELS.interventionType), 'type'),
      entity: { kind: entity.kind, id: entity.id },
      ask: text(input.ask, 'ask'),
      dueAt: new Date(now + hours * HOUR).toISOString(),
      handler: null,
      resolution: null,
      requestedBy: by,
    }
    state.interventions.push(item)
    return item
  }
  return fail(`未知实体类型：${input.kind}`)
}

/** Read model: effective states, counts and interventions with overdue first, then newest first. */
export function snapshot(state, now = Date.now()) {
  const interventions = state.interventions
    .map((item) => ({ ...item, state: effectiveState(item, 'intervention', now) }))
    .sort(
      (a, b) =>
        Number(b.state === 'EXPIRED') - Number(a.state === 'EXPIRED') ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )
  const count = (list, kind) =>
    Object.fromEntries(Object.keys(MACHINES[kind]).map((s) => [s, list.filter((i) => i.state === s).length]))
  return {
    revision: state.revision,
    synthetic: true,
    requirements: state.requirements,
    tasks: state.tasks,
    interventions,
    counts: {
      requirement: count(state.requirements, 'requirement'),
      task: count(state.tasks, 'task'),
      intervention: count(interventions, 'intervention'),
    },
    machines: MACHINES,
    labels: LABELS,
  }
}

/** Fictional data for a fictional shop; every state and type appears, and HI-002 is always overdue. */
export function seed(now = Date.now()) {
  const ago = (hours) => new Date(now - hours * HOUR).toISOString()
  const path = (states, owner, startHours) =>
    states.map((to, i) => ({
      at: ago(startHours - i * 2),
      by: i === 0 ? '研发协调员' : owner,
      from: i === 0 ? null : states[i - 1],
      to,
      ...(i === 0 ? { note: '创建' } : {}),
    }))
  const req = (n, title, priority, owner, states, hours, description) => ({
    id: `REQ-00${n}`,
    title,
    description,
    priority,
    owner,
    state: states.at(-1),
    createdAt: ago(hours),
    history: path(states, owner, hours),
  })
  const RQ = ['RAW', 'REFINED', 'ASSIGNED', 'IN_PROGRESS']
  const requirements = [
    req(
      1,
      '用户登录支持短信验证码',
      'P1',
      '产品经理智能体',
      [...RQ, 'COMPLETED'],
      120,
      '登录页新增短信验证码方式，60 秒内限发一次。',
    ),
    req(
      2,
      '订单列表支持按状态筛选与导出',
      'P0',
      '产品经理智能体',
      RQ,
      72,
      '运营需要按状态筛选订单，并导出 Excel。',
    ),
    req(
      3,
      '支付回调接入新网关',
      'P0',
      '架构师智能体',
      [...RQ, 'BLOCKED'],
      60,
      '旧网关年底下线，回调需切换并保证幂等。',
    ),
    req(4, '商品详情页首屏性能优化', 'P1', '前端开发智能体', RQ.slice(0, 3), 36, '首屏渲染目标 1.5 秒以内。'),
    req(
      5,
      '退款流程增加人工复核节点',
      'P1',
      '产品经理智能体',
      RQ.slice(0, 2),
      20,
      '大额退款需人工复核后才能打款。',
    ),
    req(6, '运营后台批量导入优惠券', 'P2', '产品经理智能体', ['RAW'], 4, '支持上传 CSV 批量发放优惠券。'),
  ]
  const T = ['PENDING', 'IN_PROGRESS']
  const task = (n, requirementId, title, type, owner, states, hours, dependsOn = []) => ({
    id: `TASK-${String(n).padStart(3, '0')}`,
    requirementId,
    title,
    type,
    owner,
    state: states.at(-1),
    createdAt: ago(hours),
    dependsOn,
    history: path(states, owner, hours),
  })
  const tasks = [
    task(1, 'REQ-001', '短信验证码接口开发', 'DEVELOPMENT', '后端开发智能体', [...T, 'COMPLETED'], 110),
    task(2, 'REQ-001', '登录流程回归测试', 'TESTING', '测试智能体', [...T, 'COMPLETED'], 100, ['TASK-001']),
    task(3, 'REQ-001', '旧版图形验证码下线', 'DEVELOPMENT', '前端开发智能体', ['PENDING', 'CANCELLED'], 100),
    task(4, 'REQ-001', '登录功能灰度发布', 'AUTO_RELEASE', 'DevOps 智能体', [...T, 'COMPLETED'], 90, [
      'TASK-002',
    ]),
    task(
      5,
      'REQ-002',
      '订单筛选需求拆解',
      'REQUIREMENT_BREAKDOWN',
      '产品经理智能体',
      [...T, 'COMPLETED'],
      70,
    ),
    task(6, 'REQ-002', '订单筛选后端接口', 'DEVELOPMENT', '后端开发智能体', T, 60, ['TASK-005']),
    task(7, 'REQ-002', '订单筛选前端组件', 'DEVELOPMENT', '前端开发智能体', ['PENDING'], 60, ['TASK-006']),
    task(8, 'REQ-002', '订单导出功能测试', 'TESTING', '测试智能体', [...T, 'FAILED'], 50),
    task(9, 'REQ-002', '导出数据脱敏校验', 'SECURITY_CHECK', '安全审计智能体', ['PENDING'], 48),
    task(10, 'REQ-003', '回调签名校验开发', 'DEVELOPMENT', '后端开发智能体', [...T, 'BLOCKED'], 56),
    task(11, 'REQ-003', '支付链路安全评审', 'SECURITY_CHECK', '安全审计智能体', ['PENDING'], 56),
    task(12, 'REQ-003', '回调联调测试', 'TESTING', '测试智能体', ['PENDING'], 56, ['TASK-010']),
    task(13, 'REQ-004', '首屏渲染优化', 'DEVELOPMENT', '前端开发智能体', ['PENDING'], 30),
    task(14, 'REQ-004', '详情页性能压测', 'TESTING', '测试智能体', ['PENDING'], 30, ['TASK-013']),
    task(15, 'REQ-004', '详情页灰度发布', 'AUTO_RELEASE', 'DevOps 智能体', ['PENDING'], 30, ['TASK-014']),
  ]
  const hi = (n, type, entity, ask, states, hours, dueIn, extra = {}) => ({
    id: `HI-00${n}`,
    type,
    entity,
    ask,
    dueAt: new Date(now + dueIn * HOUR).toISOString(),
    handler: null,
    resolution: null,
    requestedBy: '研发协调员',
    state: states.at(-1),
    createdAt: ago(hours),
    history: path(states, extra.handler ?? '研发协调员', hours),
    ...extra,
  })
  const interventions = [
    hi(
      1,
      'REQUIREMENT_APPROVAL',
      { kind: 'requirement', id: 'REQ-005' },
      '退款人工复核阈值是否定为 500 元？请产品负责人确认。',
      ['OPEN'],
      6,
      18,
    ),
    hi(
      2,
      'ARCHITECTURE_APPROVAL',
      { kind: 'requirement', id: 'REQ-003' },
      '新网关回调采用同步验签还是消息队列异步处理？方案未定，开发已阻塞。',
      ['OPEN'],
      27,
      -3,
    ),
    hi(
      3,
      'SECURITY_APPROVAL',
      { kind: 'task', id: 'TASK-009' },
      '订单导出是否允许包含手机号明文？',
      ['OPEN', 'CLAIMED'],
      10,
      14,
      { handler: '质量安全' },
    ),
    hi(
      4,
      'RELEASE_APPROVAL',
      { kind: 'task', id: 'TASK-004' },
      '登录功能灰度 10% 指标正常，是否全量发布？',
      ['OPEN', 'CLAIMED', 'RESOLVED'],
      92,
      -60,
      { handler: '管理者', resolution: '同意全量发布。' },
    ),
    hi(
      5,
      'INCIDENT_HANDLING',
      { kind: 'task', id: 'TASK-008' },
      '导出 10 万行订单时接口超时，需要判断是限制导出量还是改为异步导出。',
      ['OPEN'],
      3,
      2,
    ),
    hi(
      6,
      'ARCHITECTURE_APPROVAL',
      { kind: 'requirement', id: 'REQ-004' },
      '详情页是否引入服务端渲染（SSR）？',
      ['OPEN', 'CLAIMED', 'RESOLVED'],
      34,
      -10,
      { handler: '管理者', resolution: '先做静态资源与图片懒加载，SSR 下个迭代评估。' },
    ),
  ]
  return { schema: 1, revision: 1, requirements, tasks, interventions }
}

// Store layout: one meta key plus one key per collection.
// ponytail: whole collections per key; an OwnedStore value caps near 128 KiB (~150 tasks with history),
// move to one key per entity if a demo ever needs more.
const KEYS = {
  meta: 'devboard/meta',
  ...Object.fromEntries(Object.values(COLLECTIONS).map((c) => [c, `devboard/${c}`])),
}

function load(store) {
  const meta = store.get(KEYS.meta)
  if (!meta) return undefined
  if (meta.schema !== 1) fail('未知的数据版本，请重置演示数据')
  const state = { schema: 1, revision: meta.revision }
  for (const c of Object.values(COLLECTIONS)) state[c] = store.get(KEYS[c]) ?? []
  return state
}
function save(store, state) {
  for (const c of Object.values(COLLECTIONS)) store.set(KEYS[c], JSON.parse(JSON.stringify(state[c])))
  store.set(KEYS.meta, { schema: 1, revision: state.revision })
}
const need = (store) => store ?? fail('档案存储不可用')

/**
 * Never writes: query services and effect preparation get a read-only store. An empty store reads
 * as the seed relative to now (so HI-002 is always overdue); the first write or reset persists it.
 */
export function read(store, now = Date.now()) {
  return need(store).transaction(() => load(store) ?? seed(now))
}

/** One transaction per write: load, mutate, bump revision, persist. */
export function update(store, work, now = Date.now()) {
  return need(store).transaction(() => {
    const state = load(store) ?? seed(now)
    const result = work(state)
    state.revision += 1
    save(store, state)
    return { revision: state.revision, result }
  })
}

export function reset(store, now = Date.now()) {
  return need(store).transaction(() => {
    const revision = (load(store)?.revision ?? 0) + 1
    save(store, { ...seed(now), revision })
    return { revision }
  })
}
