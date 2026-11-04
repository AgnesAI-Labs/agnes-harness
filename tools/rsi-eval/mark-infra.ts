// Marks the runs of a finished or interrupted output folder that the upstream ended, so the runner redoes
// them. The first evaluation recorded such runs (HTTP 402) as plain failures: exit 1, no checks. A run with
// a session that did not end cleanly, whose ledger's last turn ended in an infrastructure error, gets
// `infraFailed` in its outcome; the runner starts every run so marked again. Runs that already carry the
// mark, and runs that ended for any other reason, are not touched. No model call.
//
// Usage: pnpm exec tsx tools/rsi-eval/mark-infra.ts --run-dir <out> [--dry-run]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { infraFromLedger } from './infra.js'
import type { RunOutcome } from './types.js'

export type MarkResult = {
  /** Runs marked by this call (or that would be, in a dry run). */
  marked: { runId: string; reason: string }[]
  /** Runs that already carried the mark. */
  already: string[]
}

const readRows = (file: string): unknown[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as unknown]
          } catch {
            return []
          }
        })
    : []

export function markInfraFailures(runDir: string, options: { dryRun?: boolean } = {}): MarkResult {
  const result: MarkResult = { marked: [], already: [] }
  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    const file = join(runDir, entry.name, 'outcome.json')
    if (!entry.isDirectory() || !existsSync(file)) continue
    const outcome = JSON.parse(readFileSync(file, 'utf8')) as RunOutcome
    if (outcome.infraFailed) {
      result.already.push(outcome.runId)
      continue
    }
    for (const [i, session] of outcome.sessions.entries()) {
      if (!session.timedOut && session.exitCode === 0) continue
      // Session files are named by the runner; an outcome moved from another folder is read from here.
      const ledger = join(runDir, entry.name, 'sessions', `s${i + 1}.events.jsonl`)
      const found = infraFromLedger(readRows(ledger), i)
      if (!found) break
      result.marked.push({ runId: outcome.runId, reason: found.reason })
      if (!options.dryRun)
        writeFileSync(file, `${JSON.stringify({ ...outcome, infraFailed: found }, null, 2)}\n`)
      break
    }
  }
  return result
}

const main = (): void => {
  const i = process.argv.indexOf('--run-dir')
  const dir = i < 0 ? undefined : process.argv[i + 1]
  if (!dir) throw new Error('usage: mark-infra.ts --run-dir <out> [--dry-run]')
  const dryRun = process.argv.includes('--dry-run')
  if (!existsSync(resolve(dir))) {
    console.log('no earlier runs')
    return
  }
  const result = markInfraFailures(resolve(dir), { dryRun })
  const pending = result.marked.length + result.already.length
  console.log(
    `runs the upstream ended, to be redone: ${pending}${dryRun ? ' (dry run, nothing changed)' : ''}` +
      (result.marked.length > 0 ? `; newly recognised: ${result.marked.length}` : ''),
  )
  for (const m of result.marked) console.log(`  ${m.runId}  ${m.reason}`)
  for (const id of result.already) console.log(`  ${id}  (already marked)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
