import { Banner, Button, Drawer, Field, Select, Tag } from '@agnes/web-ui'
import React from 'react'
import { confirmationLabel } from './i18n.js'
import { col, section, status, table } from './views.js'
import { WorkButton } from './workbench.js'

const h = React.createElement
function approvalRecords(data, ids, t) {
  return ids.map((id) => {
    const proof = data.audit.find((entry) => entry.approval === id)
    return h(
      'p',
      { key: id, 'data-business-confirmation': true },
      `${confirmationLabel(proof?.confirmationMode, proof?.signer ?? '—', t.zh ? 'zh-CN' : 'en')} · ${id}`,
    )
  })
}
export function Mrb({ data, t, op }) {
  const [selected, setSelected] = React.useState(null),
    [disposition, setDisposition] = React.useState('rework'),
    [rationale, setRationale] = React.useState('')
  const r = data.ncrs.find((r) => r.id === selected)
  return h(
    React.Fragment,
    null,
    h(
      'div',
      { className: 'aero-board' },
      ...['open', 'review', 'dispositioned', 'closed'].map((state) =>
        section(
          t.status(state),
          h(
            'div',
            null,
            ...data.ncrs
              .filter((r) => r.status === state)
              .map((r) =>
                h(
                  'article',
                  { key: r.id, className: 'aero-ncr' },
                  h('div', { className: 'aero-row' }, h('code', null, r.id), status(t, r.severity)),
                  h('h3', null, t.value(r.title)),
                  ...approvalRecords(data, r.approvals, t),
                  h(
                    'p',
                    null,
                    `${r.lot} · ${Math.floor((Date.parse('2026-10-20') - Date.parse(r.opened)) / 86400000)} ${t.choose('天', 'days')}`,
                  ),
                  h(
                    Button,
                    {
                      onClick: () => {
                        setSelected(r.id)
                        setDisposition(r.disposition ?? 'rework')
                        setRationale(r.rationale)
                      },
                    },
                    t.detail,
                  ),
                  h(WorkButton, { action: 'mrb', object: { type: 'ncr', id: r.id }, t }),
                ),
              ),
          ),
        ),
      ),
    ),
    h(
      Drawer,
      {
        open: Boolean(r),
        onClose: () => setSelected(null),
        title: r?.id ?? 'NCR',
        closeLabel: t.close,
        description: r && t.value(r.title),
      },
      r &&
        h(
          React.Fragment,
          null,
          h('p', null, t.value(r.signature)),
          ...approvalRecords(data, r.approvals, t),
          h('p', null, `${t.evidence}: ${r.evidence.join(', ')}`),
          h(
            Banner,
            { tone: 'warning' },
            t.choose(
              '处置须人工 MRB 批准。返工不等于修理；批准后保持隔离，等待实施和复验。',
              'Human MRB approval required. Rework differs from repair; approved units stay on hold pending execution and re-verification.',
            ),
          ),
          h(
            Field,
            { label: t.choose('处置方案', 'Disposition') },
            h(Select, {
              value: disposition,
              disabled: op.disabled || !['open', 'review'].includes(r.status),
              onChange: setDisposition,
              options: ['use-as-is', 'rework', 'repair', 'scrap', 'return-to-supplier'].map((value) => ({
                value,
                label: t.status(value),
              })),
            }),
          ),
          h(
            Field,
            {
              label: t.choose(
                '依据与受影响范围（至少 20 字符）',
                'Rationale and affected scope (20+ characters)',
              ),
            },
            h('textarea', {
              rows: 5,
              maxLength: 2000,
              value: rationale,
              disabled: op.disabled,
              onChange: (e) => setRationale(e.target.value),
            }),
          ),
          h(
            'div',
            { className: 'aero-actions' },
            h(
              Button,
              {
                disabled:
                  op.disabled || rationale.trim().length < 20 || !['open', 'review'].includes(r.status),
                onClick: () =>
                  op.change('aero.draft', {
                    ncrId: r.id,
                    disposition,
                    rationale,
                    expectedRevision: data.revision,
                  }),
              },
              t.choose('保存审理草案', 'Save MRB draft'),
            ),
            h(
              Button,
              {
                appearance: 'primary',
                disabled: op.disabled || r.status !== 'review' || !r.rationale,
                onClick: () =>
                  op.change('aero.decide', { kind: 'mrb', id: r.id, expectedRevision: data.revision }),
              },
              t.choose('请求人工 MRB 审批', 'Request human MRB approval'),
            ),
          ),
          h(
            'p',
            null,
            `${t.choose('宿主审批记录', 'Host approval records')}: ${r.approvals.join(', ') || '—'}`,
          ),
        ),
    ),
  )
}
export function Configuration({ data, t, op, ctx }) {
  const [ecrId, setEcrId] = React.useState('ECR-016'),
    [analysis, setAnalysis] = React.useState(null),
    [error, setError] = React.useState('')
  React.useEffect(() => {
    let live = true
    setAnalysis(null)
    setError('')
    const selected = data.ecrs.find((ecr) => ecr.id === ecrId)
    if (!selected) return
    ctx.profile.services.query('aero.impact', { ecrId: selected.id }).then(
      (r) => {
        if (live) setAnalysis(r)
      },
      (e) => {
        if (live) setError(e.message)
      },
    )
    return () => {
      live = false
    }
  }, [ecrId, data, ctx.profile.services])
  return h(
    React.Fragment,
    null,
    section(
      t.choose('受控基线', 'Controlled baselines'),
      h(
        'div',
        { className: 'aero-baselines' },
        ...data.baselines.map((b) =>
          h(
            'article',
            { key: b.id },
            h('code', null, b.id),
            status(t, b.status),
            h('p', null, b.units.join(' · ')),
            h('small', null, b.source),
          ),
        ),
      ),
    ),
    section(
      t.choose('工程更改', 'Engineering changes'),
      table(
        t.choose('ECR 清单', 'ECR register'),
        [
          col('ID', 'id', {
            render: (v) => h(Button, { onClick: () => setEcrId(v), 'aria-pressed': ecrId === v }, v),
          }),
          col(t.choose('操作', 'Work'), 'id', {
            key: 'work',
            render: (id) => h(WorkButton, { action: 'configuration', object: { type: 'ecr', id }, t }),
          }),
          col(t.choose('变更', 'Change'), 'title', { render: t.value, width: 330 }),
          col(t.choose('基线', 'Baseline'), 'from', { render: (_, r) => `${r.from} → ${r.to}` }),
          col(t.choose('状态', 'Status'), 'status', { render: (v) => status(t, v) }),
          col(t.choose('确认方式', 'Confirmation mode'), 'approvals', {
            render: (ids) => approvalRecords(data, ids, t),
            width: 330,
          }),
        ],
        data.ecrs,
        t,
      ),
    ),
    section(
      `${ecrId} · ${t.choose('影响分析', 'Impact analysis')}`,
      h(
        React.Fragment,
        null,
        error && h(Banner, { tone: 'error' }, error),
        analysis
          ? h(
              React.Fragment,
              null,
              ...approvalRecords(data, analysis.ecr.approvals, t),
              h(
                'div',
                {
                  className: 'aero-impact',
                  role: 'group',
                  'aria-label': t.choose('更改影响图', 'Change impact graph'),
                },
                ...[
                  [ecrId, t.choose('更改源', 'Change source')],
                  [analysis.requirements.join(' · '), t.choose('需求', 'Requirements')],
                  [analysis.interfaces.join(' · '), t.choose('接口', 'Interfaces')],
                  [analysis.tests.join(' · '), t.choose('复验', 'Re-verification')],
                ].map(([v, label]) =>
                  h('div', { key: label }, h('small', null, label), h('strong', null, v)),
                ),
              ),
              h(
                Banner,
                { tone: analysis.screeningRequired ? 'warning' : 'info' },
                analysis.screeningRequired
                  ? t.choose(
                      `已审规则 v${analysis.ruleVersion}：必须追加批次热真空筛选。`,
                      `Reviewed rule v${analysis.ruleVersion}: additional lot TVAC screening required.`,
                    )
                  : t.choose(
                      '规则尚未启用；现有复验影响仍须评审。',
                      'Screening rule is inactive; existing re-verification impacts still require review.',
                    ),
              ),
              h(
                Button,
                {
                  appearance: 'primary',
                  disabled: op.disabled || analysis.ecr.status !== 'review',
                  onClick: () =>
                    op.change('aero.decide', {
                      kind: 'configuration',
                      id: ecrId,
                      expectedRevision: data.revision,
                    }),
                },
                t.choose('请求技术状态更改审批', 'Request configuration approval'),
              ),
            )
          : h('p', { role: 'status' }, t.loading),
      ),
    ),
    section(
      t.choose('供应链与优选器件', 'Supply chain and preferred parts'),
      table(
        t.choose('器件清单', 'Parts register'),
        [
          col('ID', 'id'),
          col(t.choose('器件', 'Part'), 'title', { render: t.value }),
          col(t.choose('等级', 'Grade'), 'grade', { render: (v) => v.split(' / ')[t.zh ? 1 : 0] }),
          col(t.choose('供应商 / 批次', 'Supplier / lot'), 'supplier', {
            render: (_, r) => `${t.value(r.supplier)} · ${r.lot}`,
          }),
          col(t.choose('风险 / 优选', 'Risk / preferred'), 'id', {
            key: 'risk',
            render: (_, r) =>
              r.counterfeitRisk
                ? h(Tag, { tone: 'bad' }, t.choose('假冒风险', 'Counterfeit risk'))
                : r.obsolete
                  ? h(Tag, { tone: 'warn' }, t.choose('停产风险', 'Obsolescence'))
                  : t.choose(
                      r.preferred ? '优选清单' : '非优选',
                      r.preferred ? 'Preferred list' : 'Non-preferred',
                    ),
          }),
          col(t.choose('状态', 'Status'), 'status', { render: (v) => status(t, v) }),
        ],
        data.parts,
        t,
      ),
    ),
  )
}
export function Zeroing({ data, t, op }) {
  const z = data.zeroing[0]
  return h(
    React.Fragment,
    null,
    ...data.zeroing.map((item) =>
      h(WorkButton, { key: item.id, action: 'report', object: { type: 'zeroing', id: item.id }, t }),
    ),
    h(
      Banner,
      { tone: 'warning' },
      t.choose(
        'ZR-001 尚有 7 项证据待补。报告保持草案；不能以批准处置替代归零证据。',
        'ZR-001 has 7 evidence criteria open. Reports remain drafts; disposition approval cannot substitute for closure evidence.',
      ),
    ),
    h(
      'div',
      { className: 'aero-grid' },
      ...['T', 'M'].map((group) =>
        section(
          t.choose(
            group === 'T' ? '技术五条' : '管理五条',
            group === 'T' ? 'Five technical criteria' : 'Five management criteria',
          ),
          h(
            'ol',
            { className: 'aero-criteria' },
            ...z.criteria
              .filter((c) => c.id.startsWith(group))
              .map((c) =>
                h(
                  'li',
                  { key: c.id },
                  h(
                    'div',
                    { className: 'aero-row' },
                    h('strong', null, `${c.id} · ${t.value(c.title)}`),
                    status(t, c.accepted ? 'approved' : 'pending'),
                  ),
                  h(
                    'small',
                    null,
                    c.evidence.join(', ') || t.choose('待补充受审证据', 'Reviewed evidence required'),
                  ),
                ),
              ),
          ),
        ),
      ),
    ),
    section(
      t.choose('可复用技能候选 · TVAC-LOT-001', 'Reusable skill candidate · TVAC-LOT-001'),
      h(
        React.Fragment,
        null,
        status(t, data.rule.status),
        h('p', null, data.rule.body.split(' / ')[t.zh ? 1 : 0]),
        ...approvalRecords(data, data.rule.approval ? [data.rule.approval] : [], t),
        h(
          'div',
          { className: 'aero-actions' },
          h(
            Button,
            {
              disabled: op.disabled || data.rule.status !== 'absent',
              onClick: () => op.change('aero.propose', { expectedRevision: data.revision }),
            },
            t.choose('提议筛选技能候选', 'Propose screening skill candidate'),
          ),
          h(
            Button,
            {
              appearance: 'primary',
              disabled: op.disabled || data.rule.status !== 'review',
              onClick: () =>
                op.change('aero.decide', {
                  kind: 'rule',
                  id: 'TVAC-LOT-001',
                  expectedRevision: data.revision,
                }),
            },
            t.choose('请求人工审核并启用', 'Request human review and activation'),
          ),
        ),
        h(
          'p',
          null,
          t.choose(
            '批准后，技术状态页下一次分析显示规则版本并要求追加热真空筛选。此受审领域技能不自动安装代码。',
            'After approval, the next configuration analysis shows the rule version and requires additional TVAC screening. This reviewed domain skill does not install code.',
          ),
        ),
      ),
    ),
    section(
      t.choose('报告与审计', 'Reports and audit'),
      h(
        React.Fragment,
        null,
        h(
          'p',
          null,
          t.choose(
            '在研制质量助手中请求“生成归零报告”，aero_report 生成 Markdown 与可打印 HTML，并用 present 展示。每周摘要自动化使用相同交付链。',
            'Ask Programme Quality Assistant to generate a zeroing report. aero_report produces Markdown and printable HTML via present. The weekly digest uses the same delivery path.',
          ),
        ),
        table(
          t.choose('审批与证据审计', 'Approval and evidence audit'),
          [
            col(t.choose('修订', 'Revision'), 'revision'),
            col(t.choose('时间', 'Time'), 'at'),
            col(t.choose('动作', 'Action'), 'action'),
            col(t.choose('对象', 'Subject'), 'subject'),
            col(t.choose('签署人', 'Signer'), 'signer', { render: (v) => v || '—' }),
            col(t.choose('确认方式', 'Confirmation mode'), 'confirmationMode', {
              render: (mode, entry) =>
                entry.approval ? confirmationLabel(mode, entry.signer ?? '—', t.zh ? 'zh-CN' : 'en') : '—',
              width: 330,
            }),
            col(t.choose('宿主审批', 'Host approval'), 'approval', { render: (v) => v || '—' }),
          ],
          data.audit,
          t,
        ),
      ),
    ),
    z.closure &&
      h(
        'p',
        null,
        `${confirmationLabel(z.closure.confirmationMode, z.closure.signer, t.zh ? 'zh-CN' : 'en')} · ${z.closure.decisionId}`,
      ),
    h(
      Button,
      {
        disabled: op.disabled || z.status === 'closed',
        onClick: () =>
          op.change('aero.decide', { kind: 'zeroing', id: z.id, expectedRevision: data.revision }),
      },
      t.choose('请求归零关闭审查', 'Request zeroing closure review'),
    ),
  )
}
