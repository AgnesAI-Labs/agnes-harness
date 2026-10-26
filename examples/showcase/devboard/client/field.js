import { Badge, Button, Field, PushPage, Select, Table } from '@agnes/web-ui'
import React from 'react'
import { AnalysisFiles } from './analysis.js'
import { ApprovalEntry } from './approvals.js'
import {
  byId,
  day,
  fact,
  guided,
  HistoryTable,
  h,
  idLink,
  options,
  ProjectSelect,
  stateBadge,
  TransitionBar,
  time,
  useDetail,
  useLens,
  useProject,
} from './board.js'
import { workOf } from './entries.js'
import { inProject, stateLabels } from './records.js'
import { WorkButton } from './work.js'

const DAY = 86_400_000
const resultBadge = (data, result) =>
  h(
    Badge,
    {
      tone: result === 'PASS' ? 'ok' : result === 'FAIL' ? 'bad' : result === 'CONDITIONAL' ? 'warn' : 'off',
    },
    data.labels.trialResult[result] ?? result,
  )

// ── Trials and first-article inspection ────────────────────────────────────────────────────────

/** A failed trial without a change gets a one-click draft: a SUBMITTED change whose source is the trial. */
/** The trial's linked change, when the CCB rejected it: it never releases the trial. */
const rejectedChange = (data, trial) => {
  const change = data.changes.find((c) => c.id === trial.changeId)
  return change && (change.state === 'REJECTED' || change.ccb?.decision === 'REJECTED') ? change : undefined
}

function DraftChange({ trial, board, role, rejected }) {
  const draft = () =>
    board.run(
      'devboard.create',
      {
        kind: 'change',
        by: role,
        projectId: trial.projectId,
        title: `${trial.id} 不合格：设计变更`,
        // The server accepts at most 2000 characters; long deviation lists are cut.
        reason:
          `${trial.title}（${trial.standard}）试验不合格，报告 ${trial.reportNo ?? '—'}。${(trial.deviations ?? []).join('；')}`.slice(
            0,
            2000,
          ),
        source: { type: 'TYPE_TEST', ref: trial.id },
      },
      `${trial.id} 已起草变更，请在「变更」页补齐失效原因分析与影响分析`,
    )
  return h(
    'section',
    { className: 'devboard-actions', 'aria-label': '起草变更' },
    h(
      'p',
      null,
      rejected
        ? `该试验不合格，关联变更 ${rejected.id} 已被驳回：可让智能体起草新变更，或手工起草一份来源为型式试验的变更申请，它会替换原关联。`
        : '该试验不合格且尚未关联变更：可让智能体起草，或手工起草一份来源为型式试验的变更申请。',
    ),
    h(
      WorkButton,
      {
        board,
        ...workOf('trialChange', trial),
        appearance: 'primary',
        guide: 'trial-agent-change',
        title: '打开研发协调员并预填请求：读取试验与基线，起草来源为型式试验的变更，点发送后由智能体执行',
      },
      workOf('trialChange', trial).label,
    ),
    h(
      'div',
      { className: 'devboard-buttons' },
      h(Button, { disabled: board.busy, onClick: draft }, '手工起草'),
      h(
        'span',
        { className: 'devboard-muted' },
        '手工起草只登记一条空壳变更；原因分析与影响分析由研发协调员补齐，批准后才能放行该试验。',
      ),
    ),
  )
}

