import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import {
  approvalsSuggest,
  approvedShellCommands,
  buildSuggestReport,
  formatReport,
  suggestPrefixes,
} from '../src/commands/approvals-suggest.js'

let seq = 0
const decision = (
  command: unknown,
  over: { id?: string; option?: string; role?: string; code?: string; tool?: string; purpose?: string } = {},
): EventEnvelope =>
  ({
    seq: ++seq,
    type: 'decision/state',
    data: {
      handle: { id: over.id ?? `d${seq}` },
      request: {
        spec: {
          purpose: over.purpose ?? 'tool.permission',
          subject: { call: { name: over.tool ?? 'shell', args: { command } } },
        },
      },
      result: {
        reason: 'answered',
        ...(over.code ? { code: over.code } : {}),
        answeredBy: { role: over.role ?? 'owner' },
        response: { option: over.option ?? 'allowed-once' },
      },
    },
  }) as unknown as EventEnvelope

describe('approvedShellCommands', () => {
  it('keeps only shell commands a person allowed, using each decision at its last state', () => {
    const events = [
      decision('git status'),
      decision('git push', { option: 'rejected' }),
      decision('ls', { role: 'system', code: 'full-access' }),
      decision('ls', { role: 'agent' }),
      decision('echo', { tool: 'write' }),
      decision('echo', { purpose: 'plan.exit' }),
      decision({ contentRef: 'x' }),
      decision('cargo test', { id: 'same', option: 'rejected' }),
      decision('cargo test', { id: 'same', option: 'allowed-session' }),
      { seq: ++seq, type: 'assistant/message', data: {} } as unknown as EventEnvelope,
    ]
    expect(approvedShellCommands(events)).toEqual(['git status', 'cargo test'])
  })
})

describe('suggestPrefixes', () => {
  const commands = [
    ...Array(5).fill('git status'),
    ...Array(3).fill('git status -s'),
    ...Array(4).fill('cargo test -p x'),
    'cargo build',
    ...Array(6).fill('bash -c ls'),
    ...Array(6).fill('git -c a=b log'),
    ...Array(3).fill('ls -la'),
    ...Array(3).fill('git status; rm -rf /'),
  ]

  it('counts by the daemon prefix, drops banned and unprefixable commands, and honours the limits', () => {
    expect(suggestPrefixes(commands, { minCount: 2, limit: 20 })).toEqual([
      { prefix: ['git', 'status'], count: 8, example: 'git status', runsProjectCode: true },
      { prefix: ['cargo', 'test'], count: 4, example: 'cargo test -p x', runsProjectCode: true },
    ])
    expect(suggestPrefixes(commands, { minCount: 2, limit: 1 })).toHaveLength(1)
    expect(suggestPrefixes(commands, { minCount: 9, limit: 20 })).toEqual([])
  })

  it('skips prefixes an existing grant already covers', () => {
    expect(suggestPrefixes(commands, { minCount: 2, limit: 20 }, [['git', 'status']])).toEqual([
      { prefix: ['cargo', 'test'], count: 4, example: 'cargo test -p x', runsProjectCode: true },
    ])
  })

  it('shows a prefix without an example once any command in the group looks like it carries a credential', () => {
    const found = suggestPrefixes(['git push', 'git push API_KEY=hunter2', 'git push'], {
      minCount: 2,
      limit: 5,
    })
    expect(found).toEqual([{ prefix: ['git', 'push'], count: 3, runsProjectCode: true }])
    expect(JSON.stringify(found)).not.toContain('hunter2')
  })
})

describe('buildSuggestReport', () => {
  const ledgers: Record<string, EventEnvelope[]> = {
    a: [decision('git status'), decision('git status -s')],
    b: [decision('git status'), decision('make test')],
    c: [],
  }
  const read = async (id: string) => {
    if (id === 'broken') throw new Error('unreadable')
    return ledgers[id] ?? []
  }
  const opts = { days: 90, minCount: 2, limit: 20 }

  it('aggregates across sessions, counts unreadable ones and notes when grants were not compared', async () => {
    const report = await buildSuggestReport(['a', 'b', 'c', 'broken'], read, async () => undefined, opts)
    expect(report).toEqual({
      suggestions: [{ prefix: ['git', 'status'], count: 3, example: 'git status', runsProjectCode: true }],
      scannedSessions: 3,
      skippedSessions: 1,
      approvals: 4,
      grantsCompared: false,
      days: 90,
      minCount: 2,
    })
    expect(formatReport(report)).toContain('not compared with existing grants (no admin connection)')
    expect(formatReport(report)).toContain('1 session(s) could not be read')
    expect(formatReport(report).trimEnd().split('\n').at(-1)).toMatch(/approval card/)
  })

  it('leaves out what an existing grant covers and says nothing about comparison when it happened', async () => {
    const report = await buildSuggestReport(['a', 'b'], read, async () => [['git', 'status']], opts)
    expect(report.suggestions).toEqual([])
    expect(report.grantsCompared).toBe(true)
    expect(formatReport(report)).not.toContain('not compared')
  })

  it('renders untrusted command text inert', () => {
    const text = formatReport({
      suggestions: [{ prefix: ['x'], count: 2, example: 'x \u001b[31mred' }],
      scannedSessions: 1,
      skippedSessions: 0,
      approvals: 2,
      grantsCompared: true,
      days: 90,
      minCount: 2,
    })
    expect(text).not.toContain('\u001b')
  })
})

describe('approvalsSuggest arguments', () => {
  it.each([
    ['--days', '0'],
    ['--days', 'x'],
    ['--min-count', '0'],
    ['--limit', '1000'],
  ] as const)('refuses %s %s before reading anything', async (flag, value) => {
    const key = { '--days': 'days', '--min-count': 'minCount', '--limit': 'limit' }[flag]
    const p = { positional: ['suggest'], rest: [], json: false, [key]: value } as never
    const client = {
      session: {
        list: () => {
          throw new Error('must not list')
        },
      },
    } as never
    await expect(
      approvalsSuggest(p, client, { stdout: process.stdout, stderr: process.stderr }),
    ).rejects.toThrow(/must be an integer/)
  })
})
