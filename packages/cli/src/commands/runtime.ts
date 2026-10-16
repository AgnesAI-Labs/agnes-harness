import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { pluginRowSource } from '@agnes/host-extensions/ext-host/row-extension-host'
import type { DecisionSnapshot, ProfileDecisionAnswerParams } from '@agnes/protocol'
import { UsageError } from '../errors.js'
import type { Booted } from '../types.js'

export const RUNTIME_USAGE =
  'agh runtime reconcile <resource> --extension <row-id> [--operation <id>] [--answer allow|reject] [--profile <name>] [--json]'
/** Thin operator surface. Identity checks, grants, decision subjects and recovery stay in the Host. */
export function parseRuntimeArgs(rest: readonly string[]) {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs({
      args: [...rest],
      allowPositionals: true,
      options: {
        extension: { type: 'string' },
        operation: { type: 'string' },
        answer: { type: 'string' },
        profile: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    })
  } catch {
    throw new UsageError(RUNTIME_USAGE)
  }
  if (args.values.help) {
    return args
  }
  const [verb, resource, extra] = args.positionals
  const { extension, operation, answer, profile } = args.values
  if (
    verb !== 'reconcile' ||
    !resource ||
    !/^[a-zA-Z0-9._-]{1,128}$/u.test(resource) ||
    extra ||
    typeof extension !== 'string' ||
    !extension.startsWith('ext:') ||
    (operation !== undefined &&
      (typeof operation !== 'string' || !/^[a-zA-Z0-9:._-]{1,128}$/u.test(operation))) ||
    (answer !== undefined && (!operation || !['allow', 'reject'].includes(String(answer)))) ||
    (profile !== undefined && typeof profile !== 'string')
  )
    throw new UsageError(RUNTIME_USAGE)
  return args
}
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
