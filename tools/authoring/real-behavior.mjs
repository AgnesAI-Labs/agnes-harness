import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createProvider, getApiKeyProvider, NullContractStore } from '@agnes/ai'
import {
  authoringContextGuidance,
  authoringGuidance,
} from '../../packages/package-manager/bundled-plugins/plugin-helper/src/authoring.mjs'
import { scoreContinuation } from './real-score.mjs'

// Single model responses, not an agent loop: synthetic refusals must never dispatch actual tools.
// Usage and estimated billing come from the same AGH provider facade used by the real sessions.
export async function runBehavior(rt) {
  const [providerId, ...modelParts] = (process.env.AGH_DEMO_MODEL ?? 'deepseek/deepseek-flash').split('/')
  const entry = getApiKeyProvider(providerId)
  assert.ok(entry, 'Unknown provider')
  const adapter = await entry.createAdapter({ maxRetries: 0 })
  const model = modelParts.join('/')
  const provider = createProvider({
    adapters: [adapter],
    routes: { primary: { route: entry.route, model } },
    contract: new NullContractStore(),
    secrets: () => process.env.AGH_DEMO_API_KEY,
    clock: Date.now,
    pricing: { creditsPerUsd: 1 },
  })
  const catalogSession = await rt.session()
  const catalog = (await catalogSession.tools()).tools
    .filter((tool) => tool.name !== 'run_code')
    .map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }))
  const corpus = JSON.parse(
    await readFile('packages/base/extensions/plugin-creator/test/authoring-behavior.eval.json', 'utf8'),
  )
  const summary = {
    mode: 'behavior',
    method:
      'Single inert response with proposed tool choice; same-model rubric judge, subject to human audit',
    calls: [],
    scores: [],
  }
  const infer = async (label, system, prompt) => {
    const events = [],
      started = Date.now()
    for await (const event of provider.infer(
      {
        kind: 'inference',
        sessionKey: randomUUID(),
        slot: 'primary',
        route: entry.route,
        model,
        contractId: null,
        derivedHash: createHash('sha256').update(system).digest('hex'),
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        tools: [],
        sampling: { maxTokens: 8192, thinking: 'off' },
      },
      { signal: AbortSignal.timeout(25 * 60 * 1000), toolNames: [] },
    ))
      events.push(event)
    const result = {
      label,
      wallMs: Date.now() - started,
      text: events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.delta)
        .join(''),
      tools: events.filter((e) => e.type === 'toolcall_end'),
      usage: events.filter((e) => e.type === 'usage'),
      errors: events.filter((e) => e.type === 'error'),
      events,
    }
    await rt.save(`${label}.json`, result)
    summary.calls.push({ label, wallMs: result.wallMs, usage: result.usage, errors: result.errors })
    await rt.save('summary.json', summary)
    console.log(JSON.stringify({ label, wallMs: result.wallMs, usage: result.usage, errors: result.errors }))
    assert.equal(result.errors.length, 0, 'Inference failed; see isolated evidence')
    return result
  }
  for (const [index, test] of corpus.cases.entries()) {
    const output = await infer(
      `behavior-${index + 1}`,
      `${authoringContextGuidance}\n${authoringGuidance}\nThis is an inert continuation evaluation. Return ONLY JSON {"reply": string, "toolCalls": [{"name": string, "arguments": object}], "plan": string[]}. Choose the next available tool(s) and describe subsequent steps in plan. No tools are executed; never claim a planned action already happened. The supplied synthetic receipts are authoritative. Synthetic tools-mode catalog (run_code is unavailable in this mode; this inert evaluation offers no actual execution):\n${JSON.stringify(catalog)}`,
      JSON.stringify({ user: test.user ?? 'Continue the plugin authoring task.', receipts: test.receipts }),
    )
    const judgment = await infer(
      `grade-${index + 1}`,
      'Grade a proposed authoring continuation against EVERY supplied must and mustNot criterion. Return ONLY JSON {"must": [{"criterion": string, "passed": boolean, "evidence": string}], "mustNot": [{"criterion": string, "passed": boolean, "evidence": string}]}. Copy each criterion exactly. A mustNot passes when the prohibited action/claim is absent. This is a NEXT RESPONSE evaluation: explicit correct plans count for future actions; tests or files cannot be executed here. Fail omitted actions and unsupported claims. A planned read or pack need not already have happened. Distinguish existing receipt evidence from future action. Quote evidence.',
      JSON.stringify({ rubric: test, output: output.text }),
    )
    summary.scores.push(scoreContinuation(test, output, judgment))
    await rt.save('scores.json', summary.scores)
  }
  summary.passed = summary.scores.every((score) => score.passed)
  await rt.save('rubric.json', corpus)
  return summary
}
