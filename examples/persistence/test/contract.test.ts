import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistenceContract } from '@agnes/extension-api/testkit/persistence-contract'
import { afterAll, describe, expect, it } from 'vitest'
import { persistenceProvider } from '../src/index.js'

const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('jsonl persistence provider', () => {
  persistenceContract('jsonl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-jsonl-'))
    dirs.push(dir)
    return { open: () => persistenceProvider.open({ dataDir: dir }) }
  })

  it('declares that changing provider takes a restart', () => {
    expect(persistenceProvider).toMatchObject({
      id: 'jsonl',
      version: '1.0.0',
      capabilities: { ledger: true, integrity: true },
      state: { effect: 'restart-required' },
    })
  })
})
