import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { type ActionFrame, canonicalJsonDigest } from '@agnes/protocol/runtime'
import { modelCrashFixture } from '../../../../ai/test/runtime/model-crash-fixture.js'
import {
  type ModelCallRegistry,
  openModelSourceStore,
} from '../../../src/runtime/model/model-source-store.js'

const [api, endpoint, journal, operation, storePath, flag, mode, cut, sole] = process.argv.slice(2)
if (
  !['openai-completions', 'anthropic-messages'].includes(api ?? '') ||
  !endpoint ||
  !journal ||
  !operation ||
  !storePath ||
  !flag ||
  !['execute', 'recover'].includes(mode ?? '') ||
  !['none', 'before-save', 'in-transaction', 'after-save', 'save-fails'].includes(cut ?? '') ||
  !['true', 'false'].includes(sole ?? '') ||
  !process.send
)
  throw Error('Fixed worker arguments missing')

// A restricted stand-in for State's persisted dispatch: the issued operation file written before the call.
const calls: ModelCallRegistry = {
  attempt(attemptId) {
    if (!existsSync(operation)) return undefined
    const issued = JSON.parse(readFileSync(operation, 'utf8')) as { frame: ActionFrame }
    const frame = issued.frame
    if (frame.attemptId !== attemptId || frame.requestIdentity === null) return undefined
    return {
      runId: frame.runId,
      actionId: frame.actionId,
      attemptId: frame.attemptId,
      bindingId: frame.bindingId,
      inputDigest: frame.inputDigest,
      requestIdentity: frame.requestIdentity,
    }
  },
}
// Blocks the whole process inside the save transaction so the parent can SIGKILL it exactly there.
const hold = () => {
  writeFileSync(flag, 'inside')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)
}
const store = openModelSourceStore({
  path: storePath,
  calls,
  soleSendFence: sole === 'true',
  ...(cut === 'in-transaction' ? { beforeCommit: hold } : {}),
})
const never = () => new Promise<never>(() => {})
const fixture = await modelCrashFixture(
  api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
  endpoint,
  journal,
  operation,
  false,
  {
    async save(frame, result, bodyDigest) {
      if (cut === 'save-fails') throw new Error('Store unavailable')
      if (cut === 'before-save') {
        process.send?.({ phase: 'in-flight', pid: process.pid })
        await never()
      }
      await store.deployment.save(frame, result, bodyDigest)
      if (cut === 'after-save') {
        process.send?.({
          phase: 'durable',
          pid: process.pid,
          result,
          resultDigest: canonicalJsonDigest(result as never),
        })
        await never()
      }
    },
    lookup: store.deployment.lookup,
    beforeSend: (frame, bodyDigest) => store.fence(frame, bodyDigest),
    // A cold worker can take longer than the fixture's default 20 s to start; the first run's deadline is saved.
    deadline: new Date(Date.now() + 600000).toISOString(),
  },
)
const reconcileFrame: ActionFrame = {
  ...fixture.frame,
  method: 'reconcile',
  attemptId: 'reconcile-attempt',
  requestIdentity: null,
}
const attemptRef = {
  run: {
    runId: fixture.frame.runId,
    session: {
      sessionId: 'session',
      authority: { authorityId: 'state', tenantId: 'tenant', authorityEpoch: 1 },
    },
  },
  actionId: fixture.frame.actionId,
  attemptId: fixture.frame.attemptId,
}
process.on('message', async (message: unknown) => {
  if (message === null || typeof message !== 'object' || !('op' in message)) return
  try {
    if (mode === 'execute' && message.op === 'execute') {
      const result = await fixture.action.execute(fixture.frame, fixture.call)
      process.send?.({ phase: 'executed', pid: process.pid, result, sends: fixture.sends() })
    } else if (mode === 'recover' && message.op === 'resend') {
      const result = await fixture.action.execute(fixture.frame, fixture.call)
      process.send?.({ phase: 'resent', pid: process.pid, result, sends: fixture.sends() })
    } else if (mode === 'recover' && message.op === 'recover') {
      const leaf = await fixture.action.reconcile(fixture.frame, [], fixture.call)
      const targeted = await store.deployment.lookup(reconcileFrame, [], fixture.call, attemptRef)
      process.send?.({
        phase: 'recovered',
        pid: process.pid,
        leaf,
        targeted,
        sends: fixture.sends(),
        pending: store.admin.pending().map((entry) => entry.kind),
      })
    } else process.send?.({ phase: 'refused', pid: process.pid })
  } catch (error) {
    process.send?.({
      phase: 'error',
      message: error instanceof Error ? error.message : 'Worker operation failed',
      pid: process.pid,
    })
  }
})
process.send({ phase: 'ready', pid: process.pid })
