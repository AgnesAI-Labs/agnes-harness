import { attempt, ledgerFixture } from './usage-ledger.js'

const [dir, stage] = process.argv.slice(2)
if (!dir) throw new Error('isolated fixture directory required')
const fixture = await ledgerFixture(dir)
if (stage === 'usage-disconnect' || stage === 'ledger-disconnect' || stage === 'ledger-failure') {
  fixture.commit()
  if (stage === 'usage-disconnect') fixture.loseUsageReply()
  else if (stage === 'ledger-disconnect') fixture.loseLedgerReply()
  else fixture.failLedger()
  const result = await fixture.consumer.consume(attempt())
  if (result.ok) throw new Error('failure fixture unexpectedly succeeded')
  // Terminate without closing any owner or delivery connection.
  process.kill(process.pid, 'SIGKILL')
} else {
  try {
    const pendingBefore = fixture.consumer.pending()
    fixture.commit(attempt('2'))
    const replies = [
      await fixture.consumer.consume(attempt()),
      await fixture.consumer.consume(attempt()),
      await fixture.consumer.consume(attempt('2')),
    ]
    process.stdout.write(
      JSON.stringify({
        pendingBefore,
        replies,
        rows: fixture.rows(),
        facts: fixture.facts(),
        pendingAfter: fixture.consumer.pending(),
      }),
    )
  } finally {
    await fixture.close()
  }
}
