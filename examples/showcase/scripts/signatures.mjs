import { randomUUID } from 'node:crypto'

/** Explicit synthetic test operator, independent of the model. Never a production auto-signer. */
export function testOperatorSignatures(
  client,
  session,
  { answer = () => 'allowed-once', beforeAnswer = async () => {}, locale = 'zh-CN' } = {},
) {
  let stopped = false,
    failure
  const task = (async () => {
    while (!stopped) {
      const { decisions } = await client.approval.list(session.id)
      for (const snapshot of decisions) {
        if (snapshot.request.spec.purpose !== 'business.confirm' || snapshot.result || snapshot.invalidation)
          continue
        await beforeAnswer(snapshot)
        await client.approval.decide({
          ...snapshot.handle,
          revision: snapshot.revision,
          commandId: randomUUID(),
          response: {
            option: answer(snapshot),
            value: snapshot.request.spec.presentation?.[locale]?.responseValue ?? null,
          },
        })
      }
      await new Promise((done) => setTimeout(done, 100))
    }
  })().catch((error) => {
    failure = error
    void session.cancel().catch(() => {})
  })
  return {
    async stop() {
      stopped = true
      await task
      if (failure) throw failure
    },
  }
}
