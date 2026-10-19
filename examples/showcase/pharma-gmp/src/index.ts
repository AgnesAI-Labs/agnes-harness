import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type ServiceContext, type ToolContext, toolPolicyKind } from '@agnes/extension-api'
import { type Context, defineAgnesPlugin, defineTool, toolError } from '@agnes/plugin-runtime'
import type {} from '@agnes/resource-control-runtime'
import { Type } from '@sinclair/typebox'
import { SIGNATURE_MEANING } from './model.js'
import { qualityPolicy } from './policy.js'
import { dashboard, dossier, investigation } from './quality.js'
import { change, read, release } from './records.js'
import { report } from './reports.js'
import {
  batchInput,
  changeInput,
  dossierSchema,
  empty,
  investigationSchema,
  plain,
  receiptSchema,
  releaseInput,
  snapshotSchema,
} from './schemas.js'

const who = (ctx: ToolContext) => ({
  actor: ctx.actor.id,
  session: ctx.session.key,
  ...(ctx.approval ? { approval: ctx.approval } : {}),
})
const serviceWho = (ctx: ServiceContext) => ({
  actor: ctx.actor.id,
  session: ctx.session?.key ?? null,
  ...(ctx.admission?.approval ? { approval: ctx.admission.approval } : {}),
})
const meta = (write = false, approve = false) => ({
  isReadOnly: !write,
  isDestructive: approve,
  isConcurrencySafe: !write,
  isOpenWorld: false,
  replay: write ? ('never' as const) : ('safe' as const),
  requiresApproval: approve ? ('always' as const) : ('never' as const),
  deferLoading: false as const,
})
const result = <T>(output: T) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(output) }],
  structured: output,
})
const failure = (error: unknown, ctx: ToolContext) => {
  ctx.signal.throwIfAborted()
  return toolError(error instanceof Error ? error.message : String(error))
}
export const inspect = defineTool({
  name: 'pharma_inspect',
  description:
    'Inspect a batch, CPP/ALCOA+ findings, linked EM/equipment and affected batches. Read-only. / 读取批次、限度、签名、EM、设备及影响范围。',
  parameters: batchInput,
  result: investigationSchema,
  meta: meta(),
  async execute(input, ctx) {
    ctx.signal.throwIfAborted()
    try {
      return result(investigation(read(ctx.store), input.batch))
    } catch (e) {
      return failure(e, ctx)
    }
  },
})
export const checklist = defineTool({
  name: 'pharma_dossier',
  description:
    'Build release checklist at an exact revision; explain every blocker. / 按当前版本构建放行清单并解释阻断项。',
  parameters: batchInput,
  result: dossierSchema,
  meta: meta(),
  async execute(input, ctx) {
    ctx.signal.throwIfAborted()
    try {
      return result(dossier(read(ctx.store), input.batch))
    } catch (e) {
      return failure(e, ctx)
    }
  },
})
export const record = defineTool({
  name: 'pharma_record',
  description:
    'Human-reviewed quality record: review BPR, investigate deviation, or advance the explicitly synthetic evidence scenario (investigation → CAPA → effectiveness → closed). Read latest revision first. Never invent real evidence. / 人工审核后复核批记录、调查偏差或录入明确的合成场景证据。',
  parameters: changeInput,
  result: receiptSchema,
  meta: { ...meta(true, true), isDestructive: false },
  async execute(input, ctx) {
    ctx.signal.throwIfAborted()
    try {
      const p = change(ctx.store, input, who(ctx))
      return result({ revision: p.revision, batch: input.batch, dossier: dossier(p, input.batch) })
    } catch (e) {
      return failure(e, ctx)
    }
  },
})
export const releaseTool = defineTool({
  name: 'pharma_release',
  description:
    'Consequential QA batch release. Requires exact dossier revision, signature meaning and Host-issued human approval; never self-authorize. / QA 批次放行：须精确版本、签名含义和宿主人工批准凭证。',
  parameters: releaseInput,
  result: receiptSchema,
  meta: meta(true, true),
  async execute(input, ctx) {
    ctx.signal.throwIfAborted()
    try {
      const p = release(ctx.store, input, who(ctx))
      return result({ revision: p.revision, batch: input.batch, dossier: dossier(p, input.batch) })
    } catch (e) {
      return failure(e, ctx)
    }
  },
})
export const reports = defineTool({
  name: 'pharma_report',
  description:
    'Generate Markdown + print HTML dossier, APQR section, deviation trend or nightly EM report, then present the files. / 生成 Markdown 与可打印 HTML 档案、APQR 节选、偏差或夜间 EM 趋势并展示。',
  parameters: Type.Object(
    {
      kind: Type.Union([
        Type.Literal('dossier'),
        Type.Literal('apqr'),
        Type.Literal('deviations'),
        Type.Literal('em'),
      ]),
      batch: Type.Optional(Type.String({ pattern: '^B-[0-9]{4}-[0-9]{3}$' })),
      locale: Type.Union([Type.Literal('zh-CN'), Type.Literal('en')]),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      title: Type.String(),
      revision: Type.Integer(),
      files: Type.Array(Type.String(), { minItems: 2, maxItems: 2 }),
    },
    { additionalProperties: false },
  ),
  meta: meta(true),
  async execute(input, ctx) {
    ctx.signal.throwIfAborted()
    try {
      const p = read(ctx.store),
        document = report(p, input.kind, input.batch ?? 'B-2410-017', input.locale)
      const stem = `pharma-output/${input.kind}-${input.batch ?? 'plant'}-r${p.revision}-${input.locale}-${randomUUID()}`
      const files = [`${stem}.md`, `${stem}.html`]
      await ctx.fs.write(files[0]!, document.markdown)
      ctx.signal.throwIfAborted()
      await ctx.fs.write(files[1]!, document.html)
      ctx.signal.throwIfAborted()
      const presented = await ctx.tools.invoke(
        'present',
        { files: files.map((path) => ({ path })) },
        { signal: ctx.signal },
      )
      if (presented.isError) return toolError('Deliverable presentation failed / 交付物展示失败')
      return result({ title: document.title, revision: p.revision, files })
    } catch (e) {
      return failure(e, ctx)
    }
  },
})
export const main = defineAgnesPlugin({
  inject: ['tools', 'services', 'skills', 'providers'],
  apply(ctx: Context) {
    ctx.providers.register(toolPolicyKind, {
      ...qualityPolicy,
      async decide(input, signal, ports) {
        const base = await ctx.providers.resolve(toolPolicyKind, 'default').decide(input, signal, ports)
        if (base.effect === 'deny') return base
        return ['pharma_release', 'pharma_record', 'pharma_report'].includes(input.call.name)
          ? qualityPolicy.decide(input, signal, ports)
          : base
      },
    })
    for (const tool of [inspect, checklist, record, releaseTool, reports]) ctx.tools.register(tool)
    ctx.skills.register({
      name: 'gmp-review',
      description:
        'GMP batch review, risk investigation and release playbook / GMP 批记录、风险调查与放行规程',
      body: readFileSync(new URL('../skills/gmp-review/SKILL.md', import.meta.url), 'utf8'),
    })
    const common = { scope: 'profile' as const, timeoutMs: 10000, maxResultBytes: 1048576 }
    ctx.services.register({
      ...common,
      name: 'pharma.snapshot',
      kind: 'query',
      inputSchema: plain(empty),
      outputSchema: plain(snapshotSchema),
      async handler(_input, context) {
        context.signal.throwIfAborted()
        const plant = read(context.store)
        return JSON.parse(
          JSON.stringify({
            plant,
            kpi: dashboard(plant),
            dossiers: plant.batches.map((b) => dossier(plant, b.id)),
          }),
        )
      },
    })
    ctx.services.register({
      ...common,
      name: 'pharma.change',
      kind: 'effect',
      inputSchema: plain(changeInput),
      outputSchema: plain(receiptSchema),
      effectPolicy: {
        isDestructive: false,
        isOpenWorld: false,
        replay: 'never',
        requiresApproval: 'always',
        approvalScopes: [],
      },
      async handler(value, context) {
        context.signal.throwIfAborted()
        const p = change(context.store, value as unknown as Parameters<typeof change>[1], serviceWho(context))
        const batch = (value as { batch: string }).batch
        return JSON.parse(JSON.stringify({ revision: p.revision, batch, dossier: dossier(p, batch) }))
      },
    })
    ctx.services.register({
      ...common,
      name: 'pharma.release',
      kind: 'effect',
      inputSchema: plain(releaseInput),
      outputSchema: plain(receiptSchema),
      effectPolicy: {
        isDestructive: true,
        isOpenWorld: false,
        replay: 'never',
        requiresApproval: 'always',
        approvalScopes: [],
      },
      async prepare(value, context) {
        const input = value as unknown as Parameters<typeof release>[1]
        const check = dossier(read(context.store), input.batch)
        if (input.expectedRevision !== check.revision) throw new Error('Stale dossier / 档案已变化')
        if (!check.ready || input.meaning !== SIGNATURE_MEANING)
          throw new Error(
            'Release prerequisites or signature meaning not satisfied / 放行条件或签名含义不满足',
          )
        return {
          input: value,
          presentation: JSON.parse(JSON.stringify({ meaning: input.meaning, checklist: check })),
          resourceRevision: String(check.revision),
        }
      },
      async handler(value, context) {
        context.signal.throwIfAborted()
        const input = value as unknown as Parameters<typeof release>[1]
        const p = release(context.store, input, serviceWho(context))
        return JSON.parse(
          JSON.stringify({ revision: p.revision, batch: input.batch, dossier: dossier(p, input.batch) }),
        )
      },
    })
  },
})
/** Session-only evidence cards; no profile store or authority is exposed to this row. */
export const cards = defineAgnesPlugin({ apply() {} })
