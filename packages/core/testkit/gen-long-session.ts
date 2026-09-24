import { mkdirSync, writeFileSync } from 'node:fs'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const lines: string[] = []
let seq = 0
const push = (type: string, data: unknown, extra: Record<string, unknown> = {}): void => {
  seq++
  lines.push(
    JSON.stringify({
      seq,
      ts: '2026-09-07T00:00:00Z',
      id: `01K4A000000000000${String(seq).padStart(8, '0')}`,
      type,
      data,
      actor,
      origin: 'principal',
      trust: 'trusted',
      lane: 'main',
      v: 1,
      ...extra,
    }),
  )
}

for (let turn = 1; turn <= 500; turn++) {
  let lastAssistantSeq = 0
  push('user/message', { content: [{ type: 'text', text: `q${turn}` }] })
  push('turn/start', { turn, trigger: 'prompt' })
  for (let step = 1; step <= 3; step++) {
    push('step/start', { turn, step })
    push('assistant/message', {
      content: [{ type: 'text', text: `a${turn}.${step}` }],
      stopReason: 'tool_use',
    })
    lastAssistantSeq = seq
    push('tool/call', { toolUseId: `t${turn}.${step}`, name: 'read', args: { path: 'x' }, ordinal: 0 })
    push('tool/result', {
      toolUseId: `t${turn}.${step}`,
      content: [{ type: 'text', text: 'r' }],
      isError: false,
      enforcement: { level: 'full', scope: [] },
      authz: { decisionId: 'n/a' },
    })
    push('step/end', { turn, step })
  }
  // Two ledger rows keep the fixture at exactly 20 rows per complete turn while still exercising
  // the reducer's accounting path. The plan's original three-per-step shape produced 10,500 rows.
  for (let cost = 0; cost < 2; cost++)
    push('cost/ledger', {
      purpose: 'inference',
      effectId: `e${turn}.${cost}`,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      credits: 1,
      creditSource: 'estimated',
      model: 'm',
    })
  push('turn/end', { reason: 'completed', lastAssistantSeq })
}

const target = new URL('../fixtures/reduce/long-session.jsonl', import.meta.url)
mkdirSync(new URL('../fixtures/reduce/', import.meta.url), { recursive: true })
writeFileSync(target, `${lines.join('\n')}\n`)
console.log(`wrote ${seq} events`)
