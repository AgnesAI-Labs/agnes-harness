import { Badge, Button, Field, PushPage, Segmented, Select, Table, usePushStack } from '@agnes/web-ui'
import React from 'react'
import {
  byId,
  continueWork,
  fact,
  gateBadge,
  HistoryTable,
  h,
  idLink,
  Meter,
  NoteField,
  options,
  ProjectSelect,
  pct,
  stateBadge,
  TransitionBar,
  time,
  useProject,
} from './board.js'
import { GatePanel } from './lifecycle.js'

const stateLabels = (data, kind) =>
  Object.fromEntries(Object.keys(data.machines[kind]).map((s) => [s, data.labels.state[s]]))
const inProject = (projectId) => (x) => !projectId || x.projectId === projectId
const ProjectCell = (id) => id ?? '—'

function useDetail() {
  const push = usePushStack()
  const [selected, setSelected] = React.useState('')
  return [
    selected,
    (id, page = 'detail') => {
      setSelected(id)
      push.open(page)
    },
  ]
}

// ── Requirements and traceability ──────────────────────────────────────────────────────────────

function TraceMatrix({ data, projectId }) {
  const [level, setLevel] = React.useState('SWR')
  const [selected, open] = useDetail()
  const project = byId(data.projects, projectId)
  const cov = project.metrics.coverage
  const reqs = data.reqs.filter((r) => r.projectId === projectId)
  const flagged = new Set([
    ...cov.swrTc.missing,
    ...cov.noSource,
    ...cov.noParent,
    ...cov.cusSys.missing,
    ...cov.sysSwr.missing,
  ])
  const rows = reqs.filter((r) => r.level === level)
  const item = reqs.find((r) => r.id === selected)
  const children = (id) => reqs.filter((r) => r.parent?.includes(id))
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'devboard-coverage' },
      h(Meter, { label: 'CUS→SYS', value: cov.cusSys.pct }),
      h(Meter, { label: 'SYS→SWR', value: cov.sysSwr.pct }),
      h(Meter, { label: 'SWR→TC', value: cov.swrTc.pct }),
    ),
    (cov.swrTc.missing.length > 0 || cov.noSource.length > 0 || cov.noParent.length > 0) &&
      h(
        'p',
        { className: 'devboard-alert', role: 'note' },
        [
          cov.swrTc.missing.length && `未被用例覆盖的软件需求：${cov.swrTc.missing.join('、')}`,
          cov.noSource.length && `无来源用例：${cov.noSource.join('、')}`,
          cov.noParent.length && `无上游的条目：${cov.noParent.join('、')}`,
        ]
          .filter(Boolean)
          .join('；'),
      ),
    h(
      'div',
      { className: 'devboard-filters' },
      h(Segmented, {
        label: '层级',
        value: level,
        onChange: setLevel,
        options: ['CUS', 'SYS', 'SWR', 'DES', 'TC'].map((l) => ({
          value: l,
          label: `${l} ${data.labels.level[l]}（${reqs.filter((r) => r.level === l).length}）`,
        })),
      }),
    ),
    h(Table, {
      captionRepeatsHeading: true,
      caption: `${data.labels.level[level]}追溯`,
      rowKey: 'id',
      pagination: false,
      size: 'small',
      dataSource: rows,
      empty: '该层级暂无条目',
      rowClassName: (r) => (flagged.has(r.id) ? 'devboard-overdue' : ''),
      columns: [
        { title: '编号', dataIndex: 'id', render: idLink(open), width: 100 },
        { title: '标题', dataIndex: 'title' },
        { title: '上游', dataIndex: 'parent', render: (p) => (p?.length ? p.join('、') : '—'), width: 180 },
        {
          title: level === 'SWR' ? '验证用例' : '下游',
          render: (_v, r) =>
            (level === 'SWR'
              ? [
                  ...new Set([
                    ...(r.verifiedBy ?? []),
                    ...children(r.id)
                      .filter((c) => c.level === 'TC')
                      .map((c) => c.id),
                  ]),
                ]
              : children(r.id).map((c) => c.id)
            ).join('、') || '—',
          width: 220,
        },
        {
          title: '安全',
          dataIndex: 'safety',
          render: (v) => (v ? h(Badge, { tone: 'warn' }, '安全相关') : ''),
          width: 90,
        },
        { title: '状态', dataIndex: 'status', render: (v) => stateBadge(data, v), width: 90 },
      ],
    }),
    item &&
      h(
        PushPage,
        { id: 'detail', title: `${item.id} ${item.title}`, description: item.text },
        h(
          'div',
          { className: 'devboard-detail' },
          h(
            'dl',
            { className: 'devboard-facts' },
            fact('层级', data.labels.level[item.level]),
            fact('状态', stateBadge(data, item.status)),
            fact('上游', item.parent?.join('、') || '—'),
            fact(
              '下游',
              children(item.id)
                .map((c) => c.id)
                .join('、') || '—',
            ),
            item.level === 'SWR' && fact('验证用例', item.verifiedBy?.join('、') || '未覆盖'),
            fact('安全相关', item.safety ? '是（按 EN 50126 / EN 50716 假设）' : '否'),
          ),
        ),
      ),
  )
}

