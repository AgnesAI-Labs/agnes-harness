import { readFileSync } from 'node:fs'
import { Type } from '@sinclair/typebox'
import { makeBundle, modelText, tool, value, writeMeta } from './runtime.mjs'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const evidence = Type.Object({ skill: Type.String(), quote: Type.String() })
const candidate = Type.Object({ id: Type.String(), evidence: Type.Array(evidence) })
const biasNotes = [
  'Only explicit job-skill evidence is scored; names, age, gender and school are excluded.',
  'Missing evidence means unknown, not inability. Request consistent follow-up from every candidate.',
  'A person reviews the rubric, accessibility and evidence before any hiring decision. This fixture is not a fairness certification.',
]
export const tools = [
  tool(
    'fde_recruiting_resumes',
    'Read resumes and minimize them to candidate IDs and explicit skill evidence.',
    Type.Object({}),
    () => ({
      candidates: fixture('resumes.json').map(({ id, evidence }) => ({ id, evidence })),
      rubric: fixture('job.json'),
      biasNotes,
    }),
  ),
  tool(
    'fde_recruiting_score',
    'Assess a candidate against the packaged job rubric without protected attributes.',
    candidate,
    ({ id, evidence }) => {
      const rubric = fixture('job.json')
      const assessments = rubric.criteria.map(({ skill, weight }) => {
        const proof = evidence.find((item) => item.skill === skill && item.quote.trim())
        return { skill, weight, status: proof ? 'evidenced' : 'unknown', quote: proof?.quote ?? null }
      })
      return {
        id,
        assessments,
        score: assessments
          .filter((item) => item.status === 'evidenced')
          .reduce((sum, item) => sum + item.weight, 0),
        maxScore: rubric.criteria.reduce((sum, item) => sum + item.weight, 0),
      }
    },
  ),
  // Official ask_user_question confirms the human-review next step, never a hiring decision.
  tool(
    'fde_recruiting_decision',
    'After human confirmation, record a simulated request for consistent skill follow-up; no hiring or rejection.',
    Type.Object({
      candidateIds: Type.Array(Type.String(), { minItems: 1 }),
      nextStep: Type.Literal('human-skill-review'),
    }),
    ({ candidateIds, nextStep }) => ({
      receipt: { status: 'human-review-confirmed', candidateIds, nextStep, hiringDecision: false },
    }),
    writeMeta,
  ),
]
const stages = [
  {
    name: 'minimize-resumes',
    async run(ctx, _state, signal) {
      return value(await ctx.tools.execute({ name: tools[0].name, args: {} }, signal))
    },
  },
  {
    name: 'rubric-review',
    async run(ctx, state, signal) {
      const reviews = (
        await ctx.tools.batch(
          state.data.candidates.map((args) => ({ name: tools[1].name, args })),
          signal,
        )
      ).map(value)
      const report = {
        reviews,
        biasNotes,
        markdown:
          '# Recruiting evidence draft\n\n' +
          reviews
            .map(
              (item) =>
                `- ${item.id}: ${item.score}/${item.maxScore}; unknown: ${
                  item.assessments
                    .filter((entry) => entry.status === 'unknown')
                    .map((entry) => entry.skill)
                    .join(', ') || 'none'
                }`,
            )
            .join('\n'),
      }
      return {
        report,
        commentary: await modelText(
          ctx,
          'Explain only explicit skill evidence and unknowns. Do not infer protected attributes, rank personal worth, or decide hiring. Recommend consistent human follow-up for all candidates.',
          report,
          signal,
        ),
      }
    },
  },
  {
    name: 'human-decision',
    confirm: () =>
      'Confirm consistent human skill-review follow-up for all candidates? This does not hire or reject anyone.',
    async run(ctx, state, signal) {
      return value(
        await ctx.tools.execute(
          {
            name: tools[2].name,
            args: {
              candidateIds: state.data.candidates.map((item) => item.id),
              nextStep: 'human-skill-review',
            },
          },
          signal,
        ),
      )
    },
  },
]
export const { main, factory, createFactory, policy } = makeBundle({
  name: 'recruiting-screen',
  tools,
  stages,
})
