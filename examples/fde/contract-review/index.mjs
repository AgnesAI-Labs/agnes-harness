import { readFileSync } from 'node:fs'
import { Type } from '@sinclair/typebox'
import { makeBundle, modelText, tool, value } from './runtime.mjs'

const contract = readFileSync(new URL('./fixtures/contract.txt', import.meta.url), 'utf8')
const clause = Type.Object({ id: Type.String(), text: Type.String() }, { additionalProperties: false })
export const tools = [
  tool(
    'fde_contract_split',
    'Read bundled demo fixtures/contract.txt and split it into clauses, not a workspace contract.',
    Type.Object({}),
    () => ({
      clauses: contract
        .trim()
        .split(/\n\s*\n/)
        .map((text, i) => ({ id: `C-${i + 1}`, text })),
    }),
  ),
  tool(
    'fde_contract_review',
    'Review one clause against the fixture risk rubric.',
    clause,
    ({ id, text }) => ({
      id,
      text,
      risk: /unlimited|unilateral/i.test(text) ? 'high' : 'low',
      reason: /unlimited|unilateral/i.test(text)
        ? 'Unbounded exposure or one-sided changes'
        : 'Bounded obligation; confirm customer applicability',
    }),
  ),
  tool(
    'fde_contract_report',
    'Aggregate clause evidence into a read-only markdown risk report.',
    Type.Object({
      reviews: Type.Array(
        Type.Object({ id: Type.String(), text: Type.String(), risk: Type.String(), reason: Type.String() }),
      ),
    }),
    ({ reviews }) => ({
      highRisk: reviews.filter((r) => r.risk === 'high').map((r) => r.id),
      markdown:
        '# Contract risk review\n\n' +
        reviews.map((r) => `- **${r.id}: ${r.risk}** — ${r.reason}\n  Evidence: ${r.text}`).join('\n'),
    }),
  ),
]
const stages = [
  {
    name: 'split',
    async run(ctx, _state, signal) {
      return value(await ctx.tools.execute({ name: tools[0].name, args: {} }, signal))
    },
  },
  {
    name: 'parallel-review',
    async run(ctx, state, signal) {
      const reviews = (
        await ctx.tools.batch(
          state.data.clauses.map((args) => ({ name: tools[1].name, args })),
          signal,
        )
      ).map(value)
      return { reviews }
    },
  },
  {
    name: 'aggregate',
    async run(ctx, state, signal) {
      const report = value(
        await ctx.tools.execute({ name: tools[2].name, args: { reviews: state.data.reviews } }, signal),
      )
      const commentary = await modelText(
        ctx,
        'Explain the contract risk report using only the cited clauses. This is a review draft for a qualified reviewer.',
        report,
        signal,
      )
      return { report, commentary }
    },
  },
]
export const { main, factory, createFactory, policy } = makeBundle({
  name: 'contract-review',
  tools,
  stages,
  readOnly: true,
})
