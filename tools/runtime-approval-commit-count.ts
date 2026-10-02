import { DatabaseSync } from 'node:sqlite'

export type ApprovalCommitSample = Readonly<{
  file: string
  /** All actual committing owner notices in the measured scenario, including auxiliary writes. */
  commits: readonly Readonly<{ wrote: boolean }>[]
}>

/** Reads persisted writes, including claim/ack/fail commits without a State ledger event. */
function count(sample: ApprovalCommitSample): number {
  const database = new DatabaseSync(sample.file, { readOnly: true })
  try {
    const row = database
      .prepare(`SELECT
      (SELECT COUNT(*) FROM events WHERE type = 'runtime/state-commit')
      + (SELECT COUNT(*) FROM runtime_aux_commits) AS n`)
      .get()
    if (!row || typeof row.n !== 'number' || !Number.isSafeInteger(row.n) || row.n < 0)
      throw new Error('approval authoritative commit evidence is invalid')
    const wrote = sample.commits.filter((commit) => commit.wrote).length
    if (wrote !== row.n) throw new Error(`commit counter ${wrote} does not match attested commits ${row.n}`)
    return row.n
  } finally {
    database.close()
  }
}

/** The caller runs the same real tool/input owners with approval added only in the second scenario. */
export async function measureApprovalCommitIncrement(
  run: (scenario: 'k1' | 'approval-k1') => Promise<ApprovalCommitSample>,
): Promise<Readonly<{ k1: number; approvalK1: number; increment: number }>> {
  const baseline = count(await run('k1'))
  const approval = count(await run('approval-k1'))
  const increment = approval - baseline
  if (increment < 0 || increment > 2)
    throw new Error(`approval authoritative commit increment ${increment} is outside 0..2`)
  return Object.freeze({ k1: baseline, approvalK1: approval, increment })
}
