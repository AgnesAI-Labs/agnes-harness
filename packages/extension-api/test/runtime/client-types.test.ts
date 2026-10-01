import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('compiles client consumers with readonly pages and rejects authority exports', () => {
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--ignoreConfig',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--strict',
      '--exactOptionalPropertyTypes',
      '--noUncheckedIndexedAccess',
      '--noEmit',
      '--skipLibCheck',
      '--types',
      'node',
      fileURLToPath(new URL('./client-types.compile.ts', import.meta.url)),
    ],
    { encoding: 'utf8', timeout: 30_000 },
  )
  expect(result.error).toBeUndefined()
  expect(result.stdout + result.stderr).toBe('')
  expect(result.status).toBe(0)
})
