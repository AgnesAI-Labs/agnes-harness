import { Badge, Button, Field, PushPage, Segmented, Select, Table, usePushStack } from '@agnes/web-ui'
import React from 'react'
import { ApprovalEntry } from './approvals.js'
import {
  byId,
  fact,
  guided,
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
  useDetail,
  useLens,
  useProject,
} from './board.js'
import { workOf } from './entries.js'
import { ImpactTree } from './impact-tree.js'
import { WorkButton } from './work.js'

export const stateLabels = (data, kind) =>
  Object.fromEntries(Object.keys(data.machines[kind]).map((s) => [s, data.labels.state[s]]))
export const inProject = (projectId) => (x) => !projectId || x.projectId === projectId
export const ProjectCell = (id) => id ?? '—'

// ── Tasks (v1 board) ───────────────────────────────────────────────────────────────────────────

export function TaskTable({ data, rows, open }) {
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
  const scoped = data.tasks.filter(inProject(projectId))
  const lens = useLens(role, data, { task: scoped })
  const rows = lens
    .pick('task', scoped)
    .filter((t) => (!state || t.state === state) && (!type || t.type === type))
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
      lens.toggle,
    ),
    guided(
      'tasks-view',
      lens.empty ??
        (view === 'list'
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
                        h(
                          'span',
                          { className: 'devboard-muted' },
                          `${t.id} · ${data.labels.taskType[t.type]}`,
                        ),
                        h('span', null, t.title),
                        h('span', { className: 'devboard-muted' }, t.owner),
                      ),
                    ),
                ),
              ),
            )),
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

/** Advance the retrofit count of an approved change; progress only goes up, the last door closes the gap. */
function RetrofitBar({ change, board, role }) {
  const rf = change.retrofit
  const [done, setDone] = React.useState('')
  const locked = !['APPROVED', 'IMPLEMENTED'].includes(change.state)
  const submit = async () => {
    const ok = await board.run(
      'devboard.transition',
      { kind: 'retrofit', id: change.id, done: Number(done), by: role },
      `${change.id} 整改进度已更新`,
    )
    if (ok) setDone('')
  }
  return h(
    'section',
    { className: 'devboard-actions', 'aria-label': '整改进度' },
    h(Meter, {
      label: `整改 ${rf.done}/${rf.total}`,
      value: rf.total ? Math.round((rf.done / rf.total) * 1000) / 10 : 0,
    }),
    h(
      'div',
      { className: 'devboard-buttons' },
      h('input', {
        className: 'devboard-note',
        style: { width: 160 },
        type: 'number',
        min: rf.done + 1,
        max: rf.total,
        'aria-label': '整改完成数',
        placeholder: `大于 ${rf.done}，至多 ${rf.total}`,
        value: done,
        onChange: (e) => setDone(e.target.value),
      }),
      h(Button, { disabled: board.busy || locked || done === '', onClick: submit }, '更新整改进度'),
      h(Button, { disabled: board.busy || locked, onClick: () => setDone(String(rf.total)) }, '填入全部'),
      locked && h('span', { className: 'devboard-muted' }, '批准后才能更新整改进度。'),
    ),
  )
}

export function Changes({ data, board, role, setRole }) {
  const [selected, open] = useDetail()
  const [projectId, setProjectId] = useProject(data, true)
  const scoped = data.changes.filter(inProject(projectId))
  const lens = useLens(role, data, { change: scoped })
  const rows = lens.pick('change', scoped)
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
      lens.toggle,
    ),
    guided(
      'changes-list',
      lens.empty ??
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
            {
              title: '来源',
              render: (_v, r) => data.labels.changeSource[r.source?.type] ?? '—',
              width: 80,
            },
            { title: 'ECN', dataIndex: 'ecn', render: (v) => v ?? '—', width: 120 },
            {
              title: '整改',
              render: (_v, r) => (r.retrofit ? `${r.retrofit.done}/${r.retrofit.total}` : '—'),
              width: 90,
            },
            {
              title: '安全影响',
              render: (_v, r) => (r.impact?.safety ? h(Badge, { tone: 'warn' }, '涉及') : '否'),
              width: 90,
            },
            { title: '工作量', render: (_v, r) => `${r.impact?.effortDays ?? 0} 人日`, width: 80 },
            { title: '状态', dataIndex: 'state', render: (s) => stateBadge(data, s), width: 100 },
          ],
        }),
    ),
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
            fact(
              '变更来源',
              `${data.labels.changeSource[item.source?.type] ?? '—'}${item.source?.ref ? `（${item.source.ref}）` : ''}`,
            ),
            fact('失效原因分析', item.rootCause),
            fact(
              '受影响物料版本',
              item.impact?.items?.length
                ? item.impact.items.map((i) => `${i.itemId} ${i.fromRev} → ${i.toRev}`).join('；')
                : '—',
            ),
            item.impact?.fleet &&
              fact('在役影响', `${item.impact.fleet.doors} 扇门：${item.impact.fleet.plan}`),
            fact('ECN', item.ecn),
            item.verification &&
              fact(
                '验证',
                `${item.verification.result}（${item.verification.by}，${time(item.verification.at)}${item.verification.trialId ? `，${item.verification.trialId}` : ''}）`,
              ),
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
            '进入 CCB 评审前必须完成影响分析（现场或型式试验来源还需失效原因分析）；CCB 批准只能经 ECR 审批流程（专业会签 → CCB 决议），批准后生成 ECN，ECN 发布流程批准后生成设计态基线；研发中项目的受影响阶段自动返工，在役项目不返工；关闭前需验证记录。',
          ),
          h(ImpactTree, { data, change: item }),
          item.retrofit && h(RetrofitBar, { change: item, board, role }),
          workOf('changeImpact', item) &&
            h(
              WorkButton,
              {
                board,
                ...workOf('changeImpact', item),
                guide: 'change-agent-impact',
                title: '打开研发协调员并预填请求：补齐影响分析并提交 CCB，决议仍由人做',
              },
              workOf('changeImpact', item).label,
            ),
          h(ApprovalEntry, { data, board, role, setRole, type: 'change', id: item.id }),
          h(TransitionBar, { key: item.id, data, kind: 'change', item, board, role, hidden: ['APPROVED'] }),
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
  const scoped = data.defects.filter(inProject(projectId))
  const scopedRuns = data.testRuns.filter(inProject(projectId))
  const lens = useLens(role, data, { defect: scoped, testRun: scopedRuns })
  const defects = lens
    .pick('defect', scoped)
    .filter((d) => (!severity || d.severity === severity) && (!state || d.state === state))
  const runs = lens.pick('testRun', scopedRuns).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
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
      lens.toggle,
    ),
    lens.empty,
    !lens.empty &&
      h(
        'div',
        { className: 'devboard-cards' },
        projects.map((p) => h(Trend, { key: p.id, project: p })),
      ),
    !lens.empty &&
      guided(
        'quality-defects',
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
      ),
    !lens.empty &&
      guided(
        'quality-tests',
        h(Table, {
          captionRepeatsHeading: true,
          caption: '测试运行记录',
          rowKey: 'id',
          pagination: false,
          size: 'small',
          dataSource: runs,
          empty: lens.all ? '暂无测试运行' : '没有与我相关的测试运行',
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
              title: '用例',
              render: (_v, r) =>
                r.results
                  ? `${r.results.length} 个：${
                      r.results
                        .filter((x) => x.status !== 'pass')
                        .map((x) => `${x.tc} ${x.status === 'fail' ? '失败' : '跳过'}`)
                        .join('、') || '全部通过'
                    }`
                  : '—',
              width: 200,
            },
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