function BoardRequirements({ data, board, role, projectId }) {
  const [selected, open] = useDetail()
  const [state, setState] = React.useState('')
  const rows = data.requirements.filter((r) => inProject(projectId)(r) && (!state || r.state === state))
  const item = byId(data.requirements, selected)
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'devboard-filters' },
      h(Select, {
        'aria-label': '按状态过滤',
        value: state,
        onChange: setState,
        options: options(stateLabels(data, 'requirement'), '全部状态'),
        style: { minWidth: 160 },
      }),
    ),
    h(Table, {
      captionRepeatsHeading: true,
      caption: '研发需求条目',
      rowKey: 'id',
      pagination: false,
      dataSource: rows,
      empty: '该项目没有研发需求条目',
      columns: [
        { title: '编号', dataIndex: 'id', render: idLink(open), width: 110 },
        { title: '标题', dataIndex: 'title' },
        { title: '项目', dataIndex: 'projectId', render: ProjectCell, width: 130 },
        { title: '优先级', dataIndex: 'priority', width: 80 },
        { title: '负责人', dataIndex: 'owner', width: 130 },
        { title: '状态', dataIndex: 'state', render: (s) => stateBadge(data, s), width: 90 },
        {
          title: '任务',
          render: (_v, r) => data.tasks.filter((t) => t.requirementId === r.id).length,
          width: 60,
        },
      ],
    }),
    item &&
      h(
        PushPage,
        { id: 'detail', title: `${item.id} ${item.title}`, description: item.description },
        h(
          'div',
          { className: 'devboard-detail' },
          h(
            'dl',
            { className: 'devboard-facts' },
            fact('状态', stateBadge(data, item.state)),
            fact('优先级', data.labels.priority[item.priority]),
            fact('负责人', item.owner),
            fact('创建时间', time(item.createdAt)),
          ),
          h(TransitionBar, { key: item.id, data, kind: 'requirement', item, board, role }),
          h('h3', null, '关联任务'),
          h(TaskTable, { data, rows: data.tasks.filter((t) => t.requirementId === item.id) }),
          h(HistoryTable, { data, history: item.history }),
        ),
      ),
  )
}

export function Trace({ data, board, role }) {
  const [projectId, setProjectId] = useProject(data)
  const [view, setView] = React.useState('matrix')
  if (!byId(data.projects, projectId)) return h('p', null, '暂无项目')
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'devboard-filters' },
      h(ProjectSelect, { data, value: projectId, onChange: setProjectId }),
      h(Segmented, {
        label: '视图',
        value: view,
        onChange: setView,
        options: [
          { value: 'matrix', label: '追溯矩阵' },
          { value: 'board', label: '研发需求条目' },
        ],
      }),
    ),
    view === 'matrix'
      ? h(TraceMatrix, { key: projectId, data, projectId })
      : h(BoardRequirements, { data, board, role, projectId }),
  )
}

// ── Tasks (v1 board) ───────────────────────────────────────────────────────────────────────────

