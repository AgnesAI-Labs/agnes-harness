import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { MemoryParagraphChange, MemoryParagraphPort, MemoryProposal } from '../src/index.js'
import { type MemoryParagraphFixture, memoryParagraphConformance } from '../testkit/index.js'

type Flaw = 'none' | 'ignores-base' | 'skips-bad-member' | 'commits-each' | 'no-hash'

const conflict = () => Object.assign(new Error('stale'), { code: 'MEMORY_CONFLICT' })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

/** A tiny reference: the stored file is a JSON map of id to text. */
function fixture(flaw: Flaw): MemoryParagraphFixture {
  let stored: Record<string, string> = {}
  let edits = 0
  const text = () => JSON.stringify(stored)
  const plans = new Map<string, Record<string, string>>()
  const apply = (base: Record<string, string>, changes: readonly MemoryParagraphChange[]) => {
    const next = { ...base }
    const seen = new Set<string>()
    for (const change of changes) {
      const bad = seen.has(change.id) || (change.op === 'remove' && !Object.hasOwn(next, change.id))
      seen.add(change.id)
      if (bad) {
        if (flaw === 'skips-bad-member') continue
        throw Object.assign(new Error('invalid change'), { code: 'MEMORY_PARAGRAPH_INVALID' })
      }
      if (change.op === 'put') next[change.id] = change.text
      else delete next[change.id]
    }
    return next
  }
  const port: MemoryParagraphPort = {
    list: async () =>
      ({
        ...(flaw === 'no-hash' ? {} : { hash: hash(text()) }),
        paragraphs: Object.entries(stored).map(([id, body]) => ({ id, text: body, validity: 'valid' })),
      }) as Awaited<ReturnType<MemoryParagraphPort['list']>>,
    async propose(changes, baseHash) {
      if (baseHash !== undefined && baseHash !== hash(text()) && flaw !== 'ignores-base') throw conflict()
      const list = Array.isArray(changes) ? changes : [changes as MemoryParagraphChange]
      if (flaw === 'commits-each' && list.length > 1) {
        stored = apply(stored, list.slice(0, 1))
        apply(stored, list.slice(1))
      }
      const next = apply(stored, list)
      const newHash = hash(JSON.stringify(next))
      plans.set(newHash, next)
      return {
        path: 'MEMORY.md',
        baseHash: hash(text()),
        newHash,
        diff: '',
        source: { sessionKey: 's', turn: 0 },
      }
    },
    async commit(proposal: MemoryProposal) {
      if (proposal.baseHash !== hash(text())) throw conflict()
      stored = plans.get(proposal.newHash)!
      return { hash: hash(text()) }
    },
  }
  return {
    port,
    ids: ['r0000000001', 'r0000000002', 'r0000000003'],
    async editStored() {
      edits++
      stored = { ...stored, [`human${edits}`]: 'a person wrote this' }
    },
  }
}

describe('memoryParagraphConformance', () => {
  it('passes a port that is base-aware and applies a batch in one commit', async () => {
    expect(await memoryParagraphConformance(async () => fixture('none'))).toEqual([
      'list',
      'single-change-without-base',
      'batch-in-one-commit',
      'stale-base-refused',
      'stale-commit-refused',
      'all-or-nothing',
    ])
  })

  it.each([
    ['ignores-base', 'stale-base-refused'],
    ['skips-bad-member', 'all-or-nothing'],
    ['commits-each', 'all-or-nothing'],
    ['no-hash', 'list'],
  ] as const)('refuses a port that %s', async (flaw, failingCase) => {
    await expect(memoryParagraphConformance(async () => fixture(flaw))).rejects.toThrow(failingCase)
  })
})
