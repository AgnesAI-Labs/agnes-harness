import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../src/runtime/', import.meta.url))
const loopFiles = [
  ...readdirSync(join(root, 'loop')).map((name) => join(root, 'loop', name)),
  join(root, 'providers', 'loop.ts'),
]
describe('the Loop reaches the model only through the Model service', () => {
  it.each(loopFiles)('%s never names the model adapter contract or its methods', (file) => {
    const text = readFileSync(file, 'utf8')
    expect(text).not.toMatch(/agh\.model-adapter/)
    expect(text).not.toMatch(/model-adapter/)
  })
  it('the only action targets the default Loop plans are the selected context and model bindings', () => {
    const plan = readFileSync(join(root, 'loop', 'default-plan.ts'), 'utf8')
    const targets = [...plan.matchAll(/target:\s*selected\.(\w+)/g)].map((m) => m[1])
    expect(new Set(targets)).toEqual(new Set(['context', 'model']))
  })
})
