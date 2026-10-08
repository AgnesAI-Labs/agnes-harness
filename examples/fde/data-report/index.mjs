import { readFileSync } from 'node:fs'
import { Type } from '@sinclair/typebox'
import { makeBundle, modelText, tool, value } from './runtime.mjs'
export function parseCsv(text) {
  // Deliberately bounded dialect: no quoted/multiline fields. Reject rather than misread them.
  if (text.length > 65536 || text.includes('"')) throw new Error('Expected unquoted fixture CSV under 64 KiB')
  const [header, ...lines] = text.trim().split(/\r?\n/)
  if (header !== 'month,revenue,cost' || lines.length > 100)
    throw new Error('Expected month,revenue,cost header and at most 100 rows')
  return lines.map((line) => {
    const [month, revenue, cost, extra] = line.split(',')
    if (
      !/^\d{4}-\d{2}$/.test(month) ||
      extra !== undefined ||
      !revenue ||
      !cost ||
      !Number.isFinite(Number(revenue)) ||
      !Number.isFinite(Number(cost)) ||
      Number(revenue) < 0 ||
      Number(cost) < 0
    )
      throw new Error('Invalid CSV row')
    return { month, revenue: Number(revenue), cost: Number(cost) }
  })
}
const rowsSchema = Type.Array(
  Type.Object({
    month: Type.String({ pattern: '^\\d{4}-\\d{2}$' }),
    revenue: Type.Number({ minimum: 0 }),
    cost: Type.Number({ minimum: 0 }),
  }),
  { minItems: 1, maxItems: 100 },
)
export const tools = [
  tool(
    'fde_data_read',
    'Read demo fixture fixtures/sales.csv packaged with this bundle, not a workspace CSV. Fixed synthetic sales data; arbitrary paths are not accepted.',
    Type.Object({}),
    () => ({ rows: parseCsv(readFileSync(new URL('./fixtures/sales.csv', import.meta.url), 'utf8')) }),
  ),
  tool(
    'fde_data_analyze',
    'Calculate revenue, cost, profit and margin without model arithmetic.',
    Type.Object({ rows: rowsSchema }),
    ({ rows }) => {
      const revenue = rows.reduce((s, r) => s + r.revenue, 0),
        cost = rows.reduce((s, r) => s + r.cost, 0)
      return { rows, revenue, cost, profit: revenue - cost, margin: revenue ? (revenue - cost) / revenue : 0 }
    },
  ),
  tool(
    'fde_data_report',
    'Return markdown and HTML with an inline SVG chart. Does not write files.',
    Type.Object({
      rows: rowsSchema,
      revenue: Type.Number(),
      cost: Type.Number(),
      profit: Type.Number(),
      margin: Type.Number(),
    }),
    (data) => {
      const max = Math.max(1, ...data.rows.map((r) => r.revenue))
      const chart =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 ${data.rows.length * 40}" role="img" aria-label="Monthly revenue">` +
        data.rows
          .map(
            (r, i) =>
              `<text x="0" y="${i * 40 + 22}">${r.month}</text><rect x="90" y="${i * 40 + 4}" width="${(r.revenue / max) * 480}" height="24" fill="#2563eb"/><title>${r.month}: ${r.revenue}</title>`,
          )
          .join('') +
        '</svg>'
      const markdown =
        `# Sales report\n\nRevenue: ${data.revenue}\nCost: ${data.cost}\nProfit: ${data.profit}\nMargin: ${(data.margin * 100).toFixed(1)}%\n\n| Month | Revenue | Cost |\n| --- | ---: | ---: |\n` +
        data.rows.map((r) => `| ${r.month} | ${r.revenue} | ${r.cost} |`).join('\n')
      return {
        markdown,
        html: `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sales report</title><main><h1>Sales report</h1><p>Revenue: ${data.revenue}; profit: ${data.profit}</p>${chart}</main></html>`,
        chart,
      }
    },
  ),
]
const stages = [
  {
    name: 'read-csv',
    async run(ctx, _state, signal) {
      return value(await ctx.tools.execute({ name: tools[0].name, args: {} }, signal))
    },
  },
  {
    name: 'analyze',
    async run(ctx, state, signal) {
      return {
        analysis: value(
          await ctx.tools.execute({ name: tools[1].name, args: { rows: state.data.rows } }, signal),
        ),
      }
    },
  },
  {
    name: 'report',
    async run(ctx, state, signal) {
      const report = value(
        await ctx.tools.execute({ name: tools[2].name, args: state.data.analysis }, signal),
      )
      return {
        report,
        commentary: await modelText(
          ctx,
          'Explain the computed figures. Do not change totals or invent causes.',
          state.data.analysis,
          signal,
        ),
      }
    },
  },
]
export const { main, factory, createFactory, policy } = makeBundle({
  name: 'data-report',
  tools,
  stages,
  readOnly: true,
})
