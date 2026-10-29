// Refresh report-only scope LOC and tighten hard file/function ceilings. Host exceptions are
// manually reviewed identities, never generated here. --allow-increase is budget-only preparation;
// protected-base checks still apply in CI and require a separate maintainer policy review.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { countLines } from './src/count-lines.js'
import { FUNCTION_LIMIT, functionKey, functionMeasurements } from './src/function-size.js'
import { assertBudgetNonIncrease, assertMaintainerBudgetChange } from './src/protected-allowances.js'
import { isTestFile, listSourceFiles, presentationSourceFiles, repoRoot } from './src/repo.js'
import { matchesScopeKey } from './src/scope-key.js'

const MAX_FILE_LINES = 800
const root = repoRoot()
const check = process.argv.includes('--check')
const allowIncrease = process.argv.includes('--allow-increase')
if (allowIncrease) assertMaintainerBudgetChange(root)
const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, number>
const write = (path: string, value: unknown) =>
  writeFileSync(join(root, path), `${JSON.stringify(value, null, 2)}\n`)

const report = read('tools/guards/scope-line-count.json')
const nextReport: Record<string, number> = {}
for (const key of Object.keys(report)) {
  const abs = join(root, key)
  const files = listSourceFiles(dirname(abs)).filter(
    (file) => matchesScopeKey(file, abs) && !isTestFile(file),
  )
  nextReport[key] = files.reduce((n, file) => n + countLines(readFileSync(file, 'utf8')), 0)
  if (nextReport[key] !== report[key])
    console.log(`${key}: ${report[key]} -> ${nextReport[key]} (report only)`)
}

const measuredFiles = Object.fromEntries(
  [
    ...listSourceFiles(join(root, 'packages')),
    ...listSourceFiles(join(root, 'tools')),
    ...presentationSourceFiles(root),
  ]
    .filter((file) => !isTestFile(file))
    .map((file) => [relative(root, file).replaceAll('\\', '/'), countLines(readFileSync(file, 'utf8'))]),
)
const measuredFunctions = Object.fromEntries(
  functionMeasurements(root).functions.map((fn) => [functionKey(fn), fn.lines]),
)
let failed = false
const updates: [string, Record<string, number>][] = []
for (const [path, measured, limit] of [
  ['tools/guards/file-size-allowlist.json', measuredFiles, MAX_FILE_LINES],
  ['tools/guards/function-size-allowlist.json', measuredFunctions, FUNCTION_LIMIT],
] as const) {
  const previous = read(path)
  const next: Record<string, number> = {}
  if (!allowIncrease) {
    const growth = assertBudgetNonIncrease(root, path)
    for (const error of growth) console.error(error)
    failed ||= growth.length > 0
  }
  for (const [key, lines] of Object.entries(measured)) {
    if (lines <= limit) continue
    const ceiling = previous[key]
    if (!allowIncrease && (ceiling === undefined || lines > ceiling)) {
      console.error(`${key}: ${lines} effective LOC exceeds ${ceiling ?? limit}; split the source`)
      failed = true
    }
    next[key] = lines
  }
  if (check) {
    const stale = Object.keys(previous).filter((key) => !(key in next))
    for (const key of stale) console.error(`Remove stale allowance: ${key}`)
    failed ||= stale.length > 0
  }
  updates.push([path, next])
}
if (!check && !failed) {
  write('tools/guards/scope-line-count.json', nextReport)
  for (const [path, next] of updates) write(path, next)
}
if (failed) process.exitCode = 1
