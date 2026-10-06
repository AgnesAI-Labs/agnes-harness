import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { preparedRef } from './model-source-fixture.js'

const child = fileURLToPath(new URL('./fixtures/model-source-reader-child.ts', import.meta.url))
function coldRead(ref: unknown) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', child, JSON.stringify(ref)], {
    encoding: 'utf8',
    timeout: 60000,
  })
  if (run.status !== 0) throw new Error(`child failed: ${run.stderr}`)
  return JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as {
    ok: boolean
    digest?: string
    detailCode?: string
    network: number
  }
}

describe('model source reader in a fresh process', () => {
  it('names the lost prepared call, prepares nothing again and sends nothing', () => {
    expect(coldRead(preparedRef())).toEqual({ ok: false, detailCode: 'model_prepared_lost', network: 0 })
  })
})
