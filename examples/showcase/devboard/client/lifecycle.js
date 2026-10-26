import { Badge, Button, PushPage, Table, usePushStack } from '@agnes/web-ui'
import React from 'react'
import { ActivityPanel } from './activity.js'
import { ApprovalEntry, TodoColumn } from './approvals.js'
import {
  byId,
  day,
  fact,
  gateName,
  gateOutcome,
  gateOutcomeBadge,
  guided,
  HistoryTable,
  h,
  jumpTo,
  Meter,
  NoteField,
  ProjectSelect,
  pct,
  RoleHint,
  signProgress,
  stageName,
  stateBadge,
  TransitionBar,
  time,
  useProject,
} from './board.js'
import { CustomerChange } from './customer-change.js'
import { workOf } from './entries.js'
import { HandbackCards } from './handback.js'
import { cardsOf, lensSummary, METRICS, relevant } from './lens.js'
import { NewProject } from './new-project.js'
import { ArtifactPreview, DeliveryCard } from './result.js'
import { WorkButton } from './work.js'

const STAGE_ORDER = ['INITIATION', 'REQUIREMENTS', 'DESIGN', 'IMPLEMENTATION', 'VERIFICATION', 'RELEASE']
const stagesOf = (data, projectId) =>
  STAGE_ORDER.map((s) => byId(data.stages, `${projectId}/${s}`)).filter(Boolean)
const gatesOf = (data, stageId) => data.gates.filter((g) => g.stageId === stageId)
const pendingGates = (data) => data.gates.filter((g) => g.decision === 'PENDING')

/** Six segments, one per stage, coloured by state. */
function StageBar({ data, projectId }) {
  return h(
    'ol',
    { className: 'devboard-stagebar', 'aria-label': '阶段进度' },
    stagesOf(data, projectId).map((s) =>
      h(
        'li',
        {
          key: s.id,
          className: `devboard-stage devboard-stage-${s.state}`,
          title: `${stageName(data, projectId, s.stage)}：${data.labels.state[s.state]}`,
        },
        h('span', { className: 'devboard-stage-name' }, stageName(data, projectId, s.stage)),
        h('small', { className: 'devboard-stage-state' }, data.labels.state[s.state]),
      ),
    ),
  )
}

/** One chip per gate of the project's profile (minus tailored-out gates), coloured by decision. */
function GateChips({ data, projectId }) {
  const gates = stagesOf(data, projectId).flatMap((s) => gatesOf(data, s.id).filter((g) => !g.superseded))
  return h(
    'div',
    { className: 'devboard-chips', 'aria-label': '评审点' },
    gates.map((g) =>
      h(
        Badge,
        { key: g.id, tone: g.decision === 'APPROVED' ? 'ok' : g.decision === 'PENDING' ? 'warn' : 'bad' },
        g.code,
      ),
    ),
  )
}

