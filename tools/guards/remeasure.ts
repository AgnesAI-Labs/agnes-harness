// Refreshes the report-only baseline (ratchet.json) and tightens the per-file size allowlist.
//   pnpm guards:remeasure            rewrite both files from the current tree
//   pnpm guards:remeasure --check    write nothing; exit 1 only on a hard failure (a listed file grew,
//                                    an unlisted file is over the limit, or an entry is stale)
// --keys is accepted for older callers and ignored (the baseline is always refreshed whole).
// --allow-increase re-baselines the allowlist after a reviewed merge: it may raise a ceiling or list
// a file; the increase needs a justification in the review, not here.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { countLines } from './src/count-lines.js'
import { matchesRatchetKey } from './src/ratchet-key.js'
import { isTestFile, listSourceFiles, repoRoot } from './src/repo.js'

const MAX_FILE_LINES = 800
const root = repoRoot()
const check = process.argv.includes('--check')
const allowIncrease = process.argv.includes('--allow-increase')
const read = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8')) as Record<string, number>
const write = (rel: string, value: unknown) =>
  writeFileSync(join(root, rel), `${JSON.stringify(value, null, 2)}\n`)

const baseline = read('tools/guards/ratchet.json')
const next: Record<string, number> = {}
for (const key of Object.keys(baseline)) {
  const abs = join(root, key)
  const files = listSourceFiles(dirname(abs)).filter((f) => matchesRatchetKey(f, abs) && !isTestFile(f))
  next[key] = files.reduce((n, f) => n + countLines(readFileSync(f, 'utf8')), 0)
  if (next[key] !== baseline[key]) console.log(`${key}: ${baseline[key]} -> ${next[key]}`)
}

const allowlist = read('tools/guards/file-size-allowlist.json')
const measured = new Map<string, number>()
for (const file of [...listSourceFiles(join(root, 'packages')), ...listSourceFiles(join(root, 'tools'))])
  if (!isTestFile(file)) measured.set(relative(root, file), countLines(readFileSync(file, 'utf8')))
const nextAllow: Record<string, number> = {}
let failed = false
for (const [file, lines] of measured) {
  if (lines <= MAX_FILE_LINES) continue
  const ceiling = allowlist[file]
  if (!allowIncrease && (ceiling === undefined || lines > ceiling)) {
    console.error(`${file}: ${lines} lines exceeds ${ceiling ?? MAX_FILE_LINES}; split the file`)
    failed = true
  }
  nextAllow[file] = allowIncrease ? lines : Math.min(lines, ceiling ?? lines)
}
for (const file of Object.keys(allowlist))
  if (!(file in nextAllow)) console.log(`${file}: within the limit, entry removed`)

if (check) failed ||= Object.keys(nextAllow).length !== Object.keys(allowlist).length
else if (!failed) {
  write('tools/guards/ratchet.json', next)
  write('tools/guards/file-size-allowlist.json', nextAllow)
}
if (failed) process.exitCode = 1
