import { randomUUID } from 'node:crypto'
import { pluginRowSource } from '@agnes/host-extensions/ext-host/row-extension-host'
import type { DecisionSnapshot, ProfileDecisionAnswerParams } from '@agnes/protocol'
import type { Booted } from '../types.js'
import { parseRuntimeArgs, RUNTIME_USAGE } from './runtime-args.js'

export { parseRuntimeArgs, RUNTIME_USAGE }

export async function runtimeCommand(
  rest: readonly string[],
  io: { write(text: string): void; connect(profile?: string): Promise<Pick<Booted, 'client' | 'close'>> },
): Promise<number> {
  const args = parseRuntimeArgs(rest)
  if (args.values.help) {
    io.write(`${RUNTIME_USAGE}\n`)
    return 0
  }
  const [, resource] = args.positionals
  const { extension, operation, answer, profile } = args.values
  const connected = await io.connect(typeof profile === 'string' ? profile : undefined)
  try {
    const params = {
      extension: pluginRowSource(String(extension)),
      service: `${resource}.reconcile`,
      input: {},
      operationId: typeof operation === 'string' ? operation : randomUUID(),
    }
    const send = () => connected.client.extensions.callScoped(params)
    // Answer only an existing proposal; an answer flag cannot create and approve unseen work.
    let result = answer
      ? await connected.client.extensions.readOperation({
          extension: params.extension,
          service: params.service,
          operationId: params.operationId,
        })
      : await send()
    if ('state' in result && result.state === 'approval-required' && result.decision) {
      const { decisions } = await connected.client.call<{ decisions: DecisionSnapshot[] }>(
        '_agnes/v1/profile.decisions.list',
        {},
      )
      const decisionId = result.decision.id
      const snapshot = decisions.find((d) => d.handle.id === decisionId)
      if (!snapshot) throw new Error('Reconciliation decision unavailable')
      io.write(`${JSON.stringify({ operationId: params.operationId, decision: snapshot })}\n`)
      if (answer) {
        await connected.client.call('_agnes/v1/profile.decisions.answer', {
          handle: snapshot.handle,
          revision: snapshot.revision,
          commandId: randomUUID(),
          response: { option: answer === 'allow' ? 'allowed-once' : 'rejected', value: null },
        } satisfies ProfileDecisionAnswerParams)
        result = await send()
      }
    }
    io.write(`${JSON.stringify(result)}\n`)
    if (!('state' in result)) throw new Error('Invalid reconciliation receipt')
    return result.state === 'completed' ? 0 : ['approval-required', 'running'].includes(result.state) ? 3 : 1
  } finally {
    await connected.close()
  }
}
