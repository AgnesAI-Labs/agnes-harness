import { Badge, Button, PushPage, Segmented, Select, Table, usePushStack } from '@agnes/web-ui'
import React from 'react'
import {
  byId,
  fact,
  gateName,
  gateOutcome,
  gateOutcomeBadge,
  guided,
  HistoryTable,
  h,
  NoteField,
  openWork,
  signedRoles,
  signProgress,
  stageName,
  stateBadge,
  TransitionBar,
  time,
  useDetail,
} from './board.js'
import { workOf } from './entries.js'
import { HandbackCards } from './handback.js'
import { waitingInterventions } from './lens.js'
import { GatePanel } from './lifecycle.js'
import { WorkButton } from './work.js'

const FLOW_TONE = { RUNNING: 'warn', APPROVED: 'ok', REJECTED: 'bad', WITHDRAWN: 'off' }
const NODE_TONE = { WAITING: 'off', ACTIVE: 'warn', DONE: 'ok', RETURNED: 'bad', SKIPPED: 'off' }
const flowBadge = (data, state) =>
  h(Badge, { tone: FLOW_TONE[state] ?? 'off' }, data.labels.approvalState[state] ?? state)
const nodeLabel = (data, flow, node) =>
  flow.state === 'REJECTED' && node.state === 'RETURNED' ? '已驳回' : data.labels.nodeState[node.state]

/** The current node of a running flow, or the last one reached. */
const currentNode = (flow) => flow.nodes[flow.current]
const subjectLabel = (data, flow) => `${data.labels.approvalSubject[flow.subject.type]} ${flow.subject.id}`

/** Who handled a node (latest approval per role), or who is awaited and to whom it was transferred. */
function handlers(flow, node) {
  // A send-back to this node or an earlier one voids what was handled here before it.
  const at = flow.nodes.indexOf(node)
  const reset = flow.actions.findLastIndex(
    (a) =>
      a.action === 'RETURN' && (a.to === 'INITIATOR' ? 0 : flow.nodes.findIndex((n) => n.id === a.to)) <= at,
  )
  const mine = flow.actions.slice(reset + 1).filter((a) => a.nodeId === node.id)
  const latest = {}
  for (const a of mine) if (a.action === 'APPROVE') latest[a.role] = a.by
  const transfer = mine.findLast((a) => a.action === 'TRANSFER')
  if (node.state === 'DONE') return node.roles.map((r) => latest[r]).filter(Boolean)
  if (node.state === 'ACTIVE')
    return [
      ...(node.mode === 'ALL' ? node.signed.map((r) => latest[r] ?? r) : []),
      ...(transfer ? [`转办给 ${transfer.to}`] : []),
    ]
  return []
}

/** The horizontal node graph: state, handler and used time per node; an overdue node is red. */
function NodeGraph({ data, flow }) {
  return h(
    'ol',
    { className: 'devboard-flow', 'aria-label': '审批节点' },
    flow.nodes.map((node, i) => {
      const who = handlers(flow, node)
      const awaited =
        flow.state === 'RUNNING' && node.state === 'ACTIVE'
          ? node.mode === 'ALL'
            ? node.roles.filter((r) => !node.signed.includes(r))
            : node.roles
          : []
      return h(
        'li',
        {
          key: node.id,
          className: [
            'devboard-node',
            `devboard-node-${node.state.toLowerCase()}`,
            node.overdue ? 'devboard-node-overdue' : '',
            i === flow.current && flow.state === 'RUNNING' ? 'devboard-node-current' : '',
          ]
            .filter(Boolean)
            .join(' '),
          'aria-current': i === flow.current && flow.state === 'RUNNING' ? 'step' : undefined,
        },
        h('strong', null, node.name),
        h(
          'span',
          { className: 'devboard-muted' },
          `${data.labels.nodeMode[node.mode]} · ${node.roles.join('、')}${node.addedBy ? ` · 由 ${node.addedBy} 加签` : ''}`,
        ),
        h(
          'span',
          null,
          h(
            Badge,
            { tone: node.overdue ? 'bad' : (NODE_TONE[node.state] ?? 'off') },
            nodeLabel(data, flow, node),
          ),
          node.overdue && h(Badge, { tone: 'bad' }, '已超时'),
        ),
        awaited.length > 0 && h('span', null, `待 ${awaited.join('、')}`),
        who.length > 0 && h('span', null, who.join('、')),
        node.elapsedHours !== undefined &&
          h(
            'span',
            { className: node.overdue ? 'devboard-overdue-text' : 'devboard-muted' },
            `用时 ${node.elapsedHours} h / 限 ${node.dueHours} h`,
          ),
        node.elapsedHours === undefined &&
          h('span', { className: 'devboard-muted' }, `限 ${node.dueHours} h`),
      )
    }),
  )
}