function TaskTable({ data, rows, open }) {
  return h(Table, {
    captionRepeatsHeading: true,
    caption: '任务列表',
    rowKey: 'id',
    pagination: false,
    dataSource: rows,
    empty: '暂无任务',
    columns: [
      { title: '编号', dataIndex: 'id', render: open ? idLink(open) : undefined, width: 110 },
      { title: '标题', dataIndex: 'title' },
      { title: '类型', dataIndex: 'type', render: (t) => data.labels.taskType[t], width: 90 },
      { title: '需求', dataIndex: 'requirementId', width: 90 },
      { title: '项目', dataIndex: 'projectId', render: ProjectCell, width: 130 },
      { title: '负责人', dataIndex: 'owner', width: 130 },
      { title: '状态', dataIndex: 'state', render: (s) => stateBadge(data, s), width: 90 },
    ],
  })
}

export function Tasks({ data, board, role }) {
  const [selected, open] = useDetail()
  const [projectId, setProjectId] = useProject(data, true)
  const [state, setState] = React.useState('')
  const [type, setType] = React.useState('')
  const [view, setView] = React.useState('list')
  const rows = data.tasks.filter(
    (t) => inProject(projectId)(t) && (!state || t.state === state) && (!type || t.type === type),
  )
  const item = byId(data.tasks, selected)
  const columns = Object.keys(data.machines.task).filter((s) => !state || s === state)
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'devboard-filters' },
      h(ProjectSelect, { data, value: projectId, onChange: setProjectId, allowAll: true }),
      h(Select, {
        'aria-label': '按状态过滤',
        value: state,
        onChange: setState,
        options: options(stateLabels(data, 'task'), '全部状态'),
        style: { minWidth: 140 },
      }),
      h(Select, {
        'aria-label': '按类型过滤',
        value: type,
        onChange: setType,
        options: options(data.labels.taskType, '全部类型'),
        style: { minWidth: 140 },
      }),
      h(Segmented, {
        label: '视图',
        value: view,
        onChange: setView,
        options: [
          { value: 'list', label: '列表' },
          { value: 'board', label: '看板' },
        ],
      }),
    ),
    view === 'list'
      ? h(TaskTable, { data, rows, open })
      : h(
          'div',
          { className: 'devboard-columns' },
          columns.map((s) =>
            h(
              'section',
              { className: 'devboard-column', key: s, 'aria-label': data.labels.state[s] },
              h('h3', null, stateBadge(data, s), ` ${rows.filter((t) => t.state === s).length}`),
              rows
                .filter((t) => t.state === s)
                .map((t) =>
                  h(
                    'button',
                    { type: 'button', className: 'devboard-tile', key: t.id, onClick: () => open(t.id) },
                    h('span', { className: 'devboard-muted' }, `${t.id} · ${data.labels.taskType[t.type]}`),
                    h('span', null, t.title),
                    h('span', { className: 'devboard-muted' }, t.owner),
                  ),
                ),
            ),
          ),
        ),
    item &&
      h(
        PushPage,
        { id: 'detail', title: `${item.id} ${item.title}` },
        h(
          'div',
          { className: 'devboard-detail' },
          h(
            'dl',
            { className: 'devboard-facts' },
            fact('状态', stateBadge(data, item.state)),
            fact('类型', data.labels.taskType[item.type]),
            fact(
              '所属需求',
              `${item.requirementId} ${byId(data.requirements, item.requirementId)?.title ?? ''}`,
            ),
            fact('项目', item.projectId),
            fact('负责人', item.owner),
            fact('依赖', item.dependsOn.length ? item.dependsOn.join('、') : '无'),
          ),
          h(TransitionBar, { key: item.id, data, kind: 'task', item, board, role }),
          h(HistoryTable, { data, history: item.history }),
        ),
      ),
  )
}

// ── Change requests ────────────────────────────────────────────────────────────────────────────

