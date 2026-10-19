import { readFileSync } from 'node:fs'
import type { OwnedStore, ServiceContext, ToolContext } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin, defineTool, toolError } from '@agnes/plugin-runtime'
import { type Static, type TSchema, Type } from '@sinclair/typebox'
import { briefing } from './briefing.js'
import { sign } from './signature.js'

export { reviewPolicyPlugin } from './policy.js'

import { coverage, decide, draft, health, impact, investigate, propose, read } from './domain.js'
import { report } from './reports.js'

const strict = { additionalProperties: false } as const
const id = Type.String({ minLength: 1, maxLength: 64 })
const revision = Type.Integer({ minimum: 1 })
export const empty = Type.Object({}, strict)
export const draftSchema = Type.Object(
  {
    ncrId: id,
    disposition: Type.Union([
      Type.Literal('use-as-is'),
      Type.Literal('rework'),
      Type.Literal('repair'),
      Type.Literal('scrap'),
      Type.Literal('return-to-supplier'),
    ]),
    rationale: Type.String({ minLength: 20, maxLength: 2000 }),
    expectedRevision: revision,
  },
  strict,
)
export const decisionSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('mrb'),
      Type.Literal('configuration'),
      Type.Literal('rule'),
      Type.Literal('zeroing'),
    ]),
    id,
    expectedRevision: revision,
  },
  strict,
)
const candidateSchema = Type.Object({ expectedRevision: revision }, strict)
const outputSchema = Type.Object({ revision, data: Type.Unknown() }, strict)
const playbook = readFileSync(new URL('../skills/quality-playbook/SKILL.md', import.meta.url), 'utf8')
const json = (v: unknown) => JSON.parse(JSON.stringify(v))
function tool<S extends TSchema>(
  name: string,
  description: string,
  parameters: S,
  run: (input: Static<S>, ctx: ToolContext) => unknown | Promise<unknown>,
  mode: 'read' | 'draft' | 'decision' | 'report' = 'read',
) {
  return defineTool({
    name,
    description,
    parameters,
    result: outputSchema,
    meta: {
      isReadOnly: mode === 'read',
      isDestructive: mode === 'decision',
      isConcurrencySafe: mode === 'read',
      isOpenWorld: false,
      replay: mode === 'read' ? 'safe' : 'never',
      requiresApproval: mode === 'decision' ? 'always' : 'never',
    },
    async execute(input, ctx) {
      ctx.signal.throwIfAborted()
      try {
        const data = await run(input, ctx)
        const output = { revision: read(ctx.store).revision, data: json(data) }
        return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structured: output }
      } catch (error) {
        const code = (error as { message?: unknown } | null)?.message
        return toolError(
          error instanceof Error
            ? error.message
            : typeof code === 'string' && /^SKILL_[A-Z_]+$/.test(code)
              ? code
              : String(error),
        )
      }
    },
  })
}
export const tools = [
  tool(
    'aero_playbook',
    'Read the aerospace quality playbook before work / 工作前读取研制质量技能。',
    empty,
    () => ({ name: 'aerospace-quality-playbook', body: playbook }),
  ),
  tool(
    'aero_trace',
    'Requirement/design/test coverage, orphan and untested gaps / 需求—设计—试验追溯及缺口。',
    empty,
    (_i, c) => ({ health: health(read(c.store)), matrix: coverage(read(c.store)) }),
  ),
  tool(
    'aero_investigate',
    'Investigate AN-027 using measured limits, lot change and NCR evidence. Hypotheses are not confirmed causes / 依据实测限值、批次更改和 NCR 诊断异常，假设不等于原因。',
    Type.Object({ anomalyId: Type.Literal('AN-027') }, strict),
    (_i, c) => investigate(read(c.store)),
  ),
  tool(
    'aero_briefing',
    'Publish a data-only Intelligent UI evidence chart and table in the conversation/workbench / 在会话与工作台发布结构化证据图表。',
    Type.Object({ locale: Type.Union([Type.Literal('zh-CN'), Type.Literal('en')]) }, strict),
    async (i, c) => {
      const surface = briefing(read(c.store), i.locale)
      const result = await c.tools.invoke('ui_render', { surface: json(surface) }, { signal: c.signal })
      if (result.isError) throw new Error('证据简报发布失败 / Evidence briefing publication failed')
      return {
        surfaceId: surface.id,
        revision: surface.revision,
        evidence: investigate(read(c.store)).evidence,
      }
    },
    'draft',
  ),
  tool(
    'aero_change_review',
    'Analyze ECR requirement/interface/test impact and the currently approved screening rule / 分析更改影响及已批准的筛选规则。',
    Type.Object({ ecrId: id }, strict),
    (i, c) => impact(read(c.store), i.ecrId),
  ),
  tool(
    'aero_quality',
    'Read programme dashboard, double-five evidence, supply chain or audit / 查看质量总览、双五条、供应链或审计。',
    Type.Object(
      {
        view: Type.Union([
          Type.Literal('dashboard'),
          Type.Literal('zeroing'),
          Type.Literal('parts'),
          Type.Literal('audit'),
        ]),
      },
      strict,
    ),
    (i, c) => {
      const s = read(c.store)
      return i.view === 'dashboard'
        ? health(s)
        : i.view === 'zeroing'
          ? s.zeroing
          : i.view === 'parts'
            ? s.parts
            : s.audit
    },
  ),
  tool(
    'aero_mrb_draft',
    'Draft an NCR disposition with evidence; no hardware released. Then request aero_decide and wait for human MRB / 起草处置，不放行硬件，随后请求人工 MRB。',
    draftSchema,
    (i, c) => draft(c.store, i),
    'draft',
  ),
  tool(
    'aero_rule_propose',
    'Propose TVAC-LOT-001 as an inactive reviewed skill candidate. Human approval is mandatory before use / 提议未启用的热真空筛选技能候选，使用前须人工批准。',
    candidateSchema,
    (i, c) => propose(c.store, i.expectedRevision),
    'draft',
  ),
  tool(
    'aero_skill_candidate',
    'Prepare, commit or inspect the actual Host-reviewed TVAC screening Skill candidate. Installation requires native human approval and takes effect next turn / 提交真实宿主技能候选，安装须原生人工审批，下一轮生效。',
    Type.Object(
      {
        action: Type.Union([
          Type.Literal('prepare'),
          Type.Literal('commit'),
          Type.Literal('status'),
          Type.Literal('cancel'),
        ]),
        proposalId: Type.Optional(id),
      },
      strict,
    ),
    async (i, c) => {
      if (!c.skillInstall)
        throw new Error('宿主技能安装端口不可用 / Host Skill installation port unavailable')
      if (i.action === 'prepare') {
        const s = read(c.store)
        if (s.rule.status === 'absent') throw new Error('请先提议规则候选 / Propose the rule candidate first')
        return c.skillInstall.request({
          action: 'prepare-content',
          name: 'aerospace-tvac-lot-screening',
          files: [
            {
              path: 'SKILL.md',
              content: `---\nname: aerospace-tvac-lot-screening\ndescription: Reviewed TVAC screening for thermally cycled lot substitutions / 热循环批次替换的受审热真空筛选。\n---\n\n${s.rule.body}\nEvidence / 依据: ${s.rule.evidence.join(', ')}\nUse aero_change_review, cite ruleVersion, request human aero_decide for configuration changes. Never claim a passing test without reviewed evidence. / 使用更改评审工具，引用规则版本；更改须人工批准，不能虚构试验通过。\n`,
            },
          ],
          scope: 'workspace',
          enable: true,
        })
      }
      if (!i.proposalId) throw new Error('需要 proposalId / proposalId required')
      return c.skillInstall.request({ action: i.action, proposalId: i.proposalId })
    },
    'draft',
  ),
  tool(
    'aero_decide',
    'Consequential human decision: MRB disposition, configuration change, reviewed rule activation or evidence-complete zeroing closure. Requires a separate human business signature and current revision / MRB、技术状态、规则启用与归零均要求独立人工业务签名和当前修订。',
    decisionSchema,
    async (i, c) => {
      const state = read(c.store)
      if (state.revision !== i.expectedRevision)
        throw new Error('Revision changed; review again / 数据已变化，请重新审阅')
      const record =
        i.kind === 'mrb'
          ? state.ncrs.find((row) => row.id === i.id)
          : i.kind === 'configuration'
            ? state.ecrs.find((row) => row.id === i.id)
            : i.kind === 'zeroing'
              ? state.zeroing.find((row) => row.id === i.id)
              : state.rule
      const meaning = {
        mrb: 'I approve this MRB disposition for implementation; hardware remains on hold pending verification. / 我批准实施本 MRB 处置；硬件保持隔离，等待复验。',
        configuration:
          'I approve this configuration change and its required verification, without claiming tests have passed. / 我批准本技术状态更改及所需验证，不宣称试验通过。',
        rule: 'I approve activation of this reviewed screening rule. / 我批准启用本次已审阅的筛选规则。',
        zeroing:
          'I confirm the complete reviewed evidence and approve quality closure. / 我确认完整的已审阅证据并批准质量归零关闭。',
      }[i.kind]
      const approval = await sign(c, { ...i, record }, meaning, i.id)
      return {
        ...decide(c.store, i, approval),
        signature: {
          decisionId: approval.requestId,
          signer: approval.answeredBy.id,
          signedAt: approval.signedAt,
          reviewedRevision: i.expectedRevision,
          purpose: 'business.confirm',
        },
      }
    },
    'decision',
  ),
  tool(
    'aero_report',
    'Generate Markdown and printable HTML evidence reports and internally present them as deliverables; do not guess paths or present before this tool returns / 生成并展示 Markdown 与可打印 HTML 证据报告。',
    Type.Object(
      {
        kind: Type.Union([Type.Literal('zeroing'), Type.Literal('digest')]),
        locale: Type.Union([Type.Literal('zh-CN'), Type.Literal('en')]),
      },
      strict,
    ),
    async (i, c) => {
      const result = report(read(c.store), i.kind, i.locale)
      const paths = []
      const reportId = crypto.randomUUID()
      for (const [extension, _mime, body] of [
        ['md', 'text/markdown', result.markdown],
        ['html', 'text/html', result.html],
      ] as const) {
        c.signal.throwIfAborted()
        const path = `aero-output/QVX-${i.kind}-r${result.revision}-${reportId}.${extension}`
        await c.fs.write(path, body)
        paths.push(path)
      }
      const presented = await c.tools.invoke(
        'present',
        {
          files: paths.map((path) => ({
            path,
            name: `${result.title}.${path.endsWith('.html') ? 'html' : 'md'}`,
          })),
        },
        { signal: c.signal },
      )
      if (presented.isError)
        throw new Error('报告已生成，但交付物展示失败 / Report generated but presentation failed')
      return {
        title: result.title,
        paths,
        status: i.kind === 'zeroing' ? 'draft-evidence-incomplete' : 'generated',
        revision: result.revision,
      }
    },
    'report',
  ),
]
const plain = (schema: TSchema) => json(schema)
const serviceCommon = {
  scope: 'profile' as const,
  timeoutMs: 5000,
  maxResultBytes: 524288,
  outputSchema: { type: 'object' },
}
const policy = (approval: boolean) => ({
  isDestructive: approval,
  isOpenWorld: false,
  replay: 'never' as const,
  requiresApproval: approval ? ('always' as const) : ('never' as const),
  approvalScopes: [],
})
export const main = defineAgnesPlugin({
  apply(ctx: Context) {
    for (const t of tools) ctx.tools.register(t)
    // Public runtime skill registration; no Host or official-package identity checks.
    const skills = (
      ctx as Context & {
        skills: { register(s: { name: string; description: string; body: string }): unknown }
      }
    ).skills
    skills.register({
      name: 'aerospace-quality-playbook',
      description:
        'Evidence-first traceability, MRB, configuration control and double-five zeroing / 证据优先的追溯、MRB、技术状态与双五条归零',
      body: playbook,
    })
    ctx.services.register({
      ...serviceCommon,
      name: 'aero.snapshot',
      kind: 'query',
      inputSchema: plain(empty),
      async handler(_i, c) {
        const s = read(c.store)
        return json({ ...s, health: health(s), matrix: coverage(s), anomaly: investigate(s) })
      },
    })
    ctx.services.register({
      ...serviceCommon,
      name: 'aero.impact',
      kind: 'query',
      inputSchema: plain(Type.Object({ ecrId: id }, strict)),
      async handler(i, c) {
        return json(impact(read(c.store), (i as { ecrId: string }).ecrId))
      },
    })
    function effect<S extends TSchema>(
      name: string,
      schema: S,
      approval: boolean,
      handler: (i: Static<S>, store: OwnedStore | undefined, c: ServiceContext) => unknown,
    ) {
      ctx.services.register({
        ...serviceCommon,
        name,
        kind: 'effect',
        inputSchema: plain(schema),
        effectPolicy: policy(approval),
        async prepare(input, c) {
          return {
            input,
            resourceRevision: String(read(c.store).revision),
            presentation: json({
              input,
              warning: 'Synthetic programme. Human review required / 合成项目，须人工审阅',
              revision: read(c.store).revision,
            }),
          }
        },
        async handler(input, c) {
          c.signal.throwIfAborted()
          return json(handler(input as Static<S>, c.store, c))
        },
      })
    }
    effect('aero.draft', draftSchema, false, (i, s) => draft(s, i))
    effect('aero.propose', candidateSchema, false, (i, s) => propose(s, i.expectedRevision))
    effect('aero.decide', decisionSchema, true, (i, s, c) => decide(s, i, c.admission?.approval))
  },
})

export const cards = defineAgnesPlugin({ apply() {} })