function Timeline({ data, flow }) {
  const nodeName = (id) => flow.nodes.find((n) => n.id === id)?.name ?? id
  return h(Table, {
    captionRepeatsHeading: true,
    caption: '留痕时间线',
    rowKey: (_r, i) => String(i),
    pagination: false,
    size: 'small',
    empty: '尚无处理记录',
    dataSource: flow.actions,
    columns: [
      { title: '时间', dataIndex: 'at', render: time, width: 140 },
      { title: '节点', dataIndex: 'nodeId', render: nodeName, width: 110 },
      { title: '处理人', dataIndex: 'by', width: 150 },
      { title: '动作', dataIndex: 'action', render: (a) => data.labels.approvalAction[a] ?? a, width: 70 },
      {
        title: '去向',
        dataIndex: 'to',
        render: (to, r) => (r.action === 'RETURN' && to !== 'INITIATOR' ? nodeName(to) : (to ?? '')),
        width: 110,
      },
      { title: '意见', dataIndex: 'comment' },
    ],
  })
}

/** Actions that count as someone having handled the first node (a withdraw is refused after one). */
const HANDLING = ['APPROVE', 'TRANSFER', 'ADD_SIGN', 'RETURN']

/** Agree, reject, send back, transfer, add a signer or comment; the server decides, the page only offers. */
function Actions({ data, flow, board, role, setRole }) {
  const [comment, setComment] = React.useState('')
  const [back, setBack] = React.useState('')
  const [to, setTo] = React.useState('')
  const [signer, setSigner] = React.useState('')
  const node = currentNode(flow)
  const mine = flow.waitingRoles.includes(role)
  // approvals.mjs lets every role of the node reject, return, transfer and add a signer, signed or not.
  const inNode = node.roles.includes(role)
  const canWithdraw =
    role === flow.initiator.role &&
    flow.current === 0 &&
    !flow.actions.slice(flow.since ?? 0).some((a) => HANDLING.includes(a.action))
  const act = async (action, extra = {}) => {
    const ok = await board.run(
      'devboard.approval',
      {
        action,
        id: flow.id,
        by: role,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ...extra,
      },
      `${flow.id} 已${data.labels.approvalAction[action]}`,
    )
    if (ok) {
      setComment('')
      setTo('')
      setBack('')
      setSigner('')
    }
  }
  if (flow.state !== 'RUNNING')
    return h(
      'section',
      { className: 'devboard-actions', 'aria-label': '审批处理' },
      h('p', null, `该流程${data.labels.approvalState[flow.state]}，不能再处理。`),
      h(
        'details',
        { className: 'devboard-evidence' },
        h('summary', null, '越权与重复操作校验'),
        h(
          'div',
          { className: 'devboard-buttons' },
          h(Button, { disabled: board.busy, onClick: () => act('APPROVE') }, '再次同意'),
        ),
      ),
    )
  const backTargets = flow.nodes.slice(0, flow.current).map((n) => ({ value: n.id, label: n.name }))
  return h(
    'section',
    { className: 'devboard-actions', 'aria-label': '审批处理' },
    mine
      ? h('span', { className: 'devboard-muted' }, `当前节点「${node.name}」待「${role}」处理。`)
      : h(
          'span',
          { className: 'devboard-buttons' },
          h(Badge, { tone: 'warn' }, `当前节点「${node.name}」需由 ${flow.waitingRoles.join('、')} 处理`),
          flow.waitingRoles.map((r) =>
            h(Button, { key: r, size: 'small', onClick: () => setRole(r) }, `切换为 ${r}`),
          ),
        ),
    h(NoteField, {
      id: `devboard-approval-${flow.id}`,
      label: '处理意见 / 评论（驳回、退回、评论必填）',
      value: comment,
      onChange: setComment,
    }),
    h(
      'div',
      { className: 'devboard-buttons' },
      mine
        ? h(
            Button,
            { key: 'ok', appearance: 'primary', disabled: board.busy, onClick: () => act('APPROVE') },
            `以「${role}」同意`,
          )
        : null,
      inNode && h(Button, { key: 'no', disabled: board.busy, onClick: () => act('REJECT') }, '驳回'),
      h(Button, { disabled: board.busy, onClick: () => act('COMMENT') }, '评论'),
      canWithdraw && h(Button, { disabled: board.busy, onClick: () => act('WITHDRAW') }, '撤回'),
    ),
    !mine &&
      h(
        'details',
        { className: 'devboard-evidence' },
        h('summary', null, '越权与重复操作校验'),
        h(
          'div',
          { className: 'devboard-buttons' },
          h(Button, { disabled: board.busy, onClick: () => act('APPROVE') }, `以「${role}」同意`),
        ),
      ),
    inNode &&
      h(
        'div',
        { className: 'devboard-buttons' },
        h(Select, {
          'aria-label': '退回到',
          value: back,
          onChange: setBack,
          options: [
            { value: '', label: flow.current > 0 ? '退回到上一节点' : '退回发起人' },
            ...backTargets,
            { value: 'INITIATOR', label: '退回发起人（整个流程重开）' },
          ],
          style: { minWidth: 220 },
        }),
        h(Button, { disabled: board.busy, onClick: () => act('RETURN', back ? { to: back } : {}) }, '退回'),
        h('input', {
          className: 'devboard-note devboard-inline',
          'aria-label': '转办给（同角色姓名）',
          placeholder: `转办给（${role}姓名）`,
          value: to,
          maxLength: 64,
          onChange: (e) => setTo(e.target.value),
        }),
        h(Button, { disabled: board.busy, onClick: () => act('TRANSFER', { to }) }, '转办'),
        h(Select, {
          'aria-label': '加签角色',
          value: signer,
          onChange: setSigner,
          options: [{ value: '', label: '加签角色…' }, ...data.roles.map((r) => ({ value: r, label: r }))],
          style: { minWidth: 180 },
        }),
        h(
          Button,
          { disabled: board.busy || !signer, onClick: () => act('ADD_SIGN', { role: signer }) },
          '加签',
        ),
      ),
  )
}

