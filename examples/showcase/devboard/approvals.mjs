// DevBoard 3.1 approval engine: the rules of one flow (agree, reject, send back, transfer, add signer,
// comment, withdraw) and the derived timeout. Pure functions over a flow object, no store and no clock:
// the caller passes `now`. Linking a flow to the state of its subject lives in domain.mjs.
import { TEMPLATES } from './approval-templates.mjs'
import { ROLES } from './profiles.mjs'

export class DomainError extends Error {}
const fail = (message) => {
  throw new DomainError(message)
}

/** Names and role specialities share the canonical role; RAMS keeps its inner space. */
export const roleOf = (by) => {
  const text = String(by ?? '').trim()
  return (
    ROLES.find((r) => text === r || [' ', '（', '('].some((suffix) => text.startsWith(r + suffix))) ??
    text.split(/\s+/)[0]
  )
}

const HOUR = 3_600_000
export const ACTIONS = ['APPROVE', 'REJECT', 'RETURN', 'TRANSFER', 'ADD_SIGN', 'COMMENT', 'WITHDRAW']
export const FLOW_LABELS = Object.freeze({
  RUNNING: '审批中',
  APPROVED: '已批准',
  REJECTED: '已驳回',
  WITHDRAWN: '已撤回',
})
// A handled action is one that moves the flow; comments never count.
const HANDLING = ['APPROVE', 'TRANSFER', 'ADD_SIGN', 'RETURN']

const text = (value, name, max = 2000) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fail(`缺少字段：${name}`)
const optional = (value, max = 2000) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** A new RUNNING flow whose first node is ACTIVE; node roles are resolved against the initiator. */
export function newFlow({ id, projectId, template, subject, title, initiator, now }) {
  const def = TEMPLATES[template] ?? fail(`未知审批模板：${template}`)
  const at = new Date(now).toISOString()
  return {
    id,
    projectId,
    subject,
    template,
    title,
    initiator,
    state: 'RUNNING',
    current: 0,
    nodes: def.nodes.map(({ id: nodeId, name, mode, roles, dueHours, excludeInitiator }, i) => ({
      id: nodeId,
      name,
      mode,
      roles: excludeInitiator ? roles.filter((r) => r !== initiator.role) : [...roles],
      dueHours,
      state: i === 0 ? 'ACTIVE' : 'WAITING',
      // Roles that have agreed in the current round of an ALL node (a send-back clears them).
      signed: [],
      ...(i === 0 ? { enteredAt: at } : {}),
    })),
    actions: [],
    // Index into `actions` where the first node was last opened: a withdraw needs nobody to have acted since.
    since: 0,
    startedAt: at,
  }
}

/** Derived, never stored: an ACTIVE node of a running flow older than its time limit. */
export const isOverdue = (flow, node, now) =>
  flow.state === 'RUNNING' &&
  node.state === 'ACTIVE' &&
  now - Date.parse(node.enteredAt) > node.dueHours * HOUR

/** The roles still to act at the current node. */
export const waitingRoles = (flow) => {
  const node = flow.nodes[flow.current]
  if (flow.state !== 'RUNNING' || node?.state !== 'ACTIVE') return []
  return node.mode === 'ALL' ? node.roles.filter((r) => !node.signed.includes(r)) : [...node.roles]
}

/** The flow as the board reads it: overdue flags and elapsed hours per node, and who is awaited. */
export function view(flow, now) {
  const nodes = flow.nodes.map((n) => {
    const end = n.doneAt ? Date.parse(n.doneAt) : now
    return {
      ...n,
      ...(n.enteredAt && (n.state === 'ACTIVE' || n.doneAt)
        ? { elapsedHours: Math.max(0, Math.round(((end - Date.parse(n.enteredAt)) / HOUR) * 10) / 10) }
        : {}),
      overdue: isOverdue(flow, n, now),
    }
  })
  return {
    ...flow,
    nodes,
    overdue: nodes.some((n) => n.overdue),
    waitingRoles: waitingRoles(flow),
  }
}

const finish = (flow, state, at) => {
  flow.state = state
  flow.endedAt = at
}

/** Reset node `from` and every node after it to WAITING, then open `from` again. */
function reopen(flow, from, at) {
  flow.nodes.forEach((n, i) => {
    if (i < from) return
    n.state = 'WAITING'
    n.signed = []
    delete n.enteredAt
    delete n.doneAt
  })
  Object.assign(flow.nodes[from], { state: 'ACTIVE', enteredAt: at })
  flow.current = from
}

