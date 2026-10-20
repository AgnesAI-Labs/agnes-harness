import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  functionKey,
  functionMeasurements,
  functionViolations,
  measureFunctions,
  RISK_DIRECTORIES,
} from './function-size.js'
import { reportFunctionStructure, structureChanges } from './function-structure-report.js'
import { assertBudgetNonIncrease, budgetGrowth } from './protected-allowances.js'
import { repoRoot } from './repo.js'
import { CODE_EXTENSIONS, productionFiles, withSourceTrees } from './source-ast.js'

const root = repoRoot()
const allowed = JSON.parse(
  readFileSync(join(root, 'tools/guards/function-size-allowlist.json'), 'utf8'),
) as Record<string, number>
const current = functionMeasurements(root)
const scratch = mkdtempSync(join(tmpdir(), 'agh-function-fixtures-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const body = Array.from({ length: 211 }, (_, n) => `void ${n};`).join('\n')
const fixtures = [
  ['declaration.ts', `function f(\n value: string\n) {\n${body}\n}`],
  ['expression.mts', `const f = function () {\n${body}\n}`],
  ['arrow.cts', `const f = () => {\n${body}\n}`],
  ['method.tsx', `const object = { f() {\n${body}\n} }; const view = <div/>;`],
  ['accessors.js', `const object = { get x() {\n${body}\n}, set x(value) {\n${body}\n} };`],
  ['callback.mjs', `function f() { [1].map(() => {\n${body}\n}); }`],
  ['nested.cjs', `const object = { f: () => { function inner() {\n${body}\n} } };`],
  ['compact.jsx', `const f = () => { ${body.replaceAll('\n', ' ')} }; const view = <div/>;`],
] as const
const paths = fixtures.map(([name, source]) => {
  const file = join(scratch, name)
  writeFileSync(file, source)
  return file
})
const samples = withSourceTrees(paths, (trees) =>
  trees.map((tree, index) => measureFunctions(tree, fixtures[index]?.[0] as string)),
)

describe('risk functions stay within 210 effective LOC, including nested functions', () => {
  it('measures all risk roots and refuses new/growing/stale allowances', () => {
    console.info(
      `Function effective LOC report: files=${current.files}, functions=${current.functions.length}`,
    )
    for (const fn of current.functions.filter((fn) => fn.lines > 210))
      console.info(
        `${functionKey(fn)}: LOC=${fn.lines}, statements=${fn.statements}, structure-sha256=${createHash('sha256').update(fn.structure).digest('hex')}`,
      )
    for (const change of reportFunctionStructure(root, current.functions)) console.info(change)
    expect(functionViolations(current.functions, allowed)).toEqual([])
    expect(assertBudgetNonIncrease(root, 'tools/guards/function-size-allowlist.json')).toEqual([])
  })
  it.each(fixtures.slice(0, -1).map(([name], index) => [name, index] as const))(
    '%s detects every function form',
    (_name, index) => {
      const functions = samples[index] as NonNullable<(typeof samples)[number]>
      expect(functions.some((fn) => fn.lines > 210)).toBe(true)
      expect(functionViolations(functions, {})).not.toEqual([])
    },
  )
  it('reports compact multiple statements honestly: LOC is not structural complexity', () => {
    const fn = samples.at(-1)?.[0]
    expect(fn?.lines).toBe(1)
    expect(fn?.statements).toBe(211)
    expect(fn?.structure).toContain('ExpressionStatement=211')
    if (!fn) throw new Error('missing compact fixture')
    expect(
      structureChanges([fn], [{ ...fn, statements: 1, structure: 'ExpressionStatement=1' }])[0],
    ).toContain('statements 1 -> 211')
  })
  it('rejects old node growth, node rename/move, stale entries, new ceilings and ceiling growth', () => {
    const fn = samples[0]?.[0]
    if (!fn) throw new Error('missing fixture')
    const budget = { [functionKey(fn)]: fn.lines }
    expect(functionViolations([fn], budget)).toEqual([])
    expect(functionViolations([{ ...fn, lines: fn.lines + 1 }], budget)).not.toEqual([])
    expect(functionViolations([{ ...fn, symbol: 'renamed' }], budget)).not.toEqual([])
    expect(functionViolations([{ ...fn, path: 'moved.ts' }], budget)).not.toEqual([])
    expect(functionViolations([{ ...fn, lines: 210 }], budget)).not.toEqual([])
    expect(functionViolations([], budget)).not.toEqual([])
    expect(budgetGrowth({ new: 211 }, {})).not.toEqual([])
    expect(budgetGrowth({ old: 212 }, { old: 211 })).not.toEqual([])
    expect(budgetGrowth({ old: 211 }, { old: 212 })).toEqual([])
  })
  it('fails closed on parse errors, missing files, unknown suffixes and empty roots', () => {
    const bad = join(scratch, 'bad.ts')
    writeFileSync(bad, 'function ( {')
    expect(() => withSourceTrees([bad], () => [])).toThrow(/Parse error/)
    expect(() => withSourceTrees([join(scratch, 'missing.ts')], () => [])).toThrow()
    expect(() => withSourceTrees([join(scratch, 'hidden.coffee')], () => [])).toThrow(/suffix/)
    expect(() => withSourceTrees([], () => [])).toThrow(/Empty/)
    expect(() => productionFiles(join(scratch, 'empty'))).toThrow(/Empty/)
    for (const dir of RISK_DIRECTORIES) {
      const abs = join(scratch, dir)
      mkdirSync(abs, { recursive: true })
      writeFileSync(join(abs, 'empty.ts'), 'export const value = 1')
    }
    expect(() => functionMeasurements(scratch)).toThrow(/Empty function scan/)
    expect(CODE_EXTENSIONS).toEqual(expect.arrayContaining(['.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']))
  })
})
