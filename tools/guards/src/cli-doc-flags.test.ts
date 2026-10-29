// Drift guard: every `--flag` the CLI guide and reference mention must be a string literal somewhere in
// packages/cli/src, so documentation cannot keep advertising a flag the parser no longer knows.
// Flags are collected across the whole directory (a subcommand's own parser counts) to avoid false alarms.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()
const DOCS = [
  'docs/guide/cli.md',
  'docs/guide/cli.zh-CN.md',
  'docs/reference/cli.md',
  'docs/reference/cli.zh-CN.md',
]
const STRING_LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g

const flagsIn = (text: string): Set<string> =>
  new Set([...text.matchAll(/(?<![\w-])--[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g)].map((m) => m[0]))

/** Flags named in `docs` that appear in no string literal of `sources`. */
export function undocumentedFlags(docs: readonly string[], sources: readonly string[]): string[] {
  const literals = sources.flatMap((text) => text.match(STRING_LITERAL) ?? []).join('\n')
  const known = flagsIn(literals)
  return [...new Set(docs.flatMap((text) => [...flagsIn(text)]))].filter((flag) => !known.has(flag)).sort()
}

const cliSources = listSourceFiles(join(root, 'packages/cli/src')).map((file) => readFileSync(file, 'utf8'))

it('documents only flags the CLI source mentions', () => {
  const docs = DOCS.map((path) => readFileSync(join(root, path), 'utf8'))
  expect(undocumentedFlags(docs, cliSources)).toEqual([])
})

it('flags a documented flag that the CLI source does not carry', () => {
  expect(undocumentedFlags(['Use `--chunks` and `--mode`.'], ["'--mode'"])).toEqual(['--chunks'])
})