export function Trials({ data, board, role, setRole }) {
  const [selected, open] = useDetail()
  const [projectId, setProjectId] = useProject(data, true)
  const [type, setType] = React.useState('')
  const [state, setState] = React.useState('')
  const scoped = data.trials.filter(inProject(projectId))
  const lens = useLens(role, data, { trial: scoped })
  const rows = lens
    .pick('trial', scoped)
    .filter((t) => (!type || t.type === type) && (!state || t.state === state))
  const item = byId(data.trials, selected)
  const changeOf = (t) => (t.changeId ? byId(data.changes, t.changeId) : undefined)
  const columns = [
    { title: '编号', dataIndex: 'id', render: idLink(open), width: 120 },
    { title: '名称', dataIndex: 'title', width: 180 },
    ...(projectId ? [] : [{ title: '项目', dataIndex: 'projectId', width: 120 }]),
    { title: '类型', dataIndex: 'type', render: (v) => data.labels.trialType[v], width: 90 },
    { title: '标准', dataIndex: 'standard', width: 200 },
    { title: '样品 / 试验室', render: (_v, t) => `${t.sample} / ${t.lab}`, width: 170 },
    { title: '报告号', dataIndex: 'reportNo', render: (v) => v ?? '—', width: 120 },
    { title: '结论', dataIndex: 'result', render: (v) => resultBadge(data, v), width: 80 },
    { title: '偏差', render: (_v, t) => t.deviations?.length ?? 0, width: 50 },
    { title: '关联变更', dataIndex: 'changeId', render: (v) => v ?? '—', width: 110 },
    { title: '状态', dataIndex: 'state', render: (v) => stateBadge(data, v), width: 90 },
  ]
  const table = (caption, list, empty, guide) =>
    guided(
      guide,
      h(Table, {
        captionRepeatsHeading: true,
        caption,
        rowKey: 'id',
        pagination: false,
        size: 'small',
        dataSource: list,
        empty,
        rowClassName: (t) => (t.result === 'FAIL' && t.state !== 'APPROVED' ? 'devboard-overdue' : ''),
        columns,
      }),
    )
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'devboard-filters' },
      h(ProjectSelect, { data, value: projectId, onChange: setProjectId, allowAll: true }),
      h(Select, {
        'aria-label': '按类型过滤',
        value: type,
        onChange: setType,
        options: options(data.labels.trialType, '全部类型'),
        style: { minWidth: 150 },
      }),
      h(Select, {
        'aria-label': '按状态过滤',
        value: state,
        onChange: setState,
        options: options(stateLabels(data, 'trial'), '全部状态'),
        style: { minWidth: 140 },
      }),
      lens.toggle,
    ),
    lens.empty,
    !lens.empty &&
      table(
        '试验（型式、例行、工厂验收）',
        rows.filter((t) => t.type !== 'FAI'),
        '没有符合条件的试验',
        'trials-list',
      ),
    !lens.empty &&
      table(
        '首件检验（FAI）',
        rows.filter((t) => t.type === 'FAI'),
        '没有首件检验记录',
        'trials-fai',
      ),
    item &&
      h(
        PushPage,
        { id: 'detail', title: `${item.id} ${item.title}`, description: item.standard },
        h(
          'div',
          { className: 'devboard-detail' },
          h(
            'dl',
            { className: 'devboard-facts' },
            fact('状态', stateBadge(data, item.state)),
            fact('类型', data.labels.trialType[item.type]),
            fact('项目', item.projectId),
            fact('标准', item.standard),
            fact('样品', item.sample),
            fact('试验室', item.lab),
            fact('见证', item.witness),
            fact('计划日期', day(item.plannedAt)),
            fact('试验日期', day(item.at)),
            fact('报告号', item.reportNo),
            fact('结论', resultBadge(data, item.result)),
            fact('验证需求', item.verifies?.join('、') || '—'),
            fact(
              '关联变更',
              item.changeId ? `${item.changeId}（${data.labels.state[changeOf(item)?.state] ?? '—'}）` : '—',
            ),
          ),
          (item.deviations?.length ?? 0) > 0 &&
            h(
              'section',
              { className: 'devboard-card' },
              h('h2', null, '偏差'),
              h(
                'ul',
                { className: 'devboard-list' },
                item.deviations.map((d) => h('li', { key: d }, d)),
              ),
            ),
          h(AnalysisFiles, { data, board, projectId: item.projectId, ids: [item.id] }),
          item.result === 'FAIL' &&
            (!item.changeId || rejectedChange(data, item)) &&
            item.state !== 'APPROVED' &&
            h(DraftChange, { trial: item, board, role, rejected: rejectedChange(data, item) }),
          h(ApprovalEntry, { data, board, role, setRole, type: 'trial', id: item.id }),
          h(TransitionBar, {
            key: item.id,
            data,
            kind: 'trial',
            item,
            board,
            role,
            hidden: ['APPROVED'],
            fields: [
              { key: 'reportNo', label: '报告号（出具报告时必填）', max: 48 },
              {
                key: 'result',
                label: '结论（出具报告时必填）',
                options: ['PASS', 'FAIL', 'CONDITIONAL'].map((v) => ({
                  value: v,
                  label: data.labels.trialResult[v],
                })),
              },
              { key: 'deviations', label: '偏差（每行一条）', lines: true },
              {
                key: 'changeId',
                label: '关联变更（不合格试验放行需已批准的变更）',
                options: data.changes
                  .filter((c) => c.projectId === item.projectId)
                  .map((c) => ({ value: c.id, label: `${c.id} ${c.title}` })),
              },
            ],
          }),
          h(HistoryTable, { data, history: item.history }),
        ),
      ),
  )
}

