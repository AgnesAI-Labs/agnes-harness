import type { ModelRecord, ProbeReport, RequestBody } from '@agnes/protocol'
import type { WireAdapter } from '../../adapter.js'
import type { Observation } from '../../quality/doctor.js'

/** Runs through the adapter's ordinary credential, transport and translation path. */
export async function probeInference(
  adapter: WireAdapter,
  route: string,
  model: ModelRecord | undefined,
  signal: AbortSignal,
): Promise<ProbeReport> {
  const started = performance.now()
  const checks: ProbeReport['checks'] = [
    { name: 'models_endpoint', ok: false, detail: 'protocol-specific catalogue probe is not implemented' },
  ]
  const report = (): ProbeReport => ({
    route,
    ok: checks.every((check) => check.ok),
    checks,
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
  })
  if (!model || signal.aborted) {
    checks.push({
      name: 'minimal_inference',
      ok: false,
      detail: signal.aborted ? 'aborted' : 'no model declared',
    })
    return report()
  }
  const observation: Observation = {
    modelId: model.id,
    thinking: false,
    nativeToolCalls: false,
    usageComplete: false,
  }
  const request: RequestBody = {
    kind: 'inference',
    sessionKey: 'agnes:doctor:probe',
    slot: 'primary',
    route,
    model: model.id,
    contractId: null,
    derivedHash: '0'.repeat(64),
    system: 'Reply with the word pong. If a tool is available, call it once.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    tools: [
      {
        name: 'noop',
        description: 'Does nothing. Call it once.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  }
  let inputPositive = false
  let failed = false
  try {
    for await (const event of adapter.stream(route, request, {
      signal,
      toolNames: ['noop'],
      sessionKey: request.sessionKey,
      timeoutMs: { firstToken: 30_000, total: 30_000 },
    })) {
      if (signal.aborted) {
        failed = true
        break
      }
      if (event.type === 'thinking_delta' && event.delta.length > 0) observation.thinking = true
      if (event.type === 'toolcall_end') observation.nativeToolCalls = true
      if (event.type === 'usage') {
        const tokens = event.tokens
        const required = [
          tokens.input,
          tokens.output,
          tokens.cacheRead,
          tokens.cacheWrite,
          ...(model.reasoning ? [tokens.reasoning] : []),
        ]
        observation.usageComplete = required.every(
          (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
        )
        inputPositive = tokens.input > 0
      }
      if (event.type === 'error') {
        failed = true
        break
      }
      if (event.type === 'done') {
        observation.doneReason = event.reason
        break
      }
    }
  } catch {
    failed = true
  }
  const completed = !failed && !signal.aborted && observation.doneReason !== undefined
  checks.push({
    name: 'minimal_inference',
    ok: completed,
    detail: completed ? JSON.stringify(observation) : 'inference did not complete',
  })
  checks.push({
    name: 'fields',
    ok: completed && observation.usageComplete && inputPositive,
    detail: JSON.stringify({
      modelId: model.id,
      usageComplete: observation.usageComplete,
      inputPositive,
      completed,
    }),
  })
  return report()
}