function NewChange({ data, board, role, projectId }) {
  const [title, setTitle] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [project, setProject] = React.useState(projectId || data.projects[0]?.id)
  const submit = async () => {
    const ok = await board.run(
      'devboard.create',
      { kind: 'change', by: role, projectId: project, title: title.trim(), reason: reason.trim() },
      '变更申请已提交',
    )
    if (ok) {
      setTitle('')
      setReason('')
    }
  }
  return h(
    'section',
    { className: 'devboard-actions', 'aria-label': '提交变更申请' },
    h(ProjectSelect, { data, value: project, onChange: setProject }),
    h(
      Field,
      { label: '变更标题', htmlFor: 'devboard-cr-title' },
      h('input', {
        id: 'devboard-cr-title',
        className: 'devboard-note',
        value: title,
        maxLength: 200,
        onChange: (e) => setTitle(e.target.value),
      }),
    ),
    h(NoteField, { id: 'devboard-cr-reason', label: '变更原因', value: reason, onChange: setReason }),
    h(
      'div',
      { className: 'devboard-buttons' },
      h(
        Button,
        { appearance: 'primary', disabled: board.busy || !title.trim() || !reason.trim(), onClick: submit },
        '提交变更申请',
      ),
      h('span', { className: 'devboard-muted' }, '影响分析由研发协调员补齐（「处理变更申请」快捷操作）。'),
    ),
  )
}

export function Changes({ data, board, role }) {
  const [selected, open] = useDetail()
  const [projectId, setProjectId] = useProject(data, true)
  const rows = data.changes.filter(inProject(projectId))
  const item = byId(data.changes, selected)
  const push = usePushStack()
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'devboard-filters' },
      h(ProjectSelect, { data, value: projectId, onChange: setProjectId, allowAll: true }),
      h(Button, { onClick: () => push.open('new') }, '提交变更申请'),
    ),
    h(Table, {
      captionRepeatsHeading: true,
      caption: '变更申请',
      rowKey: 'id',
      pagination: false,
      dataSource: rows,
      empty: '暂无变更申请',
      columns: [
        { title: '编号', dataIndex: 'id', render: idLink(open), width: 120 },
        { title: '标题', dataIndex: 'title' },
        { title: '项目', dataIndex: 'projectId', width: 120 },
        { title: '提出人', dataIndex: 'raisedBy', width: 140 },
        {
          title: '安全影响',
          render: (_v, r) => (r.impact?.safety ? h(Badge, { tone: 'warn' }, '涉及') : '否'),
          width: 90,
        },
        { title: '工作量', render: (_v, r) => `${r.impact?.effortDays ?? 0} 人日`, width: 80 },
        { title: '状态', dataIndex: 'state', render: (s) => stateBadge(data, s), width: 100 },
      ],
    }),
    h(
      PushPage,
      { id: 'new', title: '提交变更申请' },
      h('div', { className: 'devboard-detail' }, h(NewChange, { data, board, role, projectId })),
    ),
    item &&
      h(
        PushPage,
        { id: 'detail', title: `${item.id} ${item.title}`, description: item.reason },
        h(
          'div',
          { className: 'devboard-detail' },
          h(
            'dl',
            { className: 'devboard-facts' },
            fact('状态', stateBadge(data, item.state)),
            fact('项目', item.projectId),
            fact('提出人', item.raisedBy),
            fact('受影响需求', item.impact?.reqs?.join('、') || '—'),
            fact('受影响交付物', item.impact?.artifacts?.join('、') || '—'),
            fact('受影响用例', item.impact?.tests?.join('、') || '—'),
            fact('安全影响', item.impact?.safety ? '涉及安全功能' : '否'),
            fact('工作量', `${item.impact?.effortDays ?? 0} 人日`),
            fact(
              'CCB 决议',
              item.ccb
                ? `${data.labels.state[item.ccb.decision]}（${time(item.ccb.at)}）${item.ccb.note ? `：${item.ccb.note}` : ''}`
                : '—',
            ),
            fact('CCB 成员', item.ccb?.members?.join('、')),
            item.reworked?.length > 0 && fact('触发返工', item.reworked.join('、')),
          ),
          h(
            'p',
            { className: 'devboard-muted' },
            '进入 CCB 评审前必须完成影响分析；CCB 批准后受影响需求标记为已变更，已通过的受影响阶段自动返工。',
          ),
          h(TransitionBar, { key: item.id, data, kind: 'change', item, board, role }),
          h(HistoryTable, { data, history: item.history }),
        ),
      ),
  )
}

// ── Defects and tests ──────────────────────────────────────────────────────────────────────────

