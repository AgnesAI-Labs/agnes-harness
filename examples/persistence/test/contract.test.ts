import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  persistenceContract,
  persistenceHostContract,
} from '@agnes/extension-api/testkit/persistence-contract'
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

  persistenceHostContract('jsonl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agh-jsonl-host-contract-'))
    dirs.push(dir)
    return { open: () => persistenceProvider.open({ dataDir: dir }) }
  })

  it('declares that changing provider takes a restart', () => {
    expect(persistenceProvider).toMatchObject({
      id: 'jsonl',
      version: '1.0.0',
      capabilities: { ledger: true, metadata: true, childControl: true, reclaim: true, integrity: true },
      state: { effect: 'restart-required' },
    })
  })
})

it('refuses concurrent directory owners, repairs a torn tail, and rejects committed corruption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-jsonl-recovery-'))
  dirs.push(dir)
  const first = await persistenceProvider.open({ dataDir: dir })
  await first.open('k', { writerRunId: 'r', ttlMs: 60_000 })
  expect(() => persistenceProvider.open({ dataDir: dir })).toThrow(/already open/)
  await first.close()
  const path = join(dir, 'store.jsonl')
  const before = readFileSync(path, 'utf8')
  appendFileSync(path, '{"torn":')
  const second = await persistenceProvider.open({ dataDir: dir })
  expect(readFileSync(path, 'utf8')).toBe(before)
  if (!second.metadata) throw new Error('metadata missing')
  second.metadata.namespace('owner', 'config').set('a', 1)
  await second.close()
  const third = await persistenceProvider.open({ dataDir: dir })
  if (!third.metadata) throw new Error('metadata missing')
  expect(third.metadata.namespace('owner', 'config').get('a')).toBe(1)
  await third.close()
  writeFileSync(path, '{"bad":true}\n')
  expect(() => persistenceProvider.open({ dataDir: dir })).toThrow(/journal version/)
  expect(existsSync(join(dir, 'writer.json'))).toBe(false)
})