/** The in-service card: 30-day alarms by signal, open problems, retrofit progress and baseline gap. */
function ServiceFacts({ data, project }) {
  const m = project.metrics
  const signals = Object.entries(m.faults30d)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${data.labels.faultSignal[k]} ${n}`)
    .join(' · ')
  return h(
    React.Fragment,
    null,
    h(
      'dl',
      { className: 'devboard-facts' },
      fact('服务阶段', `${project.service.phase} · 质保至 ${day(project.service.warrantyEnd)}`),
      fact('近 30 天预警', `${m.faults30dTotal} 条${signals ? `：${signals}` : ''}`),
      fact('未关闭质量问题', m.openProblems),
      fact(
        '配置基线差异',
        m.baselineGap > 0 ? `${m.baselineGap} 件物料维护态落后于设计态` : '维护态与设计态一致',
      ),
    ),
    m.retrofit.total > 0 &&
      h(Meter, {
        label: `整改 ${m.retrofit.done}/${m.retrofit.total}`,
        value: Math.round((m.retrofit.done / m.retrofit.total) * 1000) / 10,
      }),
  )
}

const kpis = (rows) =>
  h(
    'div',
    { className: 'devboard-kpis' },
    rows.map(([label, n]) =>
      h(
        'div',
        { className: 'devboard-kpi', key: label },
        h('strong', null, n),
        h('span', { className: 'devboard-kpi-label' }, label),
      ),
    ),
  )

/** The home of the demo role: what waits for it, its open records and the most urgent ones (links to the details). */
function Workbench({ data, role }) {
  const { pending, counts, urgent } = lensSummary(role, data)
  const open = (id, page) => {
    const hit = urgent.find((u) => u.id === id && u.page === page)
    if (hit) jumpTo(hit.entry, id, page)
  }
  return h(
    'section',
    { 'aria-label': `${role}的工作台`, 'data-guide': 'overview-workbench' },
    h('h2', { className: 'devboard-heading' }, `${role}的工作台`),
    kpis([['待我处理', pending], ...cardsOf(role).map((key) => [METRICS[key][0], counts[key]])]),
    h(TodoColumn, {
      title: '与我相关的紧急事项',
      items: urgent.map((u) => ({
        ...u,
        meta: `${u.meta}${Number.isFinite(u.due) ? ` · ${u.dueLabel} ${time(u.due)}` : ''}`,
      })),
      empty: `「${role}」当前没有紧急事项。`,
      open,
    }),
  )
}

export function Overview({ data, board, role }) {
  const push = usePushStack()
  const [created, setCreated] = React.useState(null)
  const pending = pendingGates(data)
  const interventions = data.interventions.filter((i) => i.state === 'OPEN' || i.state === 'EXPIRED')
  const ccb = data.changes.filter((c) => c.state === 'CCB_REVIEW')
  const overdue = data.projects.filter((p) => p.metrics.overdue)
  const lateFlows = data.approvals.filter((a) => a.overdue)
  return h(
    React.Fragment,
    null,
    h(HandbackCards, { data, board, role }),
    h(Workbench, { data, role }),
    h(ActivityPanel, { data }),
    h('h2', { className: 'devboard-heading' }, '项目组合'),
    lateFlows.length > 0 &&
      h(
        'p',
        { className: 'devboard-alert', role: 'alert' },
        `${lateFlows.length} 个审批节点已超时：${lateFlows.map((a) => `${a.id}（${a.nodes[a.current].name}）`).join('、')}，见「我的待办」。`,
      ),
    overdue.length > 0 &&
      h(
        'p',
        { className: 'devboard-alert', role: 'alert' },
        `${overdue.map((p) => `${p.id} ${stageName(data, p.id, p.metrics.currentStage)}`).join('、')} 已超出计划完成日期。`,
      ),
    kpis([
      ['待决议评审门', pending.length],
      ['审批中的流程', data.approvals.filter((a) => a.state === 'RUNNING').length],
      ['待处理人工介入', interventions.length],
      ['待 CCB 决议变更', ccb.length],
      ['在研项目', data.projects.filter((p) => p.metrics.passedStages < p.metrics.stageCount).length],
    ]),
    h('div', { className: 'devboard-buttons' }, h(Button, { onClick: () => push.open('new') }, '新建项目')),
    h(
      'div',
      { className: 'devboard-projects', 'data-guide': 'overview-portfolio' },
      data.projects.map((p) => {
        const m = p.metrics
        const gates = pending.filter((g) => g.stageId.startsWith(`${p.id}/`))
        const system = m.latestTests.find((t) => t.level === 'SYSTEM') ?? m.latestTests.at(-1)
        const open = Object.values(m.openDefects).reduce((a, b) => a + b, 0)
        return h(
          'section',
          { className: 'devboard-card devboard-project', key: p.id, 'aria-label': p.name },
          h(
            'header',
            null,
            h(
              'span',
              { className: 'devboard-muted' },
              `${p.id} · ${data.labels.projectKind[p.kind] ?? p.kind} · ${p.org ?? '—'}${p.live ? ' · 现场项目' : ''}`,
            ),
            h('h2', null, p.name),
            h(
              'span',
              { className: 'devboard-muted' },
              `${p.customer ?? ''}${p.safetyIntegrity ? ` · ${p.safetyIntegrity}` : ''}`,
            ),
          ),
          h(StageBar, { data, projectId: p.id }),
          h(GateChips, { data, projectId: p.id }),
          h(
            'dl',
            { className: 'devboard-facts' },
            fact(
              '当前阶段',
              `${stageName(data, p.id, m.currentStage)} · ${data.labels.state[m.currentState]}`,
            ),
            fact(
              '里程碑偏差',
              m.delayDays > 0
                ? `${m.overdue ? '超期' : '延后'} ${m.delayDays} 天`
                : `提前 ${-m.delayDays} 天`,
            ),
            fact(
              '评审门',
              gates.length
                ? gates
                    .map(
                      (g) =>
                        `${gateName(g)} 待 ${g.approverRoles.join('、')} 决议（会签 ${signProgress(g)}）`,
                    )
                    .join('；')
                : '无待决议',
            ),
            fact(
              '未关闭缺陷',
              `${open}（A ${m.openDefects.A} / B ${m.openDefects.B} / C ${m.openDefects.C} / D ${m.openDefects.D}）`,
            ),
            fact(
              '最近测试通过率',
              system ? `${data.labels.testLevel[system.level]} ${pct(system.passRate)}` : '—',
            ),
            fact('未关闭变更 / 风险', `${m.openChanges} / ${m.openRisks}`),
          ),
          h(Meter, { label: 'CUS→SYS', value: m.coverage.cusSys.pct }),
          h(Meter, { label: 'SYS→SWR', value: m.coverage.sysSwr.pct }),
          h(Meter, { label: 'SWR→TC', value: m.coverage.swrTc.pct }),
          p.service && h(ServiceFacts, { data, project: p }),
        )
      }),
    ),
    h(
      PushPage,
      {
        id: 'new',
        title: '新建研发项目',
        description: '现场项目由研发协调员带领各角色完成，每过一道门由人在看板审批。',
      },
      h(
        'div',
        { className: 'devboard-detail' },
        created
          ? h(
              'section',
              { className: 'devboard-actions' },
              h(
                'p',
                null,
                created.live
                  ? `已新建 ${created.id}。下一步：让研发协调员写项目计划并提交立项评审。`
                  : `已新建 ${created.id}（订单项目记录，不建工作区）。可在「项目」页查看评审点档案。`,
              ),
              created.live &&
                h(
                  WorkButton,
                  {
                    board,
                    ...workOf('continueProject', created),
                    appearance: 'primary',
                  },
                  '让研发协调员继续推进',
                ),
            )
          : h(NewProject, { data, board, role, onDone: setCreated }),
      ),
    ),
  )
}

/** Gate decision form: the server applies the three rules; the page always lets the attempt through. */
export function GatePanel({ data, gate, board, role, setRole }) {
  const stage = byId(data.stages, gate.stageId)
  const [comment, setComment] = React.useState('')
  const [closing, setClosing] = React.useState({})
  const [decided, setDecided] = React.useState(false)
  const open = gate.findings.filter((f) => !f.closed)
  const can =
    stage?.author !== role &&
    gate.approverRoles.includes(role) &&
    !(gate.signatures ?? []).some((x) => x.role === role)
  const decide = async (decision) => {
    const openIds = new Set(open.map((f) => f.id))
    const closeFindings = Object.entries(closing)
      .filter(([id, note]) => openIds.has(id) && note.trim())
      .map(([id, note]) => ({ id, note: note.trim() }))
    const ok = await board.run(
      'devboard.gate',
      {
        gateId: gate.id,
        decision,
        by: role,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
        ...(closeFindings.length ? { closeFindings } : {}),
      },
      `${gateName(gate)} 已${decision === 'APPROVED' ? '签署' : '驳回'}`,
    )
    if (ok) {
      setDecided(true)
      // A co-signature leaves the gate PENDING and this panel mounted: the next signer starts clean.
      setComment('')
      setClosing({})
    }
  }
  return h(
    'div',
    { className: 'devboard-detail' },
    h(
      'dl',
      { className: 'devboard-facts' },
      fact(
        '阶段',
        `${stage?.projectId} ${stageName(data, stage?.projectId, stage?.stage)}（${data.labels.state[stage?.state]}）`,
      ),
      fact('评审点', `${gateName(gate)}（${data.labels.gateType[gate.type] ?? gate.type}）`),
      fact('编写角色', stage?.author),
      fact('审批角色', gate.approverRoles.join('、')),
      fact('会签进度', signProgress(gate)),
      fact('决议', gateOutcomeBadge(data, gate)),
      fact('审批人', gate.approver),
      fact('决议时间', time(gate.decidedAt)),
      fact('评审结论', gate.comment),
      fact('基线', stage?.baseline?.id),
    ),
    (gate.signatures?.length ?? 0) > 0 &&
      h(Table, {
        captionRepeatsHeading: true,
        caption: '会签记录',
        rowKey: 'role',
        pagination: false,
        size: 'small',
        dataSource: gate.signatures,
        columns: [
          { title: '角色', dataIndex: 'role', width: 140 },
          { title: '签署人', dataIndex: 'by', width: 180 },
          { title: '时间', dataIndex: 'at', render: time, width: 140 },
          { title: '意见', dataIndex: 'comment' },
        ],
      }),
    h(Table, {
      captionRepeatsHeading: true,
      caption: '评审意见',
      rowKey: 'id',
      pagination: false,
      size: 'small',
      dataSource: gate.findings,
      empty: '没有评审意见',
      rowClassName: (r) => (r.closed ? '' : 'devboard-overdue'),
      columns: [
        { title: '编号', dataIndex: 'id', width: 70 },
        { title: '意见', dataIndex: 'text' },
        { title: '提出人', dataIndex: 'by', width: 150 },
        {
          title: '关闭',
          width: 260,
          render: (_v, f) =>
            f.closed
              ? `已关闭：${f.closedNote ?? ''}`
              : gate.decision === 'PENDING'
                ? h('input', {
                    className: 'devboard-note',
                    'aria-label': `${f.id} 关闭说明`,
                    placeholder: '填写关闭说明即随决议关闭',
                    value: closing[f.id] ?? '',
                    onChange: (e) => setClosing({ ...closing, [f.id]: e.target.value }),
                  })
                : '未关闭',
        },
      ],
    }),
    gate.superseded
      ? h('p', { className: 'devboard-muted' }, '该评审门已因返工作废，不能再处理。')
      : gate.decision === 'PENDING'
        ? h(
            'section',
            { className: 'devboard-actions', 'aria-label': '评审决议', 'data-guide': 'gate-decision' },
            stage?.author === role &&
              h(Badge, { tone: 'warn' }, `当前演示角色「${role}」是该阶段的编写角色，不能审批。`),
            stage?.author !== role && h(RoleHint, { gate, role, setRole }),
            can &&
              open.length > 0 &&
              h(
                'span',
                { className: 'devboard-muted' },
                `还有 ${open.length} 条意见未关闭：批准前需全部关闭（可在上表填写关闭说明）。`,
              ),
            can &&
              h(NoteField, {
                id: `devboard-gate-${gate.id}`,
                label: '评审结论（驳回必填）',
                value: comment,
                onChange: setComment,
              }),
            can &&
              h(
                'div',
                { className: 'devboard-buttons' },
                h(
                  Button,
                  { appearance: 'primary', disabled: board.busy, onClick: () => decide('APPROVED') },
                  `以「${role}」批准`,
                ),
                h(Button, { disabled: board.busy, onClick: () => decide('REJECTED') }, '驳回'),
              ),
          )
        : h(
            'section',
            { className: 'devboard-actions' },
            h('p', null, decided ? '已决议。现场项目请让研发协调员继续推进。' : '该评审门已决议。'),
            h(
              WorkButton,
              {
                board,
                ...workOf('continueGate', { ...gate, decision: 'APPROVED' }),
                appearance: decided ? 'primary' : 'secondary',
                guide: 'gate-continue',
                title: '打开研发协调员会话，草稿由你点发送',
              },
              '继续推进',
            ),
            h(
              'details',
              { className: 'devboard-evidence' },
              h('summary', null, '越权与重复操作校验'),
              h(
                'div',
                { className: 'devboard-buttons' },
                h(Button, { disabled: board.busy, onClick: () => decide('APPROVED') }, '再次批准'),
              ),
            ),
          ),
  )
}

const latestBaselines = (data, projectId) => {
  const seq = (b) => Number(/-(\d+)$/.exec(b.id)?.[1] ?? 0)
  const out = {}
  for (const b of data.configBaselines.filter((x) => x.projectId === projectId))
    if (!out[b.type] || seq(b) > seq(out[b.type])) out[b.type] = b
  return out
}

/** 物料 | 设计态 | 制造态 | 维护态: the latest baseline of each type; an item behind the as-designed rev is highlighted. */
function BaselineTable({ data, projectId }) {
  const latest = latestBaselines(data, projectId)
  const items = data.items.filter((i) => i.projectId === projectId)
  const designed = latest.AS_DESIGNED?.revs ?? {}
  // The as-built baseline is the delivered configuration and stays behind by design; only the
  // as-maintained baseline lagging behind the as-designed one is a gap.
  const lagging = (i) => Boolean(latest.AS_MAINTAINED) && latest.AS_MAINTAINED.revs[i.id] !== designed[i.id]
  return h(
    React.Fragment,
    null,
    h(Table, {
      captionRepeatsHeading: true,
      caption: `配置基线（${items.filter(lagging).length} 件落后于设计态）`,
      rowKey: 'id',
      pagination: false,
      size: 'small',
      dataSource: items,
      rowClassName: (i) => (lagging(i) ? 'devboard-lag' : ''),
      columns: [
        { title: '物料', render: (_v, i) => `${i.id} ${i.name}`, width: 260 },
        { title: '专业', dataIndex: 'discipline', render: (d) => data.labels.discipline[d] ?? d, width: 70 },
        ...Object.entries(data.labels.baselineType).map(([type, label]) => ({
          title: label,
          render: (_v, i) => latest[type]?.revs[i.id] ?? '—',
          width: 90,
        })),
        { title: '', render: (_v, i) => (lagging(i) ? h(Badge, { tone: 'warn' }, '落后') : ''), width: 70 },
      ],
    }),
    h(
      'p',
      { className: 'devboard-muted' },
      Object.values(latest)
        .map((b) => `${data.labels.baselineType[b.type]}：${b.id}（${day(b.at)}）`)
        .join(' · '),
    ),
  )
}

function ServiceInfo({ project }) {
  const sv = project.service
  return h(
    'dl',
    { className: 'devboard-facts' },
    fact('服务阶段', sv.phase),
    fact('交付日期', day(sv.deliveredAt)),
    fact('质保期至', day(sv.warrantyEnd)),
    fact('编组', `${sv.trains} 列 × ${sv.doorsPerTrain} 扇门 = ${sv.trains * sv.doorsPerTrain} 扇`),
    fact(
      '修程',
      (sv.overhaul ?? [])
        .map((o) => `${o.level} ${o.km.toLocaleString('zh-CN')} km / ${o.years} 年（${o.note}）`)
        .join('；'),
    ),
  )
}

export function Projects({ data, board, role, setRole }) {
  const push = usePushStack()
  const [projectId, setProjectId] = useProject(data)
  const [selected, setSelected] = React.useState({})
  const project = byId(data.projects, projectId)
  if (!project) return h('p', null, '暂无项目')
  const openPage = (kind, id) => {
    setSelected({ kind, id })
    push.open(kind)
  }
  const stages = stagesOf(data, project.id)
  const artifact = selected.kind === 'artifact' && byId(data.artifacts, selected.id)
  const gate = selected.kind === 'gate' && byId(data.gates, selected.id)
  const stage = selected.kind === 'stage' && byId(data.stages, selected.id)
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'devboard-filters' },
      h(ProjectSelect, { data, value: project.id, onChange: setProjectId }),
    ),
    h(
      'dl',
      { className: 'devboard-facts', 'data-guide': 'projects-info' },
      fact('客户', project.customer),
      fact('线路', project.line),
      fact('项目经理', project.manager),
      fact('归属技术中心', project.org),
      fact(
        '类型 / 产品线',
        `${data.labels.projectKind[project.kind] ?? project.kind} / ${data.labels.productLine[project.productLine] ?? project.productLine}`,
      ),
      fact(
        '安全完整性',
        project.safetyIntegrity ? `${project.safetyIntegrity}（按 EN 50126 / EN 50716 假设）` : '—',
      ),
      fact('计划', `${day(project.plannedStart)} – ${day(project.plannedEnd)}`),
      project.live && fact('工作区目录', project.workspaceDir),
      project.live &&
        fact(
          '应用',
          project.appUrl
            ? h(
                'a',
                { href: project.appUrl, target: '_blank', rel: 'noreferrer' },
                `打开应用 ${project.appUrl}`,
              )
            : '发布阶段登记运行地址后可打开',
        ),
    ),
    project.service && h(ServiceInfo, { project }),
    h(StageBar, { data, projectId: project.id }),
    h(
      WorkButton,
      {
        board,
        ...workOf('projectProgress', project),

        guide: 'projects-agent-progress',
        title: '打开研发协调员并预填请求：读取这个项目的交接内容并汇报进度，只汇报不修改',
      },
      workOf('projectProgress', project).label,
    ),
    h(CustomerChange, { board, project, role }),
    project.tailoring?.skipped?.length > 0 &&
      h(
        'p',
        { className: 'devboard-muted', role: 'note' },
        `评审点已裁剪：跳过 ${project.tailoring.skipped.join('、')}。理由：${project.tailoring.reason}`,
      ),
    guided(
      'projects-timeline',
      h(Table, {
        captionRepeatsHeading: true,
        caption: '阶段时间线',
        rowKey: 'id',
        pagination: false,
        dataSource: stages,
        rowClassName: (s) =>
          [
            s.state !== 'PASSED' &&
            s.plannedEnd &&
            Date.parse(s.plannedEnd) < Date.parse(data.now) &&
            s.state !== 'NOT_STARTED'
              ? 'devboard-overdue'
              : '',
            relevant(role, 'stage', s, data) ? 'devboard-mine' : '',
          ]
            .filter(Boolean)
            .join(' '),
        columns: [
          {
            title: '阶段',
            render: (_v, s) =>
              h(
                Button,
                { appearance: 'link', onClick: () => openPage('stage', s.id) },
                stageName(data, project.id, s.stage),
              ),
            width: 150,
          },
          { title: '状态', dataIndex: 'state', render: (v) => stateBadge(data, v), width: 90 },
          { title: '计划完成', dataIndex: 'plannedEnd', render: day, width: 110 },
          { title: '实际完成', dataIndex: 'actualEnd', render: day, width: 110 },
          { title: '编写角色', dataIndex: 'author', width: 120 },
          {
            title: '评审门',
            render: (_v, s) =>
              gatesOf(data, s.id).map((g) =>
                h(
                  React.Fragment,
                  { key: g.id },
                  relevant(role, 'gate', g, data) && [
                    h(Badge, { key: 'mine', tone: 'warn' }, '与我相关'),
                    ' ',
                  ],
                  h(
                    Button,
                    { appearance: 'link', onClick: () => openPage('gate', g.id) },
                    `${gateName(g)} ${gateOutcome(data, g)}${g.decision === 'PENDING' && g.approverRoles.length > 1 ? `（会签 ${signProgress(g)}）` : ''}`,
                  ),
                ),
              ),
            width: 260,
          },
          {
            title: '交付物',
            render: (_v, s) =>
              h(
                'div',
                { className: 'devboard-buttons' },
                data.artifacts
                  .filter((a) => a.projectId === project.id && a.stage === s.stage)
                  .map((a) =>
                    h(
                      Button,
                      { key: a.id, appearance: 'link', onClick: () => openPage('artifact', a.id) },
                      `${a.title} ${a.version}`,
                    ),
                  ),
              ),
          },
          { title: '基线', render: (_v, s) => s.baseline?.id ?? '', width: 160 },
        ],
      }),
    ),
    h(
      'p',
      { className: 'devboard-muted' },
      `与「${role}」相关的阶段（编写角色）和评审门（审批角色或阶段编写角色）已高亮；本页不按角色筛选。`,
    ),
    h(DeliveryCard, { data, board, project }),
    data.configBaselines.some((b) => b.projectId === project.id) &&
      guided('projects-baseline', h(BaselineTable, { data, projectId: project.id })),
    (project.risks?.length ?? 0) > 0 &&
      h(Table, {
        captionRepeatsHeading: true,
        caption: '风险',
        rowKey: 'id',
        pagination: false,
        size: 'small',
        dataSource: project.risks,
        columns: [
          { title: '编号', dataIndex: 'id', width: 110 },
          { title: '风险', dataIndex: 'title' },
          { title: '等级', dataIndex: 'level', width: 60 },
          { title: '负责人', dataIndex: 'owner', width: 140 },
          { title: '应对', dataIndex: 'mitigation' },
          {
            title: '状态',
            dataIndex: 'status',
            render: (v) => (v === 'CLOSED' ? '已关闭' : '未关闭'),
            width: 80,
          },
        ],
      }),
    h(
      'p',
      { className: 'devboard-muted' },
      '试验与首件检验（FAI）见「试验与首件」页；现场验收（SAT）、独立安全评估（ISA）与 FMEA/FTA 由外部/硬件环节完成，本工作台不建模。',
    ),
    artifact &&
      h(
        PushPage,
        {
          id: 'artifact',
          title: `${artifact.id} ${artifact.title}`,
          description: `${artifact.version} · ${data.labels.state[artifact.status]} · ${artifact.authorRole}`,
        },
        h(
          'div',
          { className: 'devboard-detail' },
          h(ApprovalEntry, { data, board, role, setRole, type: 'artifact', id: artifact.id }),
          h(ArtifactPreview, { board, artifact }),
        ),
      ),
    gate &&
      h(
        PushPage,
        { id: 'gate', title: gateName(gate), description: gate.id },
        h(GatePanel, { key: gate.id, data, gate, board, role, setRole }),
      ),
    stage &&
      h(
        PushPage,
        { id: 'stage', title: `${stage.projectId} ${stageName(data, stage.projectId, stage.stage)}` },
        h(
          'div',
          { className: 'devboard-detail' },
          h(
            'dl',
            { className: 'devboard-facts' },
            fact('状态', stateBadge(data, stage.state)),
            fact('编写角色', stage.author),
            fact('基线', stage.baseline?.id),
          ),
          h(TransitionBar, {
            key: stage.id,
            data,
            kind: 'stage',
            item: stage,
            board,
            role,
            hidden: ['PASSED', 'REWORK'],
          }),
          h(HistoryTable, { data, history: stage.history }),
        ),
      ),
  )
}
