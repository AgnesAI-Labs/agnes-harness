import { Badge, Button, Field, PushPage, Table, usePushStack } from '@agnes/web-ui'
import React from 'react'
import {
  byId,
  continueWork,
  day,
  fact,
  gateBadge,
  gateLabel,
  HistoryTable,
  h,
  Markdown,
  Meter,
  NoteField,
  ProjectSelect,
  pct,
  stateBadge,
  TransitionBar,
  time,
  useProject,
} from './board.js'

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
          title: `${data.labels.stage[s.stage]}：${data.labels.state[s.state]}`,
        },
        h('span', { className: 'devboard-stage-name' }, data.labels.stage[s.stage]),
        h('small', { className: 'devboard-stage-state' }, data.labels.state[s.state]),
      ),
    ),
  )
}

function NewProject({ board, role, onDone }) {
  const [name, setName] = React.useState('车门健康监测看板')
  const [description, setDescription] = React.useState(
    '智能运维平台的一个小切片：按线路、车辆、车门三级展示健康评分与故障排行，无依赖 Node 网页应用。',
  )
  const submit = async () => {
    const out = await board.run(
      'devboard.create',
      { kind: 'project', by: role, name: name.trim(), description: description.trim() },
      '已新建项目，请让研发协调员继续推进',
    )
    if (out?.result?.id) onDone(out.result.id)
  }
  return h(
    'section',
    { className: 'devboard-actions', 'aria-label': '新建项目' },
    h(
      Field,
      { label: '项目名称', htmlFor: 'devboard-new-name' },
      h('input', {
        id: 'devboard-new-name',
        className: 'devboard-note',
        value: name,
        maxLength: 120,
        onChange: (e) => setName(e.target.value),
      }),
    ),
    h(NoteField, {
      id: 'devboard-new-desc',
      label: '项目说明',
      value: description,
      onChange: setDescription,
    }),
    h(
      'div',
      { className: 'devboard-buttons' },
      h(
        Button,
        { appearance: 'primary', disabled: board.busy || !name.trim(), onClick: submit },
        '新建现场项目',
      ),
      h('span', { className: 'devboard-muted' }, '新建后立项阶段即开始；由研发协调员写计划并提交立项评审。'),
    ),
  )
}

export function Overview({ data, board, role }) {
  const push = usePushStack()
  const [created, setCreated] = React.useState('')
  const pending = pendingGates(data)
  const interventions = data.interventions.filter((i) => i.state === 'OPEN' || i.state === 'EXPIRED')
  const ccb = data.changes.filter((c) => c.state === 'CCB_REVIEW')
  const overdue = data.projects.filter((p) => p.metrics.overdue)
  return h(
    React.Fragment,
    null,
    overdue.length > 0 &&
      h(
        'p',
        { className: 'devboard-alert', role: 'alert' },
        `${overdue.map((p) => `${p.id} ${data.labels.stage[p.metrics.currentStage]}`).join('、')} 已超出计划完成日期。`,
      ),
    h(
      'div',
      { className: 'devboard-kpis' },
      [
        ['待决议评审门', pending.length],
        ['待处理人工介入', interventions.length],
        ['待 CCB 决议变更', ccb.length],
        ['在研项目', data.projects.filter((p) => p.metrics.passedStages < p.metrics.stageCount).length],
      ].map(([label, n]) =>
        h(
          'div',
          { className: 'devboard-kpi', key: label },
          h('strong', null, n),
          h('span', { className: 'devboard-kpi-label' }, label),
        ),
      ),
    ),
    h('div', { className: 'devboard-buttons' }, h(Button, { onClick: () => push.open('new') }, '新建项目')),
    h(
      'div',
      { className: 'devboard-projects' },
      data.projects.map((p) => {
        const m = p.metrics
        const gate = pending.find((g) => g.stageId.startsWith(`${p.id}/`))
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
              `${p.id} · ${data.labels.projectKind[p.kind] ?? p.kind}${p.live ? ' · 现场项目' : ''}`,
            ),
            h('h2', null, p.name),
            h(
              'span',
              { className: 'devboard-muted' },
              `${p.customer ?? ''}${p.safetyIntegrity ? ` · ${p.safetyIntegrity}` : ''}`,
            ),
          ),
          h(StageBar, { data, projectId: p.id }),
          h(
            'dl',
            { className: 'devboard-facts' },
            fact('当前阶段', `${data.labels.stage[m.currentStage]} · ${data.labels.state[m.currentState]}`),
            fact(
              '里程碑偏差',
              m.delayDays > 0
                ? `${m.overdue ? '超期' : '延后'} ${m.delayDays} 天`
                : `提前 ${-m.delayDays} 天`,
            ),
            fact('评审门', gate ? `${gate.id} 待 ${gate.approverRole} 决议` : '无待决议'),
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
              h('p', null, `已新建 ${created}。下一步：让研发协调员写项目计划并提交立项评审。`),
              h(
                Button,
                {
                  appearance: 'primary',
                  onClick: () => continueWork(board, { type: 'project', id: created }),
                },
                '让研发协调员继续推进',
              ),
            )
          : h(NewProject, { board, role, onDone: setCreated }),
      ),
    ),
  )
}

