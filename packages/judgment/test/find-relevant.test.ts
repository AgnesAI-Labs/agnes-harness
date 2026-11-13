import type { ToolContext } from '@agnes/extension-api'
import { expect, it, vi } from 'vitest'
import type { Judge, JudgeOutcome } from '../src/judge.js'
import { findRelevant } from '../src/uses/find-relevant.js'
import { findInput } from '../src/uses/tool-input.js'

function fixture(count: number, text = 'semantic match\n') {
  const reads = new Map<string, number>()
  const fs = {
    stat: async (path: string) => ({
      kind: path === '/repo' ? 'dir' : 'file',
      size: Buffer.byteLength(text),
      mtimeMs: 1,
    }),
    list: async () =>
      Array.from({ length: count }, (_, n) => ({ name: `f${String(n).padStart(3, '0')}.ts`, kind: 'file' })),
    read: async (path: string, opts: { limit: number }) => {
      expect(opts.limit).toBe(1048576)
      reads.set(path, (reads.get(path) ?? 0) + 1)
      return Buffer.from(text)
    },
  }
  return {
    ctx: { fs, session: { toolUseId: 'synthetic', workspaceRoot: '/repo' } } as unknown as ToolContext,
    reads,
  }
}
function scoring(
  record: { purpose: string; size: number; state: unknown }[],
  scores: Record<string, number> = {},
): Judge {
  return {
    async judge(purpose, req, opts) {
      expect(opts.retry).toBe('once')
      expect(opts.attemptMs).toBe(10000)
      const entries = (req.state as { entries: unknown[] }).entries
      record.push({ purpose, size: entries.length, state: req.state })
      return {
        status: 'ok',
        answers: Object.fromEntries(
          Object.keys(req.questions).map((id) => [id, { type: 'noul', noul: scores[purpose] ?? 0.8 }]),
        ),
        cached: false,
        model: 'm',
        backend: 'native',
        probabilityAvailable: true,
        accounting: { calls: [] },
      } as JudgeOutcome
    },
  }
}
it('runs bounded name, sketch and verify stages with fresh reads and stable ranked matches', async () => {
  const f = fixture(128),
    seen: { purpose: string; size: number; state: unknown }[] = []
  const result = await findRelevant(
    scoring(seen),
    f.ctx,
    { query: 'semantic' },
    new AbortController().signal,
    Date.now() + 20000,
  )
  expect(seen.filter((row) => row.purpose === 'judgment.find.names').map((row) => row.size)).toEqual([64, 64])
  expect(result.filesJudged).toBe(20)
  expect(result.matches).toHaveLength(20)
  expect(result.matches[0]).toEqual({ path: '/repo/f000.ts', startLine: 1, endLine: 1, score: 0.8 })
  expect([...f.reads.values()].filter((n) => n === 2)).toHaveLength(20)
  expect([...f.reads.values()].filter((n) => n === 1)).toHaveLength(108)
  expect(result.partial).toBe(true)
  expect(result.reasons).toContain('semantic_file_limit')
})
it('keeps sketches at 46, verifies at most 40 above 0.45 and merges adjacent matches above 0.20', async () => {
  const f = fixture(3, `${'x'.repeat(8190)}\n`.repeat(24)),
    seen: { purpose: string; size: number; state: unknown }[] = []
  const result = await findRelevant(
    scoring(seen, { 'judgment.find.sketches': 0.45, 'judgment.find.verify': 0.2 }),
    f.ctx,
    { query: 'x' },
    new AbortController().signal,
    Date.now() + 20000,
  )
  expect(seen.filter((row) => row.purpose === 'judgment.find.sketches').map((row) => row.size)).toEqual([
    46, 26,
  ])
  expect(
    seen.filter((row) => row.purpose === 'judgment.find.verify').reduce((n, row) => n + row.size, 0),
  ).toBe(40)
  expect(result.matches).toEqual([
    { path: '/repo/f000.ts', startLine: 1, endLine: 24, score: 0.2 },
    { path: '/repo/f001.ts', startLine: 1, endLine: 16, score: 0.2 },
  ])
  expect(result.reasons).toContain('verify_limit')
  const sketches = seen
    .filter((row) => row.purpose === 'judgment.find.sketches')
    .flatMap((row) => (row.state as { entries: { value: { summary: string } }[] }).entries)
  expect(sketches.every((row) => row.value.summary.length <= 256)).toBe(true)
})
it('distinguishes all failed judgment from an empty finding and keeps failure accounting', async () => {
  const f = fixture(1),
    judge: Judge = {
      judge: async () => ({
        status: 'failed',
        reason: 'error',
        accounting: {
          calls: [
            {
              invocationId: 'f',
              target: { route: 'r', model: 'm' },
              replayed: false,
              dispatch: 'may-have-sent',
            },
          ],
        },
      }),
    }
  const result = await findRelevant(
    judge,
    f.ctx,
    { query: 'semantic' },
    new AbortController().signal,
    Date.now() + 20000,
  )
  expect(result.matches).toEqual([])
  expect(result.failures).toBeGreaterThan(0)
  expect(result.partial).toBe(true)
  expect(result.message).toContain('does not mean')
  expect(result.message).toContain('grep')
  expect(result.accounting.calls).toHaveLength(1)
})
it('refuses paths outside the workspace before reading or judging and returns traversal cancellation explicitly', async () => {
  const f = fixture(1),
    seen: { purpose: string; size: number; state: unknown }[] = []
  const result = await findRelevant(
    scoring(seen),
    f.ctx,
    { query: 'x', path: '/other' },
    new AbortController().signal,
    Date.now() + 20000,
  )
  expect(result.reasons).toContain('unsafe_root')
  expect(f.reads.size).toBe(0)
  expect(seen).toEqual([])
  const controller = new AbortController()
  controller.abort()
  const cancelled = await findRelevant(
    scoring(seen),
    f.ctx,
    { query: 'x' },
    controller.signal,
    Date.now() + 20000,
  )
  expect(cancelled.partial).toBe(true)
  expect(cancelled.reasons).toContain('cancelled')
  const expired = await findRelevant(
    scoring(seen),
    f.ctx,
    { query: 'x' },
    new AbortController().signal,
    Date.now() - 1,
  )
  expect(expired.partial).toBe(true)
  expect(f.reads.size).toBe(0)
  const traversing = fixture(10)
  let elapsed = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => elapsed)
  try {
    const ctx = {
      ...traversing.ctx,
      fs: {
        ...traversing.ctx.fs,
        read: async (path: string, opts?: { offset?: number; limit?: number }) => {
          const bytes = await traversing.ctx.fs.read(path, opts)
          elapsed += 11
          return bytes
        },
      },
    } as ToolContext
    const timed = await findRelevant(scoring(seen), ctx, { query: 'x' }, new AbortController().signal, 20)
    expect(timed.partial).toBe(true)
    expect(timed.reasons).toContain('cancelled')
    expect([...traversing.reads.values()].reduce((sum, n) => sum + n, 0)).toBe(2)
  } finally {
    clock.mockRestore()
  }
})

it('redacts complete fresh source context before any summary or verify window leaves the tool', async () => {
  const f = fixture(1, `password="${'synthetic-sensitive-value'.repeat(1000)}"\nsemantic sample\n`)
  const seen: { purpose: string; size: number; state: unknown }[] = []
  const input = findInput({ query: 'semantic password="query-pass"' })
  if (!input) throw new Error('Input refused')
  const result = await findRelevant(
    scoring(seen),
    f.ctx,
    input,
    new AbortController().signal,
    Date.now() + 20000,
  )
  expect(result.matches.length).toBeGreaterThan(0)
  expect(JSON.stringify(seen)).not.toContain('synthetic-sensitive-value')
  expect(seen.every((row) => !JSON.stringify(row.state).includes('query-pass'))).toBe(true)
  expect(seen.some((row) => row.purpose === 'judgment.find.verify')).toBe(true)
})
