import { Badge, PushPage, Segmented, Select, Table } from '@agnes/web-ui'
import React from 'react'
import {
  byId,
  fact,
  guided,
  HistoryTable,
  h,
  idLink,
  Meter,
  options,
  ProjectSelect,
  stateBadge,
  TransitionBar,
  time,
  useDetail,
  useLens,
  useProject,
} from './board.js'
import { inProject, ProjectCell, stateLabels, TaskTable } from './records.js'

/** A customer clause with its technical-agreement answer. */
const isClause = (r) => r.level === 'CUS' && r.clause

// ── Requirements and traceability ──────────────────────────────────────────────────────────────

function TraceMatrix({ data, projectId, role, lens }) {
  const [picked, setPicked] = React.useState({ role, level: '' })
  const [discipline, setDiscipline] = React.useState('')
  const [selected, open] = useDetail()
  const project = byId(data.projects, projectId)
  const cov = project.metrics.coverage
  const reqs = data.reqs.filter((r) => r.projectId === projectId)
  const shown = lens.pick('req', reqs)
  // Until a level is picked the matrix opens on the first level that has records for the role.
  // Adjusting state while rendering: a role change drops the picked level, so coming back starts afresh.
  if (picked.role !== role) setPicked({ role, level: '' })
  const level =
    (picked.role === role && picked.level) ||
    ['SWR', 'CUS', 'SYS', 'DES', 'TC'].find((l) => shown.some((r) => r.level === l)) ||
    'SWR'
  const setLevel = (next) => setPicked({ role, level: next })
  const flagged = new Set([
    ...cov.swrTc.missing,
    ...cov.noSource,
    ...cov.noParent,
    ...cov.cusSys.missing,
    ...cov.sysSwr.missing,
  ])
  // Only SWR and DES items carry a discipline, so the filter is offered and applied on those levels only.
  const disciplined = level === 'SWR' || level === 'DES'
  const rows = shown.filter(
    (r) => r.level === level && (!disciplined || !discipline || r.discipline === discipline),
  )
  const item = reqs.find((r) => r.id === selected)
  const disc = (d) => data.labels.discipline[d] ?? '—'
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
    lens.empty,
    !lens.empty &&
      h(
        'div',
        { className: 'devboard-filters' },
        h(Segmented, {
          label: '层级',
          value: level,
          onChange: setLevel,
          options: ['CUS', 'SYS', 'SWR', 'DES', 'TC'].map((l) => ({
            value: l,
            label: `${l} ${data.labels.level[l]}（${shown.filter((r) => r.level === l).length}）`,
          })),
        }),
        disciplined &&
          h(Select, {
            'aria-label': '按专业过滤',
            value: discipline,
            onChange: setDiscipline,
            options: options(data.labels.discipline, '全部专业'),
            style: { minWidth: 130 },
          }),
      ),
    !lens.empty &&
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
          ...(level === 'SWR' || level === 'DES'
            ? [{ title: '专业', dataIndex: 'discipline', render: disc, width: 70 }]
            : []),
          ...(level === 'DES'
            ? [
                {
                  title: '物料号 / 图号 / 模块',
                  render: (_v, r) => [r.partNo, r.drawingNo, r.module].filter(Boolean).join(' / ') || '—',
                  width: 230,
                },
              ]
            : []),
          ...(level === 'CUS'
            ? [
                { title: '协议条款', dataIndex: 'clause', render: (v) => v ?? '—', width: 140 },
                {
                  title: '应答',
                  dataIndex: 'compliance',
                  render: (v) =>
                    v ? h(Badge, { tone: v === 'COMPLY' ? 'ok' : 'warn' }, data.labels.compliance[v]) : '—',
                  width: 80,
                },
              ]
            : []),
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
            item.discipline && fact('专业', disc(item.discipline)),
            item.partNo && fact('物料号', item.partNo),
            item.drawingNo && fact('图号', item.drawingNo),
            item.module && fact('软件模块', item.module),
            item.clause && fact('协议条款', item.clause),
            item.compliance && fact('应答', data.labels.compliance[item.compliance]),
            item.responseNote && fact('应答说明', item.responseNote),
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

/** 技术协议应答: the deviation table of the customer clauses with the SYS items that answer them. */
function TechResponse({ data, projectId, lens }) {
  const [compliance, setCompliance] = React.useState('')
  const reqs = data.reqs.filter((r) => r.projectId === projectId)
  const rows = lens
    .pick('req', reqs.filter(isClause))
    .filter((r) => !compliance || r.compliance === compliance)
  const count = (c) => reqs.filter((r) => r.level === 'CUS' && r.compliance === c).length
  return h(
    React.Fragment,
    null,
    lens.empty,
    !lens.empty &&
      h(
        'div',
        { className: 'devboard-filters' },
        h(Select, {
          'aria-label': '按应答过滤',
          value: compliance,
          onChange: setCompliance,
          options: options(data.labels.compliance, '全部应答'),
          style: { minWidth: 140 },
        }),
        h(
          'span',
          { className: 'devboard-muted' },
          `满足 ${count('COMPLY')} · 偏离 ${count('DEVIATE')} · 澄清 ${count('CLARIFY')}`,
        ),
      ),
    !lens.empty &&
      h(Table, {
        captionRepeatsHeading: true,
        caption: '技术协议应答（偏离表）',
        rowKey: 'id',
        pagination: false,
        size: 'small',
        dataSource: rows,
        empty: '该项目没有技术协议条款',
        rowClassName: (r) => (r.compliance === 'DEVIATE' ? 'devboard-overdue' : ''),
        columns: [
          { title: '条款', dataIndex: 'clause', width: 150 },
          { title: '客户条款', render: (_v, r) => `${r.id} ${r.title}`, width: 240 },
          {
            title: '应答',
            dataIndex: 'compliance',
            render: (v) => h(Badge, { tone: v === 'COMPLY' ? 'ok' : 'warn' }, data.labels.compliance[v] ?? v),
            width: 80,
          },
          { title: '说明', dataIndex: 'responseNote', render: (v) => v ?? '—' },
          {
            title: '对应 SYS',
            render: (_v, r) =>
              reqs
                .filter((c) => c.level === 'SYS' && c.parent?.includes(r.id))
                .map((c) => c.id)
                .join('、') || '—',
            width: 180,
          },
        ],
      }),
  )
}

function BoardRequirements({ data, board, role, projectId }) {
  const [selected, open] = useDetail()
  const [state, setState] = React.useState('')
  // A requirement created without a project would otherwise never show, nor move, under any project.
  const rows = data.requirements.filter(
    (r) => (!r.projectId || inProject(projectId)(r)) && (!state || r.state === state),
  )
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
  const reqs = data.reqs.filter((r) => r.projectId === projectId)
  // The development requirement items of the board view have no lens rule, so that view has no toggle.
  const lens = useLens(
    role,
    data,
    view === 'board' ? {} : { req: view === 'ta' ? reqs.filter(isClause) : reqs },
  )
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
          { value: 'ta', label: '技术协议应答' },
          { value: 'board', label: '研发需求条目' },
        ],
      }),
      view !== 'board' && lens.toggle,
    ),
    guided(
      'trace-view',
      view === 'matrix'
        ? h(TraceMatrix, { key: projectId, data, projectId, role, lens })
        : view === 'ta'
          ? h(TechResponse, { key: projectId, data, projectId, lens })
          : h(BoardRequirements, { data, board, role, projectId }),
    ),
  )
}
