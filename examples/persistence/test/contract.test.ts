import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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
  expect(readFileSync(path, 'utf8').startsWith(before)).toBe(true)
  const quarantine = readdirSync(dir).find((name) => name.includes('.tail-'))
  expect(quarantine).toBeDefined()
  if (!quarantine) throw new Error('Missing quarantine')
  expect(readFileSync(join(dir, quarantine), 'utf8')).toBe('{"torn":')
  expect(await second.open('k', { writerRunId: 'r', ttlMs: 60000 })).toMatchObject({
    recovery: { diagnosticId: expect.any(String), validThroughSeq: 0 },
  })
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

it('retains a complete final transaction without a newline and refuses a valid successor after corruption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-jsonl-prefix-'))
  dirs.push(dir)
  const first = await persistenceProvider.open({ dataDir: dir })
  if (!first.metadata) throw new Error('metadata missing')
  const config = first.metadata.namespace('owner', 'config')
  config.set('a', 1)
  config.set('b', 2)
  await first.close()
  const path = join(dir, 'store.jsonl')
  const bytes = readFileSync(path, 'utf8')
  writeFileSync(path, bytes.trimEnd())
  const second = await persistenceProvider.open({ dataDir: dir })
  expect(second.metadata?.namespace('owner', 'config').get('b')).toBe(2)
  await second.close()
  const lines = bytes.trimEnd().split('\n')
  const damaged = JSON.parse(lines[0] ?? '')
  damaged.digest = 'bad'
  const corrupted = `${[JSON.stringify(damaged), ...lines.slice(1)].join('\n')}\n`
  writeFileSync(path, corrupted)
  expect(() => persistenceProvider.open({ dataDir: dir })).toThrow(/Valid transactions follow/)
  expect(readFileSync(path, 'utf8')).toBe(corrupted)
})

it('quarantines a checksum-invalid final transaction while preserving earlier metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-jsonl-checksum-tail-'))
  dirs.push(dir)
  const first = await persistenceProvider.open({ dataDir: dir })
  if (!first.metadata) throw new Error('metadata missing')
  const ns = first.metadata.namespace('owner', 'config')
  ns.set('kept', 1)
  ns.set('damaged', 2)
  await first.close()
  const path = join(dir, 'store.jsonl')
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
  const tail = JSON.parse(lines.pop() ?? '')
  tail.digest = 'bad'
  const raw = `${JSON.stringify(tail)}\n`
  writeFileSync(path, `${lines.join('\n')}\n${raw}`)
  const second = await persistenceProvider.open({ dataDir: dir })
  try {
    expect(second.metadata?.namespace('owner', 'config').get('kept')).toBe(1)
    expect(second.metadata?.namespace('owner', 'config').get('damaged')).toBeUndefined()
    const quarantine = readdirSync(dir).find((name) => name.includes('.tail-'))
    if (!quarantine) throw new Error('Missing quarantine')
    expect(readFileSync(join(dir, quarantine), 'utf8')).toBe(raw)
  } finally {
    await second.close()
  }
})