/** The approval detail: facts, node graph, actions and the full trace. */
export function ApprovalPanel({ data, flow, board, role, setRole }) {
  const node = currentNode(flow)
  return h(
    'div',
    { className: 'devboard-detail' },
    flow.overdue &&
      h(
        'p',
        { className: 'devboard-alert', role: 'alert' },
        `节点「${node.name}」已超时：用时 ${node.elapsedHours} h，限 ${node.dueHours} h。`,
      ),
    h(
      'dl',
      { className: 'devboard-facts' },
      fact('状态', flowBadge(data, flow.state)),
      fact('流程', data.labels.approvalTemplate[flow.template]),
      fact('对象', subjectLabel(data, flow)),
      fact('项目', flow.projectId),
      fact('发起人', `${flow.initiator.role}（${flow.initiator.by}）`),
      fact('发起时间', time(flow.startedAt)),
      fact('结束时间', time(flow.endedAt)),
    ),
    h(NodeGraph, { data, flow }),
    h(Actions, { key: flow.id, data, flow, board, role, setRole }),
    h(Timeline, { data, flow }),
  )
}

/**
 * The flows of one object plus the buttons that start one, for the detail page of a deliverable, change,
 * quality problem or trial. The server refuses what the object's state does not allow.
 */
export function ApprovalEntry({ data, board, role, setRole, type, id }) {
  const push = usePushStack()
  const [selected, setSelected] = React.useState('')
  const flows = data.approvals
    .filter((a) => a.subject.type === type && a.subject.id === id)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  const flow = byId(flows, selected)
  const start = async (template) => {
    const out = await board.run(
      'devboard.approval',
      { action: 'SUBMIT', template, subjectId: id, by: role },
      `已发起「${data.labels.approvalTemplate[template]}」`,
    )
    if (out?.result?.id) {
      setSelected(out.result.id)
      push.open('approval')
    }
  }
  return h(
    'section',
    { className: 'devboard-actions', 'aria-label': '审批流程' },
    h('h3', null, '审批流程'),
    flows.length === 0
      ? h('span', { className: 'devboard-muted' }, '该对象还没有审批流程。')
      : h(
          'ul',
          { className: 'devboard-list' },
          flows.map((f) =>
            h(
              'li',
              { key: f.id },
              h(
                Button,
                {
                  appearance: 'link',
                  onClick: () => {
                    setSelected(f.id)
                    push.open('approval')
                  },
                },
                f.id,
              ),
              ` ${data.labels.approvalTemplate[f.template]} `,
              flowBadge(data, f.state),
              f.state === 'RUNNING' &&
                ` 当前「${currentNode(f).name}」待 ${f.waitingRoles.join('、')}${f.overdue ? '（已超时）' : ''}`,
            ),
          ),
        ),
    h(
      'div',
      { className: 'devboard-buttons' },
      Object.entries(data.approvalTemplates)
        .filter(([, t]) => t.subject === type)
        .map(([template, t]) =>
          h(
            Button,
            { key: template, disabled: board.busy, onClick: () => start(template) },
            `发起审批：${t.name}`,
          ),
        ),
    ),
    flow &&
      h(
        PushPage,
        {
          id: 'approval',
          title: `${flow.id} ${data.labels.approvalTemplate[flow.template]}`,
          description: subjectLabel(data, flow),
        },
        h(ApprovalPanel, { key: flow.id, data, flow, board, role, setRole }),
      ),
  )
}