/**
 * Apply one action to a RUNNING flow. Returns the flow's end state ('APPROVED', 'REJECTED' or
 * 'WITHDRAWN') when this action ended it, otherwise null. Only the current node's roles may handle it;
 * a comment is open to anyone and only leaves a trace.
 */
export function act(flow, input, now) {
  const action = ACTIONS.includes(input.action)
    ? input.action
    : fail(`action 取值无效：${input.action}（可选 ${ACTIONS.join(' / ')}）`)
  const by = text(input.by, 'by', 64)
  const role = roleOf(by)
  const at = new Date(now).toISOString()
  if (flow.state !== 'RUNNING')
    fail(
      `审批不满足：${flow.id} ${FLOW_LABELS[flow.state]}，不能再${action === 'WITHDRAW' ? '撤回' : '处理'}`,
    )
  const node = flow.nodes[flow.current]
  const comment = optional(input.comment)
  const log = (extra = {}) => flow.actions.push({ nodeId: node.id, role, by, action, ...extra, comment, at })

  if (action === 'COMMENT') {
    text(comment, 'comment')
    log()
    return null
  }
  if (action === 'WITHDRAW') {
    if (role !== flow.initiator.role && by !== flow.initiator.by)
      fail(`审批不满足：只有发起人（${flow.initiator.role}）可以撤回`)
    if (flow.current !== 0 || flow.actions.slice(flow.since).some((a) => HANDLING.includes(a.action)))
      fail('审批不满足：第一个节点已有人处理，不能撤回')
    log()
    for (const n of flow.nodes) if (n.state !== 'DONE') n.state = 'SKIPPED'
    finish(flow, 'WITHDRAWN', at)
    return 'WITHDRAWN'
  }

  if (!node.roles.includes(role))
    fail(`审批不满足：当前节点「${node.name}」需由 ${node.roles.join('、')} 处理（当前角色「${role}」）`)

  if (action === 'APPROVE') {
    if (node.mode === 'ALL') {
      if (node.signed.includes(role)) fail(`审批不满足：角色「${role}」已在「${node.name}」同意过`)
      node.signed.push(role)
    }
    log()
    if (node.mode === 'ALL' && node.roles.some((r) => !node.signed.includes(r))) return null
    Object.assign(node, { state: 'DONE', doneAt: at })
    const next = flow.nodes[flow.current + 1]
    if (!next) {
      finish(flow, 'APPROVED', at)
      return 'APPROVED'
    }
    flow.current += 1
    Object.assign(next, { state: 'ACTIVE', enteredAt: at })
    return null
  }

  if (action === 'REJECT') {
    text(comment, 'comment（驳回需填写意见）')
    log()
    Object.assign(node, { state: 'RETURNED', doneAt: at })
    for (const n of flow.nodes.slice(flow.current + 1)) n.state = 'SKIPPED'
    finish(flow, 'REJECTED', at)
    return 'REJECTED'
  }

  if (action === 'RETURN') {
    text(comment, 'comment（退回需填写意见）')
    // Default: the previous node, or the initiator when this is the first one.
    const to = input.to || (flow.current > 0 ? flow.nodes[flow.current - 1].id : 'INITIATOR')
    const index = to === 'INITIATOR' ? 0 : flow.nodes.findIndex((n) => n.id === to)
    if (index < 0 || (to !== 'INITIATOR' && index >= flow.current))
      fail(`退回目标无效：${to}（只能退回当前节点之前的节点，或 INITIATOR）`)
    log({ to })
    reopen(flow, index, at)
    if (index === 0) flow.since = flow.actions.length
    return null
  }

  if (action === 'TRANSFER') {
    const name = text(input.to, 'to（转办对象姓名）', 64)
    const target = ROLES.some((r) => name === r || name.startsWith(`${r} `)) ? name : `${role} ${name}`
    if (roleOf(target) !== role) fail(`转办只能交给同角色「${role}」的另一人，收到「${name}」`)
    if (target === by) fail('不能转办给自己')
    log({ to: target })
    return null
  }

  // ADD_SIGN: a SERIAL node for the chosen role right after the current one.
  const added = ROLES.includes(input.role) ? input.role : fail(`加签角色无效：${input.role ?? '（空）'}`)
  let n = flow.nodes.filter((x) => x.addedBy).length + 1
  while (flow.nodes.some((x) => x.id === `add${n}`)) n += 1
  flow.nodes.splice(flow.current + 1, 0, {
    id: `add${n}`,
    name: `加签：${added}`,
    mode: 'SERIAL',
    roles: [added],
    dueHours: 24,
    state: 'WAITING',
    signed: [],
    addedBy: by,
  })
  log({ to: added })
  return null
}