function Trend({ project }) {
  const rows = project.metrics.defectTrend
  const max = Math.max(1, ...rows.flatMap((r) => [r.opened, r.closed]))
  return h(
    'section',
    { className: 'devboard-card', 'aria-label': `${project.id} 缺陷趋势` },
    h('h2', null, `${project.id} 近 8 周缺陷新增 / 关闭`),
    h(
      'ul',
      { className: 'devboard-trend' },
      rows.map((r) =>
        h(
          'li',
          { key: r.weekEnding },
          h(
            'span',
            { className: 'devboard-muted' },
            new Date(r.weekEnding).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }),
          ),
          h('span', {
            className: 'devboard-bar devboard-tone-bad',
            style: { width: `${(r.opened / max) * 45}%` },
            title: `新增 ${r.opened}`,
          }),
          h('span', {
            className: 'devboard-bar devboard-tone-ok',
            style: { width: `${(r.closed / max) * 45}%` },
            title: `关闭 ${r.closed}`,
          }),
          h('span', null, `+${r.opened} / −${r.closed}`),
        ),
      ),
    ),
  )
}

export function Quality({ data, board, role }) {
  const [selected, open] = useDetail()
  const [projectId, setProjectId] = useProject(data, true)
  const [severity, setSeverity] = React.useState('')
  const [state, setState] = React.useState('')
  const defects = data.defects.filter(
    (d) => inProject(projectId)(d) && (!severity || d.severity === severity) && (!state || d.state === state),
  )
  const runs = data.testRuns.filter(inProject(projectId)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const item = byId(data.defects, selected)
  const projects = data.projects
    .filter(inProject(projectId))
    .filter((p) => data.defects.some((d) => d.projectId === p.id))
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'devboard-filters' },
      h(ProjectSelect, { data, value: projectId, onChange: setProjectId, allowAll: true }),
      h(Select, {
        'aria-label': '按严重度过滤',
        value: severity,
        onChange: setSeverity,
        options: options(data.labels.severity, '全部严重度'),
        style: { minWidth: 130 },
      }),
      h(Select, {
        'aria-label': '按状态过滤',
        value: state,
        onChange: setState,
        options: options(stateLabels(data, 'defect'), '全部状态'),
        style: { minWidth: 130 },
      }),
    ),
    h(
      'div',
      { className: 'devboard-cards' },
      projects.map((p) => h(Trend, { key: p.id, project: p })),
    ),
    h(Table, {
      captionRepeatsHeading: true,
      caption: '缺陷',
      rowKey: 'id',
      pagination: false,
      dataSource: defects,
      empty: '没有符合条件的缺陷',
      rowClassName: (d) => (d.severity === 'A' && d.state !== 'CLOSED' ? 'devboard-overdue' : ''),
      columns: [
        { title: '编号', dataIndex: 'id', render: idLink(open), width: 100 },
        { title: '标题', dataIndex: 'title' },
        { title: '项目', dataIndex: 'projectId', width: 120 },
        { title: '严重度', dataIndex: 'severity', render: (s) => data.labels.severity[s], width: 80 },
        { title: '发现阶段', dataIndex: 'foundIn', render: (s) => data.labels.stage[s], width: 90 },
        {
          title: '用例 / 需求',
          render: (_v, d) => [d.testCase, d.req].filter(Boolean).join(' / ') || '—',
          width: 140,
        },
        { title: '负责人', dataIndex: 'owner', width: 140 },
        { title: '状态', dataIndex: 'state', render: (s) => stateBadge(data, s), width: 90 },
      ],
    }),
    h(Table, {
      captionRepeatsHeading: true,
      caption: '测试运行记录',
      rowKey: 'id',
      pagination: false,
      size: 'small',
      dataSource: runs,
      empty: '暂无测试运行',
      columns: [
        { title: '编号', dataIndex: 'id', width: 100 },
        { title: '项目', dataIndex: 'projectId', width: 120 },
        { title: '级别', dataIndex: 'level', render: (l) => data.labels.testLevel[l], width: 70 },
        { title: '时间', dataIndex: 'at', render: time, width: 140 },
        {
          title: '通过率',
          render: (_v, r) =>
            h(Meter, {
              label: `${r.passed}/${r.total}`,
              value: r.total ? Math.round((r.passed / r.total) * 1000) / 10 : null,
            }),
          width: 260,
        },
        { title: '失败 / 跳过', render: (_v, r) => `${r.failed} / ${r.skipped}`, width: 90 },
        {
          title: '覆盖率',
          render: (_v, r) =>
            r.coverage ? `语句 ${pct(r.coverage.statement)} · 分支 ${pct(r.coverage.branch)}` : '—',
          width: 170,
        },
        {
          title: '来源',
          dataIndex: 'source',
          render: (s) => (s === 'live' ? h(Badge, { tone: 'ok' }, '现场运行') : '历史'),
          width: 90,
        },
        { title: '说明', dataIndex: 'log', render: (v) => v ?? '' },
      ],
    }),
    item &&
      h(
        PushPage,
        { id: 'detail', title: `${item.id} ${item.title}` },
        h(
          'div',
          { className: 'devboard-detail' },
          h(
            'dl',
            { className: 'devboard-facts' },
            fact('状态', stateBadge(data, item.state)),
            fact('严重度', data.labels.severity[item.severity]),
            fact('发现阶段', data.labels.stage[item.foundIn]),
            fact('测试用例', item.testCase),
            fact('关联需求', item.req),
            fact('负责人', item.owner),
            fact('登记时间', time(item.createdAt)),
            fact('关闭时间', time(item.closedAt)),
          ),
          h(TransitionBar, { key: item.id, data, kind: 'defect', item, board, role }),
          h(HistoryTable, { data, history: item.history }),
        ),
      ),
  )
}