// ── 我的待办 ─────────────────────────────────────────────────────────────────────────────────────

const isEngineer = (role) => /工程师$/.test(role)
const newest = (a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0)

/** One to-do row: kind badge, a link to the detail, and one line of context. */
function TodoItem({ item, open }) {
  return h(
    'li',
    {
      key: item.id,
      className: item.overdue ? 'devboard-todo-item devboard-todo-overdue' : 'devboard-todo-item',
    },
    h(
      'span',
      null,
      h(Badge, { tone: item.overdue ? 'bad' : 'off' }, item.kind),
      ' ',
      h(Button, { appearance: 'link', onClick: () => open(item.id, item.page) }, item.id),
    ),
    h('span', null, item.title),
    h('span', { className: item.overdue ? 'devboard-overdue-text' : 'devboard-muted' }, item.meta),
  )
}

export function TodoColumn({ title, items, empty, open }) {
  return h(
    'section',
    { className: 'devboard-card', 'aria-label': title },
    h('h2', null, title, h('span', { className: 'devboard-count' }, items.length)),
    items.length
      ? h(
          'ul',
          { className: 'devboard-todo-list' },
          items.map((item) => h(TodoItem, { key: `${item.kind}-${item.id}`, item, open })),
        )
      : h('p', { className: 'devboard-muted' }, empty),
  )
}