// ── Service and quality: PHM alarms and 8D problems ────────────────────────────────────────────

const WEEKS = 12
const STEPS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8']

/** Alarms by signal and week as plain CSS bars (newest week on the right); no chart library. */
function AlarmChart({ data, faults }) {
  const now = Date.parse(data.now)
  const grid = Object.keys(data.labels.faultSignal).map((signal) => {
    const weeks = Array.from({ length: WEEKS }, () => 0)
    for (const f of faults.filter((x) => x.signal === signal)) {
      const age = Math.floor((now - Date.parse(f.detectedAt)) / (7 * DAY))
      if (age >= 0 && age < WEEKS) weeks[WEEKS - 1 - age]++
    }
    return { signal, weeks, total: faults.filter((x) => x.signal === signal).length }
  })
  const max = Math.max(1, ...grid.flatMap((g) => g.weeks))
  return h(
    'section',
    { className: 'devboard-card', 'aria-label': '预警聚合', 'data-guide': 'service-alarms' },
    h('h2', null, `预警按信号与周聚合（近 ${WEEKS} 周，每格一周，最右为本周）`),
    h(
      'ul',
      { className: 'devboard-alarms' },
      grid.map((g) =>
        h(
          'li',
          { key: g.signal },
          h('span', null, data.labels.faultSignal[g.signal]),
          h(
            'span',
            {
              className: 'devboard-spark',
              role: 'img',
              'aria-label': `${data.labels.faultSignal[g.signal]} 近 ${WEEKS} 周 ${g.weeks.join(',')}`,
            },
            g.weeks.map((n, i) =>
              h('span', {
                key: i,
                className: `devboard-spark-bar${n ? ' devboard-tone-bad' : ''}`,
                style: { height: `${n ? Math.max(12, (n / max) * 100) : 4}%` },
                title: `第 ${i + 1} 周 ${n} 条`,
              }),
            ),
          ),
          h('strong', null, `全部 ${g.total}`),
        ),
      ),
    ),
  )
}

const stepChips = (problem) =>
  h(
    'span',
    { className: 'devboard-chips' },
    STEPS.map((s) => h(Badge, { key: s, tone: problem.steps?.[s]?.done ? 'ok' : 'off' }, s)),
  )