/** Gate decision form: the server applies the three rules; the page always lets the attempt through. */
export function GatePanel({ data, gate, board, role }) {
  const stage = byId(data.stages, gate.stageId)
  const [comment, setComment] = React.useState('')
  const [closing, setClosing] = React.useState({})
  const [decided, setDecided] = React.useState(false)
  const open = gate.findings.filter((f) => !f.closed)
  const decide = async (decision) => {
    const closeFindings = Object.entries(closing)
      .filter(([, note]) => note.trim())
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
      `${gate.id} 已${decision === 'APPROVED' ? '批准' : '驳回'}`,
    )
    if (ok) setDecided(true)
  }
  return h(
    'div',
    { className: 'devboard-detail' },
    h(
      'dl',
      { className: 'devboard-facts' },
      fact(
        '阶段',
        `${stage?.projectId} ${data.labels.stage[stage?.stage]}（${data.labels.state[stage?.state]}）`,
      ),
      fact('编写角色', stage?.author),
      fact('审批角色', gate.approverRole),
      fact('决议', gateBadge(data, gate.decision)),
      fact('审批人', gate.approver),
      fact('决议时间', time(gate.decidedAt)),
      fact('评审结论', gate.comment),
      fact('基线', stage?.baseline?.id),
    ),
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
    gate.decision === 'PENDING'
      ? h(
          'section',
          { className: 'devboard-actions', 'aria-label': '评审决议' },
          stage?.author === role &&
            h(Badge, { tone: 'warn' }, `当前演示角色「${role}」是该阶段的编写角色，批准会被拒绝。`),
          open.length > 0 &&
            h(
              'span',
              { className: 'devboard-muted' },
              `还有 ${open.length} 条意见未关闭：批准前需全部关闭（可在上表填写关闭说明）。`,
            ),
          h(NoteField, {
            id: `devboard-gate-${gate.id}`,
            label: '评审结论（驳回必填）',
            value: comment,
            onChange: setComment,
          }),
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
            'div',
            { className: 'devboard-buttons' },
            h(
              Button,
              {
                appearance: decided ? 'primary' : 'secondary',
                onClick: () => continueWork(board, { type: 'gate', id: gate.id }),
              },
              '继续推进',
            ),
            h('span', { className: 'devboard-muted' }, '打开研发协调员会话，草稿带上门编号，由你点发送。'),
          ),
          h(
            'div',
            { className: 'devboard-buttons' },
            h(
              Button,
              { disabled: board.busy, onClick: () => decide('APPROVED') },
              '再次批准（演示：应被拒绝）',
            ),
          ),
        ),
  )
}