export function MyTodo({ data, board, role, setRole }) {
  const [selected, open] = useDetail()
  const [view, setView] = React.useState('pending')
  const stage = (g) => byId(data.stages, g.stageId)
  const flowItem = (f, meta) => ({
    kind: '审批',
    page: 'approval',
    id: f.id,
    at: f.endedAt ?? f.startedAt,
    title: f.title,
    overdue: f.overdue,
    meta,
  })
  const gateItem = (g, meta) => ({
    kind: '评审门',
    page: 'gate',
    id: g.id,
    at: g.decidedAt ?? g.submittedAt,
    title: `${gateName(g)} · ${stage(g)?.projectId ?? ''}`,
    meta,
  })
  const waitingGates = data.gates.filter(
    (g) =>
      g.decision === 'PENDING' &&
      g.approverRoles.includes(role) &&
      !signedRoles(g).includes(role) &&
      stage(g)?.author !== role,
  )
  const waitingFlows = data.approvals
    .filter((f) => f.state === 'RUNNING' && f.waitingRoles.includes(role))
    .sort((a, b) => Number(b.overdue) - Number(a.overdue))
  const interventions = waitingInterventions(role, data)
  const pending = [
    ...waitingFlows.map((f) =>
      flowItem(f, `${currentNode(f).name}${f.overdue ? ' · 已超时' : ''} · ${f.projectId}`),
    ),
    ...waitingGates.map((g) => gateItem(g, `会签 ${signProgress(g)}`)),
    ...interventions.map((i) => ({
      kind: '人工介入',
      page: 'intervention',
      id: i.id,
      at: i.createdAt,
      title: i.ask,
      overdue: i.state === 'EXPIRED',
      meta: `${data.labels.interventionType[i.type]} · 截止 ${time(i.dueAt)}`,
    })),
  ]
  const initiated = data.approvals
    .filter((f) => f.initiator.role === role)
    .sort(
      (a, b) =>
        Number(b.state === 'RUNNING') - Number(a.state === 'RUNNING') ||
        Date.parse(b.startedAt) - Date.parse(a.startedAt),
    )
    .map((f) =>
      flowItem(
        f,
        f.state === 'RUNNING'
          ? `${currentNode(f).name}待 ${f.waitingRoles.join('、')}${f.overdue ? ' · 已超时' : ''}`
          : data.labels.approvalState[f.state],
      ),
    )
  const done = [
    ...data.approvals
      .filter((f) => f.actions.some((a) => a.role === role && a.action !== 'COMMENT'))
      .map((f) => flowItem(f, `${data.labels.approvalState[f.state]} · ${time(f.endedAt ?? f.startedAt)}`)),
    ...data.gates
      .filter(
        (g) =>
          g.decision !== 'PENDING' &&
          // A rejection leaves no signature: the rejecting role is the gate's approver.
          ((g.signatures ?? []).some((s) => s.role === role) ||
            (g.decision === 'REJECTED' && (g.approver === role || g.approver?.startsWith(`${role} `)))),
      )
      .map((g) => gateItem(g, `${gateOutcome(data, g)} · ${time(g.decidedAt)}`)),
  ].sort(newest)
  const gate = byId(data.gates, selected)
  const flow = byId(data.approvals, selected)
  const intervention = byId(data.interventions, selected)
  const hidden = isEngineer(role) ? ['CLAIMED'] : []
  const gates = data.gates
    .filter((g) => (view === 'pending' ? g.decision === 'PENDING' : g.decision !== 'PENDING'))
    .sort(
      (a, b) => Date.parse(b.decidedAt ?? b.submittedAt ?? 0) - Date.parse(a.decidedAt ?? a.submittedAt ?? 0),
    )
  return h(
    React.Fragment,
    null,
    h(HandbackCards, { data, board, role }),
    h(
      'div',
      { className: 'devboard-todo' },
      guided(
        'reviews-pending',
        h(TodoColumn, { title: '待我处理', items: pending, empty: `「${role}」当前没有待处理事项。`, open }),
      ),
      h(TodoColumn, { title: '我发起的', items: initiated, empty: `「${role}」没有发起过审批。`, open }),
      h(TodoColumn, { title: '已办', items: done, empty: `「${role}」还没有办理记录。`, open }),
    ),
    h('h2', { className: 'devboard-heading' }, '全部审批流程'),
    guided(
      'reviews-flows',
      h(Table, {
        captionRepeatsHeading: true,
        caption: '全部审批流程',
        rowKey: 'id',
        pagination: false,
        dataSource: [...data.approvals].sort(
          (a, b) =>
            Number(b.state === 'RUNNING') - Number(a.state === 'RUNNING') ||
            Date.parse(b.startedAt) - Date.parse(a.startedAt),
        ),
        empty: '暂无审批流程',
        rowClassName: (f) => (f.overdue ? 'devboard-overdue' : ''),
        columns: [
          {
            title: '编号',
            dataIndex: 'id',
            render: (id) => h(Button, { appearance: 'link', onClick: () => open(id, 'approval') }, id),
            width: 120,
          },
          {
            title: '流程',
            dataIndex: 'template',
            render: (t) => data.labels.approvalTemplate[t],
            width: 150,
          },
          { title: '对象', render: (_v, f) => subjectLabel(data, f), width: 180 },
          { title: '项目', dataIndex: 'projectId', width: 120 },
          {
            title: '当前节点',
            render: (_v, f) =>
              f.state === 'RUNNING'
                ? `${currentNode(f).name}（待 ${f.waitingRoles.join('、')}）${f.overdue ? ' · 已超时' : ''}`
                : '—',
          },
          { title: '发起人', render: (_v, f) => f.initiator.role, width: 120 },
          { title: '状态', dataIndex: 'state', render: (s) => flowBadge(data, s), width: 90 },
        ],
      }),
    ),
    h('h2', { className: 'devboard-heading' }, '评审门'),
    h(
      'div',
      { className: 'devboard-filters' },
      h(Segmented, {
        label: '评审门',
        value: view,
        onChange: setView,
        options: [
          {
            value: 'pending',
            label: `待决议（${data.gates.filter((g) => g.decision === 'PENDING').length}）`,
          },
          { value: 'decided', label: '已决议' },
        ],
      }),
      h(
        'span',
        { className: 'devboard-muted' },
        '只有门要求的审批角色能签署；会签门每个角色各签一次，最后一位签署时需关闭全部意见；编写角色不能审批。',
      ),
    ),
    guided(
      'reviews-gates',
      h(Table, {
        captionRepeatsHeading: true,
        caption: '评审门',
        rowKey: 'id',
        pagination: false,
        dataSource: gates,
        empty: view === 'pending' ? '没有待决议的评审门' : '暂无已决议的评审门',
        columns: [
          {
            title: '评审点',
            render: (_v, g) =>
              h(Button, { appearance: 'link', onClick: () => open(g.id, 'gate') }, gateName(g)),
            width: 220,
          },
          {
            title: '项目 / 阶段',
            render: (_v, g) =>
              `${stage(g)?.projectId} ${stageName(data, stage(g)?.projectId, stage(g)?.stage)}`,
            width: 240,
          },
          { title: '审批角色', render: (_v, g) => g.approverRoles.join('、'), width: 130 },
          { title: '会签', render: (_v, g) => signProgress(g), width: 160 },
          { title: '未关闭意见', render: (_v, g) => g.findings.filter((f) => !f.closed).length, width: 70 },
          { title: '决议', dataIndex: 'decision', render: (_d, g) => gateOutcomeBadge(data, g), width: 90 },
          ...(view === 'decided'
            ? [{ title: '时间', render: (_v, g) => time(g.decidedAt ?? g.submittedAt), width: 140 }]
            : []),
          {
            title: '',
            render: (_v, g) =>
              workOf('continueGate', g) &&
              byId(data.projects, stage(g)?.projectId)?.live &&
              h(
                Button,
                {
                  onClick: () =>
                    openWork(board, workOf('continueGate', g).action, workOf('continueGate', g).object),
                },
                workOf('continueGate', g).label,
              ),
            width: 120,
          },
        ],
      }),
    ),
    h('h2', { className: 'devboard-heading' }, '人工介入请求'),
    h(Table, {
      captionRepeatsHeading: true,
      caption: '人工介入请求',
      rowKey: 'id',
      pagination: false,
      dataSource: data.interventions,
      rowClassName: (r) => (r.state === 'EXPIRED' ? 'devboard-overdue' : ''),
      columns: [
        {
          title: '编号',
          dataIndex: 'id',
          render: (id) => h(Button, { appearance: 'link', onClick: () => open(id, 'intervention') }, id),
          width: 90,
        },
        { title: '类型', dataIndex: 'type', render: (t) => data.labels.interventionType[t], width: 90 },
        { title: '问题', dataIndex: 'ask' },
        { title: '项目', dataIndex: 'projectId', render: (id) => id ?? '—', width: 120 },
        { title: '截止', dataIndex: 'dueAt', render: time, width: 140 },
        { title: '处理人', dataIndex: 'handler', render: (v) => v ?? '—', width: 100 },
        { title: '状态', dataIndex: 'state', render: (s) => stateBadge(data, s), width: 90 },
      ],
    }),
    flow &&
      h(
        PushPage,
        {
          id: 'approval',
          title: `${flow.id} ${data.labels.approvalTemplate[flow.template]}`,
          description: subjectLabel(data, flow),
        },
        h(ApprovalPanel, { key: flow.id, data, flow, board, role, setRole }),
      ),
    gate &&
      h(
        PushPage,
        { id: 'gate', title: gateName(gate), description: gate.id },
        h(GatePanel, { key: gate.id, data, gate, board, role, setRole }),
      ),
    intervention &&
      h(
        PushPage,
        {
          id: 'intervention',
          title: `${intervention.id} ${data.labels.interventionType[intervention.type]}`,
          description: intervention.ask,
        },
        h(
          'div',
          { className: 'devboard-detail' },
          intervention.state === 'EXPIRED' &&
            h('p', { className: 'devboard-alert', role: 'alert' }, '该请求已超过截止时间。'),
          h(
            'dl',
            { className: 'devboard-facts' },
            fact('状态', stateBadge(data, intervention.state)),
            fact('关联', intervention.entity.id),
            fact('发起人', intervention.requestedBy),
            fact('截止时间', time(intervention.dueAt)),
            fact('处理人', intervention.handler),
            fact('处理结论', intervention.resolution),
          ),
          workOf('interventionContinue', intervention) &&
            h(
              WorkButton,
              {
                board,
                ...workOf('interventionContinue', intervention),
                appearance: 'primary',
                guide: 'intervention-agent-continue',
              },
              workOf('interventionContinue', intervention).label,
            ),
          hidden.length > 0 &&
            intervention.state !== 'CLAIMED' &&
            h(Badge, { tone: 'warn' }, '工程师角色不能认领介入请求，请切换演示角色。'),
          h(TransitionBar, {
            key: intervention.id,
            data,
            kind: 'intervention',
            item: intervention,
            board,
            role,
            hidden,
            noteLabel: '处理结论 / 备注',
          }),
          h(HistoryTable, { data, history: intervention.history }),
        ),
      ),
  )
}
