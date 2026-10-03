import { modelCrashFixture } from '../model-crash-fixture.js'

const api = process.argv[2],
  endpoint = process.argv[3],
  receipt = process.argv[4],
  operation = process.argv[5],
  mode = process.argv[6]
if (
  !['openai-completions', 'anthropic-messages'].includes(api ?? '') ||
  !endpoint ||
  !receipt ||
  !operation ||
  !['execute', 'recover'].includes(mode ?? '') ||
  !process.send
)
  throw Error('Fixed fixture owner arguments missing')
const fixture = await modelCrashFixture(
  api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
  endpoint,
  receipt,
  operation,
  mode === 'execute',
)
process.on('message', async (message: unknown) => {
  if (message === null || typeof message !== 'object' || !('op' in message)) return
  const op = message.op
  try {
    if (mode === 'execute' && op === 'execute') await fixture.action.execute(fixture.frame, fixture.call)
    else if (mode === 'recover' && op === 'recover') {
      const result = await fixture.action.reconcile(fixture.frame, [], fixture.call)
      process.send?.({
        phase: 'recovered',
        pid: process.pid,
        result,
        sends: fixture.sends(),
        source: fixture.source,
        frame: fixture.frame,
      })
    } else process.send?.({ phase: 'refused', pid: process.pid })
  } catch (error) {
    process.send?.({
      phase: 'error',
      message: error instanceof Error ? error.message : 'Fixture operation failed',
      pid: process.pid,
    })
  }
})
process.send({ phase: 'ready', pid: process.pid })
