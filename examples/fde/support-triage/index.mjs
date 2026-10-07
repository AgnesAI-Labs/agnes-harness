import { readFileSync } from 'node:fs'
import { Type } from '@sinclair/typebox'
import { isDemo, makeBundle, modelText, tool, value, writeMeta } from './runtime.mjs'

const tickets = JSON.parse(readFileSync(new URL('./fixtures/tickets.json', import.meta.url)))
const object = (fields) => Type.Object(fields, { additionalProperties: false })
const get = (id) => {
  const ticket = tickets.find((t) => t.id === id)
  if (!ticket) throw new Error('Unknown ticket')
  return ticket
}
export const tools = [
  tool('fde_support_ticket', 'Read one synthetic customer ticket.', object({ id: Type.String() }), ({ id }) =>
    get(id),
  ),
  tool(
    'fde_support_classify',
    'Classify by reviewed rules; outages go to incident response.',
    object({ id: Type.String() }),
    ({ id }) => {
      const t = get(id)
      return {
        id,
        category: /unavailable|outage/i.test(t.text) ? 'incident' : 'billing',
        priority: /unavailable|outage/i.test(t.text) ? 'urgent' : 'normal',
      }
    },
  ),
  tool(
    'fde_support_send',
    'After human approval, simulate sending the exact reviewed draft. No external message is sent.',
    object({ id: Type.String(), draft: Type.String({ minLength: 1, maxLength: 4000 }) }),
    ({ id, draft }) => {
      get(id)
      return { ticketId: id, draft, status: 'simulated-sent', receipt: `support:${id}` }
    },
    writeMeta,
  ),
]
const stages = [
  {
    name: 'triage',
    async run(ctx, _state, signal) {
      const ticket = value(await ctx.tools.execute({ name: tools[0].name, args: { id: 'T-100' } }, signal))
      const classification = value(
        await ctx.tools.execute({ name: tools[1].name, args: { id: ticket.id } }, signal),
      )
      return { ticket, classification }
    },
  },
  {
    name: 'draft',
    async run(ctx, state, signal) {
      const suggestion = await modelText(
        ctx,
        'Draft a concise support reply. State the escalation, do not promise refunds or invent a fix. Return only the reply.',
        state.data,
        signal,
      )
      return {
        draft: (await isDemo(ctx))
          ? 'We received your outage report and escalated it to incident response. We will share the next verified update.'
          : suggestion,
      }
    },
  },
  {
    name: 'approve-and-send',
    confirm: (state) =>
      `Send the reviewed reply for ${state.data.ticket.id}? Review the complete draft deliverable before proceeding.`,
    async run(ctx, state, signal) {
      return {
        receipt: value(
          await ctx.tools.execute(
            { name: tools[2].name, args: { id: state.data.ticket.id, draft: state.data.draft } },
            signal,
          ),
        ),
      }
    },
  },
]
export const { main, factory, createFactory, policy } = makeBundle({ name: 'support-triage', tools, stages })
