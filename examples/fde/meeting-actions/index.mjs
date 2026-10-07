import { readFileSync } from 'node:fs'
import { Type } from '@sinclair/typebox'
import { makeBundle, modelText, tool, value, writeMeta } from './runtime.mjs'

const transcript = readFileSync(new URL('./fixtures/transcript.txt', import.meta.url), 'utf8')
const action = Type.Object({
  owner: Type.String(),
  due: Type.String(),
  task: Type.String(),
  line: Type.Integer(),
})
const notes = Type.Object({
  summary: Type.Array(Type.String()),
  decisions: Type.Array(Type.String()),
  actions: Type.Array(action),
})
export const tools = [
  tool(
    'fde_meeting_extract',
    'Extract explicitly tagged evidence from the synthetic meeting transcript.',
    Type.Object({}),
    () => {
      const summary = [],
        decisions = [],
        actions = []
      transcript
        .trim()
        .split('\n')
        .forEach((text, index) => {
          if (text.startsWith('SUMMARY: ')) summary.push(text.slice(9))
          if (text.startsWith('DECISION: ')) decisions.push(text.slice(10))
          if (text.startsWith('ACTION: ')) {
            const [owner, due, ...task] = text.slice(8).split(' | ')
            if (!owner || !/^\d{4}-\d{2}-\d{2}$/.test(due) || !task.length)
              throw new Error('Action requires explicit owner, ISO date and task')
            actions.push({ owner, due, task: task.join(' | '), line: index + 1 })
          }
        })
      if (!summary.length || !actions.length) throw new Error('No explicit meeting evidence')
      return { summary, decisions, actions }
    },
  ),
  // TODO: use official present when available; this local tool exports a markdown payload.
  tool(
    'fde_meeting_export',
    'Export a markdown payload; no filesystem write or external message.',
    notes,
    (data) => ({
      filename: 'meeting-actions.md',
      mediaType: 'text/markdown',
      markdown:
        '# Meeting actions\n\n## Summary\n\n' +
        data.summary.map((line) => `- ${line}`).join('\n') +
        '\n\n## Decisions\n\n' +
        data.decisions.map((line) => `- ${line}`).join('\n') +
        '\n\n## Actions\n\n' +
        data.actions
          .map((item) => `- ${item.owner} — ${item.task} — due ${item.due} (transcript line ${item.line})`)
          .join('\n'),
    }),
  ),
  // TODO: prefer official ask_user_question for structured edits when it lands; policy owns send approval.
  tool(
    'fde_meeting_send',
    'After human approval, simulate sending the exported notes to the fixture team.',
    Type.Object({ markdown: Type.String({ minLength: 1 }) }),
    ({ markdown }) => ({
      receipt: { status: 'simulated-sent', recipient: 'fixture-team', markdown, externalDelivery: false },
    }),
    writeMeta,
  ),
]
const stages = [
  {
    name: 'extract',
    async run(ctx, _state, signal) {
      return { notes: value(await ctx.tools.execute({ name: tools[0].name, args: {} }, signal)) }
    },
  },
  {
    name: 'export',
    async run(ctx, state, signal) {
      const exported = value(await ctx.tools.execute({ name: tools[1].name, args: state.data.notes }, signal))
      return {
        exported,
        commentary: await modelText(
          ctx,
          'Explain the evidence-based meeting notes. Never assign missing owners/dates or change explicit decisions. The export is a review draft.',
          state.data.notes,
          signal,
        ),
      }
    },
  },
  {
    name: 'confirm-send',
    async run(ctx, state, signal) {
      return value(
        await ctx.tools.execute(
          { name: tools[2].name, args: { markdown: state.data.exported.markdown } },
          signal,
        ),
      )
    },
  },
]
export const { main, factory, createFactory, policy } = makeBundle({ name: 'meeting-actions', tools, stages })