export function Service({ data, board, role, setRole }) {
  const [selected, open] = useDetail()
  const [projectId, setProjectId] = useProject(data, true)
  const [signal, setSignal] = React.useState('')
  const [state, setState] = React.useState('')
  const scopedFaults = data.faults.filter(inProject(projectId))
  const scopedProblems = data.problems.filter(inProject(projectId))
  const lens = useLens(role, data, { fault: scopedFaults, problem: scopedProblems })
  const inScope = lens.pick('fault', scopedFaults)
  const faults = inScope
    .filter((f) => (!signal || f.signal === signal) && (!state || f.state === state))
    .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt))
  const problems = lens.pick('problem', scopedProblems)
  const fault = byId(data.faults, selected)
  const problem = byId(data.problems, selected)
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'devboard-filters' },
      h(ProjectSelect, { data, value: projectId, onChange: setProjectId, allowAll: true }),
      h(Select, {
        'aria-label': '按信号过滤',
        value: signal,
        onChange: setSignal,
        options: options(data.labels.faultSignal, '全部信号'),
        style: { minWidth: 150 },
      }),
      h(Select, {
        'aria-label': '按状态过滤',
        value: state,
        onChange: setState,
        options: options(stateLabels(data, 'fault'), '全部状态'),
        style: { minWidth: 140 },
      }),
      lens.toggle,
    ),
    lens.empty,
    !lens.empty && h(AlarmChart, { data, faults: inScope }),
    !lens.empty &&
      guided(
        'service-faults',
        h(Table, {
          captionRepeatsHeading: true,
          caption: '预警',
          rowKey: 'id',
          pagination: false,
          size: 'small',
          dataSource: faults,
          empty: '没有符合条件的预警',
          columns: [
            { title: '编号', dataIndex: 'id', render: idLink((id) => open(id, 'fault')), width: 130 },
            { title: '信号', dataIndex: 'signal', render: (v) => data.labels.faultSignal[v], width: 100 },
            { title: '车 / 厢 / 门', render: (_v, f) => `${f.train} / ${f.car} / ${f.door}`, width: 130 },
            { title: '来源', dataIndex: 'source', render: (v) => data.labels.faultSource[v] ?? v, width: 90 },
            { title: '健康分', dataIndex: 'healthScore', render: (v) => v ?? '—', width: 70 },
            { title: '发现时间', dataIndex: 'detectedAt', render: time, width: 140 },
            { title: '说明', dataIndex: 'detail' },
            { title: '质量问题', dataIndex: 'problemId', render: (v) => v ?? '—', width: 120 },
            { title: '状态', dataIndex: 'state', render: (v) => stateBadge(data, v), width: 90 },
          ],
        }),
      ),
    !lens.empty &&
      guided(
        'service-problems',
        h(Table, {
          captionRepeatsHeading: true,
          caption: '质量问题（8D）',
          rowKey: 'id',
          pagination: false,
          dataSource: problems,
          empty: lens.all ? '暂无质量问题' : '没有与我相关的质量问题',
          columns: [
            { title: '编号', dataIndex: 'id', render: idLink((id) => open(id, 'problem')), width: 130 },
            { title: '标题', dataIndex: 'title' },
            { title: '等级', dataIndex: 'severity', width: 60 },
            { title: '8D 进度', render: (_v, p) => stepChips(p), width: 300 },
            { title: '根本原因', dataIndex: 'rootCause', render: (v) => v ?? '待分析', width: 220 },
            { title: '关联变更', dataIndex: 'changeId', render: (v) => v ?? '—', width: 120 },
            { title: '预警', render: (_v, p) => p.faultIds?.length ?? 0, width: 60 },
            { title: '状态', dataIndex: 'state', render: (v) => stateBadge(data, v), width: 90 },
          ],
        }),
      ),
    fault &&
      h(
        PushPage,
        {
          id: 'fault',
          title: `${fault.id} ${data.labels.faultSignal[fault.signal]}`,
          description: fault.detail,
        },
        h(
          'div',
          { className: 'devboard-detail' },
          h(
            'dl',
            { className: 'devboard-facts' },
            fact('状态', stateBadge(data, fault.state)),
            fact('项目', fault.projectId),
            fact('来源', data.labels.faultSource[fault.source] ?? fault.source),
            fact('车 / 厢 / 门', `${fault.train} / ${fault.car} / ${fault.door}`),
            fact('健康分', fault.healthScore),
            fact('发现时间', time(fault.detectedAt)),
            fact('质量问题', fault.problemId),
          ),
          workOf('faultEightD', fault) &&
            h(
              WorkButton,
              { board, ...workOf('faultEightD', fault), guide: 'fault-agent-8d' },
              workOf('faultEightD', fault).label,
            ),
          h(TransitionBar, { key: fault.id, data, kind: 'fault', item: fault, board, role }),
          h(HistoryTable, { data, history: fault.history }),
        ),
      ),
    problem &&
      h(
        PushPage,
        {
          id: 'problem',
          title: `${problem.id} ${problem.title}`,
          description: `等级 ${problem.severity} · ${problem.owner}`,
        },
        h(
          'div',
          { className: 'devboard-detail' },
          h(
            'dl',
            { className: 'devboard-facts' },
            fact('状态', stateBadge(data, problem.state)),
            fact('项目', problem.projectId),
            fact('负责人', problem.owner),
            fact('根本原因', problem.rootCause),
            fact('临时措施', problem.containment),
            fact(
              '关联变更',
              problem.changeId
                ? `${problem.changeId}（${data.labels.state[byId(data.changes, problem.changeId)?.state] ?? '—'}）${problem.noChangeReason ? `；无需变更：${problem.noChangeReason}` : ''}`
                : problem.noChangeReason
                  ? `无（${problem.noChangeReason}）`
                  : '—',
            ),
            fact('关联预警', problem.faultIds?.join('、') || '—'),
          ),
          h(
            'ol',
            { className: 'devboard-steps', 'aria-label': '8D 步骤' },
            STEPS.map((s) =>
              h(
                'li',
                { key: s },
                h(
                  Badge,
                  { tone: problem.steps?.[s]?.done ? 'ok' : 'off' },
                  `${s}${problem.steps?.[s]?.done ? ' 完成' : ' 未完成'}`,
                ),
                ' ',
                problem.steps?.[s]?.text ?? '',
              ),
            ),
          ),
          h(
            'p',
            { className: 'devboard-muted' },
            '进入措施前必须有根本原因且 D4 完成；关闭前 D8 完成，且关联变更已关闭，或（无关联变更、变更被 CCB 驳回时）写明无需变更的理由。',
          ),
          h(AnalysisFiles, {
            data,
            board,
            projectId: problem.projectId,
            ids: [problem.id, ...(problem.faultIds ?? [])],
          }),
          workOf('problemEightD', problem) &&
            h(
              WorkButton,
              { board, ...workOf('problemEightD', problem), guide: 'problem-agent-8d' },
              workOf('problemEightD', problem).label,
            ),
          h(NoChangeReason, { key: problem.id, data, problem, board, role }),
          h(ApprovalEntry, { data, board, role, setRole, type: 'problem', id: problem.id }),
          h(TransitionBar, {
            key: problem.id,
            data,
            kind: 'problem',
            item: problem,
            board,
            role,
            hidden: ['CLOSED'],
            fields: [{ key: 'rootCause', label: '根本原因（进入措施前必填）' }],
          }),
          h(HistoryTable, { data, history: problem.history }),
        ),
      ),
  )
}

