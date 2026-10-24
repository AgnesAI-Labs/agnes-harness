import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { buildPresentations } from '../../presentation-build.mjs'
import { countLines } from './count-lines.js'
import { PRESENTATION_NAMES, presentationSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()
const budgets = JSON.parse(
  readFileSync(join(root, 'tools/guards/presentation-budgets.json'), 'utf8'),
) as Record<string, { bytes: number; inputs: number }>

function violations(name: string, bytes: number, inputs: readonly string[]) {
  const budget = budgets[name]
  if (!budget) return [`Missing budget: ${name}`]
  const owner = `packages/package-manager/bundled-plugins/${name}/`
  return [
    ...(bytes > budget.bytes ? [`${name}: ${bytes} bytes > ${budget.bytes}`] : []),
    ...(inputs.length > budget.inputs ? [`${name}: ${inputs.length} inputs > ${budget.inputs}`] : []),
    ...inputs
      .filter((input) => !input.startsWith(owner) || input.includes('/node_modules/'))
      .map((input) => `${name}: embeds shared input ${input}`),
  ]
}
it('keeps every presentation inside its byte/input budget and embeds no host implementation', async () => {
  // Reconstruct metafiles from source rather than trusting an editable generated input list.
  const records = await buildPresentations({ check: true })
  expect(records.map((record) => record.name).sort()).toEqual([...PRESENTATION_NAMES].sort())
  expect(records.flatMap((record) => violations(record.name, record.bytes, record.inputs))).toEqual([])
  expect(violations('goal-ui', 1, ['packages/protocol/src/index.ts'])).toContain(
    'goal-ui: embeds shared input packages/protocol/src/index.ts',
  )
  const goalBudget = budgets['goal-ui']
  if (!goalBudget) throw new Error('Missing goal-ui budget')
  expect(violations('goal-ui', goalBudget.bytes + 1, [])).not.toEqual([])
})
it('fences handwritten presentation JS/MJS and TS, while generated JS has a byte budget', () => {
  const sources = presentationSourceFiles(root).map((file) => file.replaceAll('\\', '/'))
  expect(sources.some((file) => file.endsWith('/deliverables-ui/src/client-entry.mjs'))).toBe(true)
  expect(sources.filter((file) => file.endsWith('/src/client.js'))).toEqual([])
  for (const name of PRESENTATION_NAMES)
    expect(
      sources.some((file) => file.includes(`/bundled-plugins/${name}/src/`)),
      name,
    ).toBe(true)
  for (const file of sources)
    expect(countLines(readFileSync(file, 'utf8')), relative(root, file)).toBeLessThanOrEqual(800)
})