// ── Reviews: gates and human interventions ─────────────────────────────────────────────────────

export function Reviews({ data, board, role }) {
  const [selected, open] = useDetail()
  const [view, setView] = React.useState('pending')
  const stage = (g) => byId(data.stages, g.stageId)
  const gates = data.gates
    .filter((g) => (view === 'pending' ? g.decision === 'PENDING' : g.decision !== 'PENDING'))
    .sort(
      (a, b) => Date.parse(b.decidedAt ?? b.submittedAt ?? 0) - Date.parse(a.decidedAt ?? a.submittedAt ?? 0),
    )
  const gate = byId(data.gates, selected)
  const intervention = byId(data.interventions, selected)
  const hidden = /工程师$/.test(role) ? ['CLAIMED'] : []
  return h(
    React.Fragment,
    null,
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
        '批准需关闭全部意见，审批角色不能是编写角色，阶段须在评审中。',
      ),
    ),
    h(Table, {
      captionRepeatsHeading: true,
      caption: '评审门',
      rowKey: 'id',
      pagination: false,
      dataSource: gates,
      empty: view === 'pending' ? '没有待决议的评审门' : '暂无已决议的评审门',
      columns: [
        {
          title: '编号',
          dataIndex: 'id',
          render: (id) => h(Button, { appearance: 'link', onClick: () => open(id, 'gate') }, id),
          width: 280,
        },
        { title: '阶段', render: (_v, g) => data.labels.stage[stage(g)?.stage], width: 90 },
        { title: '编写角色', render: (_v, g) => stage(g)?.author, width: 120 },
        { title: '审批角色', dataIndex: 'approverRole', width: 100 },
        { title: '未关闭意见', render: (_v, g) => g.findings.filter((f) => !f.closed).length, width: 90 },
        { title: '决议', dataIndex: 'decision', render: (d) => gateBadge(data, d), width: 90 },
        { title: '时间', render: (_v, g) => time(g.decidedAt ?? g.submittedAt), width: 140 },
        {
          title: '',
          render: (_v, g) =>
            g.decision !== 'PENDING' &&
            byId(data.projects, stage(g)?.projectId)?.live &&
            h(Button, { onClick: () => continueWork(board, { type: 'gate', id: g.id }) }, '继续推进'),
          width: 110,
        },
      ],
    }),
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
        { title: '项目', dataIndex: 'projectId', render: ProjectCell, width: 120 },
        { title: '截止', dataIndex: 'dueAt', render: time, width: 140 },
        { title: '处理人', dataIndex: 'handler', render: (v) => v ?? '—', width: 100 },
        { title: '状态', dataIndex: 'state', render: (s) => stateBadge(data, s), width: 90 },
      ],
    }),
    gate &&
      h(PushPage, { id: 'gate', title: gate.id }, h(GatePanel, { key: gate.id, data, gate, board, role })),
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