/** Why a problem needs no design change, saved without a move: in VERIFYING the only move is back to ACTION. */
function NoChangeReason({ data, problem, board, role }) {
  const [reason, setReason] = React.useState('')
  // Frozen while the close flow runs, as on the server.
  const running = data.approvals.some((a) => a.state === 'RUNNING' && a.subject.id === problem.id)
  // A change the CCB rejected leaves the problem to a new change or to this reason, as on the server.
  const rejected = byId(data.changes, problem.changeId)?.ccb?.decision === 'REJECTED'
  if ((problem.changeId && !rejected) || problem.state === 'CLOSED' || running) return null
  const save = async () => {
    const ok = await board.run(
      'devboard.transition',
      { kind: 'problem', id: problem.id, by: role, noChangeReason: reason.trim() },
      `${problem.id} 已保存无需变更的理由`,
    )
    if (ok) setReason('')
  }
  return h(
    'section',
    { className: 'devboard-actions', 'aria-label': '无需变更的理由' },
    h(
      Field,
      {
        label: '无需变更的理由（无关联变更或变更被驳回时关闭必填）',
        htmlFor: `devboard-no-change-${problem.id}`,
      },
      h('input', {
        id: `devboard-no-change-${problem.id}`,
        className: 'devboard-note',
        maxLength: 500,
        placeholder: problem.noChangeReason ?? '',
        value: reason,
        onChange: (e) => setReason(e.target.value),
      }),
    ),
    h(
      'div',
      { className: 'devboard-buttons' },
      h(Button, { disabled: board.busy || !reason.trim(), onClick: save }, '保存理由'),
    ),
  )
}
