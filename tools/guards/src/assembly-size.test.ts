// The Host assembly used to be one 2,700-line function sharing dozens of locals through a closure.
// It is now a sequence of stage modules that take an AssemblyContext and return typed results.
// These ceilings keep it that way: a stage that grows past them should be split by the state it
// shares, not by step name, and Computer Use's OS backends stay behind their own module.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countLines } from './count-lines.js'
import { listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()
const STAGE_DIRS = ['packages/host/src/runtime/assemble', 'packages/host/src/runtime/computer-use']
const MAX_FILE_LINES = 480
const MAX_ASSEMBLE_FILE_LINES = 330
const MAX_FUNCTION_LINES = 210
const MAX_ASSEMBLE_FUNCTION_LINES = 20

const stageFiles = (): string[] =>
  STAGE_DIRS.flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(root, dir, name)),
  )

/** Top-level functions of formatted source: `function` at column 0, closed by `}` at column 0. */
function topLevelFunctions(text: string): { name: string; lines: number }[] {
  const found: { name: string; lines: number }[] = []
  let current: { name: string; start: number } | undefined
  text.split('\n').forEach((line, index) => {
    const start = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)/.exec(line)
    if (start) current = { name: start[1] as string, start: index }
    else if (line === '}' && current) {
      found.push({ name: current.name, lines: index - current.start + 1 })
      current = undefined
    }
  })
  return found
}

describe('host assembly stays split into stages', () => {
  it('finds the stage modules it measures', () => {
    expect(stageFiles().length).toBeGreaterThan(20)
  })
  for (const file of stageFiles()) {
    const name = relative(root, file).split(sep).join('/')
    it(`${name} stays under its line ceiling`, () => {
      const max = name.endsWith('/assemble/assemble.ts') ? MAX_ASSEMBLE_FILE_LINES : MAX_FILE_LINES
      expect(countLines(readFileSync(file, 'utf8')), name).toBeLessThanOrEqual(max)
    })
    it(`${name} has no function above the function ceiling`, () => {
      const oversized = topLevelFunctions(readFileSync(file, 'utf8')).filter(
        (fn) => fn.lines > MAX_FUNCTION_LINES,
      )
      expect(oversized, name).toEqual([])
    })
  }
  it('assemble() only sequences the phases', () => {
    const assemble = topLevelFunctions(
      readFileSync(join(root, 'packages/host/src/runtime/assemble/assemble.ts'), 'utf8'),
    ).find((fn) => fn.name === 'assemble')
    expect(assemble?.lines).toBeLessThanOrEqual(MAX_ASSEMBLE_FUNCTION_LINES)
  })
  it('only the Computer Use module (and the public export barrel) names an OS driver backend', () => {
    const osBackend = /@agnes\/host-computer-use\/computer-use\/(?:windows|macos|linux)-driver-/
    const hostSrc = join(root, 'packages/host/src')
    expect(existsSync(hostSrc)).toBe(true)
    const offenders = listSourceFiles(hostSrc)
      .filter((file) => osBackend.test(readFileSync(file, 'utf8')))
      .map((file) => relative(hostSrc, file).split(sep).join('/'))
      .filter((file) => file !== 'index.ts' && !file.startsWith('runtime/computer-use/'))
    expect(offenders).toEqual([])
  })
})