export function ArtifactPreview({ board, artifact }) {
  const [doc, setDoc] = React.useState(null)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let live = true
    setDoc(null)
    setError('')
    board
      .query('devboard.artifact', { artifactId: artifact.id })
      .then((d) => live && (d.ok === false ? setError(d.error) : setDoc(d)))
      .catch((e) => live && setError(String(e?.message ?? e)))
    return () => {
      live = false
    }
  }, [artifact.id, artifact.updatedAt, board.query])
  return h(
    'div',
    { className: 'devboard-detail' },
    h(
      'p',
      { className: 'devboard-muted' },
      artifact.source?.type === 'workspace' ? `工作区文件：${artifact.source.path}` : '种子文档（包内）',
    ),
    error && h('p', { className: 'devboard-alert', role: 'alert' }, error),
    doc?.truncated && h('p', { className: 'devboard-muted' }, '文档较长，仅显示前 48 KB。'),
    doc ? h(Markdown, { text: doc.markdown }) : !error && h('p', { role: 'status' }, '正在读取文档…'),
  )
}

export function Projects({ data, board, role }) {
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
      { className: 'devboard-facts' },
      fact('客户', project.customer),
      fact('线路', project.line),
      fact('项目经理', project.manager),
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
    h(StageBar, { data, projectId: project.id }),
    h(Table, {
      captionRepeatsHeading: true,
      caption: '阶段时间线',
      rowKey: 'id',
      pagination: false,
      dataSource: stages,
      rowClassName: (s) =>
        s.state !== 'PASSED' &&
        s.plannedEnd &&
        Date.parse(s.plannedEnd) < Date.parse(data.now) &&
        s.state !== 'NOT_STARTED'
          ? 'devboard-overdue'
          : '',
      columns: [
        {
          title: '阶段',
          render: (_v, s) =>
            h(
              Button,
              { appearance: 'link', onClick: () => openPage('stage', s.id) },
              data.labels.stage[s.stage],
            ),
          width: 110,
        },
        { title: '状态', dataIndex: 'state', render: (v) => stateBadge(data, v), width: 90 },
        { title: '编写角色', dataIndex: 'author', width: 120 },
        { title: '计划完成', dataIndex: 'plannedEnd', render: day, width: 110 },
        { title: '实际完成', dataIndex: 'actualEnd', render: day, width: 110 },
        {
          title: '交付物',
          render: (_v, s) =>
            data.artifacts
              .filter((a) => a.projectId === project.id && a.stage === s.stage)
              .map((a) =>
                h(
                  Button,
                  { key: a.id, appearance: 'link', onClick: () => openPage('artifact', a.id) },
                  `${a.title} ${a.version}`,
                ),
              ),
        },
        {
          title: '评审门',
          render: (_v, s) =>
            gatesOf(data, s.id).map((g) =>
              h(
                Button,
                { key: g.id, appearance: 'link', onClick: () => openPage('gate', g.id) },
                `${g.id.split('-').slice(-2).join('-')} ${gateLabel(data, g.decision)}`,
              ),
            ),
          width: 180,
        },
        { title: '基线', render: (_v, s) => s.baseline?.id ?? '', width: 160 },
      ],
    }),
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
      '首件检验（FAI）、现场验收（SAT）、独立安全评估（ISA）与 FMEA/FTA 由外部/硬件环节完成，本工作台不建模。',
    ),
    artifact &&
      h(
        PushPage,
        {
          id: 'artifact',
          title: `${artifact.id} ${artifact.title}`,
          description: `${artifact.version} · ${data.labels.state[artifact.status]} · ${artifact.authorRole}`,
        },
        h(ArtifactPreview, { board, artifact }),
      ),
    gate &&
      h(
        PushPage,
        { id: 'gate', title: `${gate.id}` },
        h(GatePanel, { key: gate.id, data, gate, board, role }),
      ),
    stage &&
      h(
        PushPage,
        { id: 'stage', title: `${stage.projectId} ${data.labels.stage[stage.stage]}` },
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
