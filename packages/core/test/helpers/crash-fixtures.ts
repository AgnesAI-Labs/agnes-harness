import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MemoryStorage } from '../../src/log/memory-storage.js'
import type { RegisterRow } from '../../src/log/storage.js'
import type { Clock, Event } from '../../src/types.js'

/** The generated crash fixtures: a ledger prefix per file, with the program-counter cells beside it. */
export const crashDir = fileURLToPath(new URL('../../fixtures/crash/', import.meta.url))

export const crashFixtures = (): string[] =>
  readdirSync(crashDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()

export const crashEvents = (f: string): Event[] =>
  readFileSync(crashDir + f, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event)

/** The program-counter cells the store held when the prefix in `f` was cut. */
export const crashOpCells = (f: string): RegisterRow[] =>
  JSON.parse(readFileSync(crashDir + f.replace(/\.jsonl$/, '.op.json'), 'utf8')) as RegisterRow[]

/** The store a killed writer left behind at the cut `f` describes, rows and cells both. */
export const crashStorage = (
  f: string,
  opts: { clock?: Clock; lease?: { writerRunId: string; ttlMs: number } } = {},
): MemoryStorage => MemoryStorage.fromEvents('k', crashEvents(f), { ...opts, opCells: crashOpCells(f) })
