import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { countLines } from './count-lines.js'
import { matchesRatchetKey } from './ratchet-key.js'
import { DEFAULT_EXCLUDE_DIRS, isTestFile, listSourceFiles, SOURCE_EXTENSIONS } from './repo.js'

type Entry = { value: number; start: number; end: number }
export type Measurement = { key: string; actual: number; budget: number; ceiling: number }
export type RemeasureOptions = { keys?: string[]; check?: boolean; allowIncrease?: boolean }

function entries(text: string, file: string): Map<string, Entry> {
  // Mask comments without shifting offsets or interpreting numbers in historical comments.
  // These maintained tables contain only unescaped quoted paths and decimal integer literals.
  const source = text.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (token) => (token.startsWith('/') ? token.replace(/[^\r\n]/g, ' ') : token),
  )
  const declarations = [...source.matchAll(/^\s*const INITIAL_CEILING[^=\n]*=\s*\{/gm)]
  const json = file.endsWith('.json')
  if (!json && declarations.length !== 1) throw new Error(`${file}: expected one INITIAL_CEILING`)
  const declaration = declarations[0]
  const start = json ? source.indexOf('{') + 1 : (declaration?.index ?? 0) + (declaration?.[0].length ?? 0)
  const end = json ? source.lastIndexOf('}') : source.indexOf('}', start)
  if (start < 1 || end < start) throw new Error(`${file}: missing budget object`)
  const body = source.slice(start, end)
  const property = /(['"])([^'"\\]*)\1\s*:\s*(\d+)(?=\s*(?:,|$))/g
  const result = new Map<string, Entry>()
  for (const match of body.matchAll(property)) {
    const key = match[2] ?? ''
    const number = match[3] ?? ''
    const value = Number(number)
    if (!Number.isSafeInteger(value) || value < 0 || result.has(key))
      throw new Error(`${file}: invalid or duplicate budget for ${key}`)
    const offset = start + match.index + match[0].lastIndexOf(number)
    result.set(key, {
      value,
      start: offset,
      end: offset + number.length,
    })
  }
  if (body.replace(property, '').replace(/[\s,]/g, '') !== '')
    throw new Error(`${file}: expected quoted paths and decimal integer budgets`)
  return result
}

function entry(values: Map<string, Entry>, key: string): Entry {
  const value = values.get(key)
  if (!value) throw new Error(`Missing ratchet entry: ${key}`)
  return value
}

export function changedRatchetKeys(root: string, keys: string[], changedFiles: string[]): string[] {
  const files = changedFiles
    .filter(
      (file) =>
        SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)) &&
        !isTestFile(file) &&
        !file.split('/').some((part) => DEFAULT_EXCLUDE_DIRS.includes(part)),
    )
    .map((file) => resolve(root, file))
  return keys.filter((key) => files.some((file) => matchesRatchetKey(file, resolve(root, key))))
}

function changedFiles(root: string): string[] {
  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  // Compare committed, staged and unstaged branch changes; include both sides of renames/deletions.
  return [
    ...run(['diff', '--name-only', '--no-renames', '-z', 'origin/feat/agh-plugin-core', '--']),
    ...run(['ls-files', '--others', '--exclude-standard', '-z']),
  ]
}

function rewrite(text: string, values: Map<string, Entry>, measurements: Measurement[]): string {
  const replacements = measurements.map(({ key, actual }) => ({ ...entry(values, key), actual }))
  for (const { start, end, actual } of replacements.sort((a, b) => b.start - a.start))
    text = text.slice(0, start) + actual + text.slice(end)
  return text
}

export function remeasure(root: string, options: RemeasureOptions = {}): Measurement[] {
  const budgetFile = join(root, 'tools/guards/ratchet.json')
  const ceilingFile = join(root, 'tools/guards/src/ratchet.test.ts')
  const budgetText = readFileSync(budgetFile, 'utf8')
  const ceilingText = readFileSync(ceilingFile, 'utf8')
  const parsed: unknown = JSON.parse(budgetText)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('ratchet.json must contain a budget object')
  const budgets = entries(budgetText, budgetFile)
  const ceilings = entries(ceilingText, ceilingFile)
  if (budgets.size !== ceilings.size || [...budgets.keys()].some((key) => !ceilings.has(key)))
    throw new Error('ratchet.json and INITIAL_CEILING must declare the same keys')
  const selected = options.keys ?? changedRatchetKeys(root, [...budgets.keys()], changedFiles(root))
  const unknown = selected.filter((key) => !budgets.has(key))
  if (unknown.length) throw new Error(`Unknown ratchet key: ${unknown.join(', ')}`)
  const measurements = [...new Set(selected)].map((key) => {
    const abs = resolve(root, key)
    const files = listSourceFiles(dirname(abs)).filter(
      (file) => matchesRatchetKey(file, abs) && !isTestFile(file),
    )
    if (!files.length) throw new Error(`${key}: stale ratchet key has no source files`)
    return {
      key,
      actual: files.reduce((total, file) => total + countLines(readFileSync(file, 'utf8')), 0),
      budget: entry(budgets, key).value,
      ceiling: entry(ceilings, key).value,
    }
  })
  if (options.check) return measurements
  const increases = measurements.filter(({ actual, budget, ceiling }) => actual > budget || actual > ceiling)
  if (increases.length && !options.allowIncrease)
    throw new Error(
      `Refusing budget increase: ${increases.map(({ key }) => key).join(', ')}; review and pass --allow-increase`,
    )
  const nextBudget = rewrite(budgetText, budgets, measurements)
  const nextCeiling = rewrite(ceilingText, ceilings, measurements)
  // Validate the complete plan before writing either file; unchanged text is never reformatted.
  if (nextBudget !== budgetText) writeFileSync(budgetFile, nextBudget)
  if (nextCeiling !== ceilingText) writeFileSync(ceilingFile, nextCeiling)
  return measurements
}

export function parseRemeasureArgs(args: string[]): RemeasureOptions {
  const options: RemeasureOptions = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--check') options.check = true
    else if (arg === '--allow-increase') options.allowIncrease = true
    else if (arg === '--keys') {
      const value = args[++index]
      if (!value || value.startsWith('--') || options.keys)
        throw new Error('--keys requires one comma-separated list')
      options.keys = value.split(',').map((key) => key.trim())
      if (options.keys.some((key) => !key)) throw new Error('--keys cannot contain an empty key')
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}
