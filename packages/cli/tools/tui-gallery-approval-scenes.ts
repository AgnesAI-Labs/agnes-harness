import type { JsonRpcNotification } from '@agnes/sdk'
import type { Ctx, Scene } from './tui-gallery-scenes.js'

/** The two approval surfaces (timeline card, ACP permission modal) in both languages at 80 and 60 columns. */

// A local wall-clock time, so the card's `HH:MM` reads the same in every time zone.
const EXPIRES = new Date(2026, 9, 26, 20, 0).toISOString()
const OPTIONS = ['allow_once', 'allow_always', 'reject_once']
const SHELL_ARGS = { command: 'rm -rf tmp', cwd: '/workspace/demo' }
const subject = (name: string, args: unknown) => JSON.stringify({ call: { name, args } }, null, 2)

/** Blocks for longer than the misclick guard, so the next paint has the card's keys lit. */
const settleWait = (): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700)
}
const lit = settleWait
const typedLit =
  (...keys: string[]) =>
  (ctx: Ctx) => {
    settleWait()
    for (const k of keys) ctx.term.feed(k)
  }

const EDIT_ARGS = {
  path: 'src/index.ts',
  edits: [{ oldText: 'let retries = 1', newText: 'const retries = 3' }],
}

export function approvalScenes(sid: string): Scene[] {
  const ref = { sessionId: sid, id: 'tk-abcdef123456', revision: 1 }
  const pending = (extra: Record<string, unknown> = {}) => ({
    kind: 'approval',
    id: 'ap1',
    seq: 2,
    state: 'pending',
    toolName: 'shell',
    summary: 'rm -rf tmp',
    risk: 'destructive',
    options: OPTIONS,
    decisionRef: ref,
    expiresAt: EXPIRES,
    subjectText: subject('shell', SHELL_ARGS),
    ...extra,
  })
  const decided = (verdict: string, extra: Record<string, unknown> = {}) =>
    pending({
      state: 'decided',
      decision: { verdict, via: 'human' },
      subjectText: undefined,
      expiresAt: undefined,
      ...extra,
    })
  const line = (nodes: unknown[]) => ({
    sessionId: sid,
    upto: nodes.length + 1,
    generation: 1,
    opState: null,
    turns: [],
    nodes: [
      { kind: 'user', id: 'u1', seq: 1, content: [{ type: 'text', text: 'Clean the temp dir.' }] },
      ...nodes,
    ],
  })

  type Spec = Omit<Scene, 'timeline'> & { node?: unknown; timeline?: Scene['timeline'] }
  // One spec becomes four scenes: en and zh-CN, 80 and 60 columns.
  const quad = (spec: Spec): Scene[] =>
    [
      { suffix: '', cols: 80, locale: undefined, tag: '' },
      { suffix: '-60', cols: 60, locale: undefined, tag: ', 60 cols' },
      { suffix: '-zh', cols: 80, locale: 'zh-CN' as const, tag: ', zh-CN' },
      { suffix: '-zh-60', cols: 60, locale: 'zh-CN' as const, tag: ', zh-CN 60 cols' },
    ].map(({ suffix, cols, locale, tag }) => {
      const { node, timeline, ...rest } = spec
      return {
        rows: 32,
        ...rest,
        id: `${spec.id}${suffix}`,
        title: `${spec.title}${tag}`,
        cols,
        ...(locale ? { locale } : {}),
        timeline: timeline ?? line([node]),
      }
    })

  const card = (id: string, title: string, node: unknown, extra: Partial<Spec> = {}): Scene[] =>
    quad({ id: `approval-${id}`, title: `Approval card: ${title}`, node, ready: ['rm -rf tmp'], ...extra })

  const ask = (toolCall: Record<string, unknown>, options: unknown[]) => (ctx: Ctx) =>
    ctx.endpoint.push({
      jsonrpc: '2.0',
      id: 'perm-1',
      method: 'session/request_permission',
      params: {
        sessionId: ctx.sessionId,
        toolCall: { toolCallId: 'tool-1', status: 'pending', ...toolCall },
        options,
      },
    } as JsonRpcNotification)
  const THREE = [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ]
  const modal = (id: string, title: string, act: (ctx: Ctx) => void, extra: Partial<Spec> = {}): Scene[] =>
    quad({
      id: `permission-${id}`,
      title: `Permission modal: ${title}`,
      timeline: line([]),
      ready: ['Clean the temp dir.'],
      act,
      ...extra,
    })

  const longArgs = {
    path: 'docs/release-notes.md',
    sections: Array.from({ length: 14 }, (_, i) => ({ id: i + 1, title: `Section ${i + 1}`, draft: true })),
  }
  const afterKey = (key: string, inner: (ctx: Ctx) => void) => (ctx: Ctx) => {
    inner(ctx)
    setTimeout(() => ctx.term.feed(key), 100)
  }

  return [
    ...card('shell', 'shell command with cwd, keys lit', pending(), { act: lit }),
    ...card('unsettled', 'just arrived, keys dimmed', pending()),
    ...card(
      'edit',
      'edit with a diff',
      pending({
        toolName: 'edit',
        summary: 'edit src/index.ts',
        risk: 'always',
        subjectText: subject('edit', EDIT_ARGS),
      }),
      { ready: ['src/index.ts'], act: lit },
    ),
    ...card(
      'origin',
      'package, role and MCP origin',
      pending({ origin: { package: 'devboard', role: 'reviewer', mcpServer: 'github' } }),
      { act: lit },
    ),
    ...card(
      'prefix',
      'prefix grant offer',
      pending({
        toolName: 'shell',
        summary: 'git push origin main',
        subjectText: subject('shell', { command: 'git push origin main', cwd: '/workspace/demo' }),
        prefixGrant: { tokens: ['git', 'push'], scope: 'shell:prefix:["git","push"]', runsProjectCode: true },
        grantScopes: ['shell:git push'],
      }),
      { ready: ['git push origin main'], act: lit },
    ),
    ...card('allow-once', 'decided, allowed once', decided('allowed-once')),
    ...card('allow-session', 'decided, allowed for the session', decided('allowed-session')),
    ...card('rejected', 'decided, rejected', decided('rejected')),
    ...card(
      'rejected-reason',
      'decided, rejected with a reason',
      decided('rejected', {
        decision: { verdict: 'rejected', via: 'human', reason: 'use the staging bucket' },
      }),
    ),
    ...card(
      'expired',
      'expired',
      pending({ state: 'expired', subjectText: undefined, decision: { verdict: 'expired', via: 'system' } }),
    ),
    ...card('reason', 'typing a rejection reason', pending(), {
      ready: ['rm -rf tmp'],
      act: typedLit('r', 'u', 's', 'e', ' ', 's', 't'),
      done: ['use'],
    }),
    ...modal(
      'write',
      'write with JSON arguments',
      ask(
        {
          title: 'write',
          rawInput: { path: 'docs/release-notes.md', bytes: 2048, options: { overwrite: false } },
        },
        THREE,
      ),
      { done: ['release-notes.md'] },
    ),
    ...modal(
      'options',
      'many options in a short window',
      ask({ title: 'shell', rawInput: SHELL_ARGS }, [
        ...THREE.slice(0, 2),
        { optionId: 'ro', name: 'Allow read-only', kind: 'allow_once' },
        { optionId: 'rs', name: 'Allow for this repository', kind: 'allow_always' },
        { optionId: 'rj2', name: 'Reject always', kind: 'reject_always' },
        THREE[2],
      ]),
      { rows: 18, done: ['╭ '] },
    ),
    ...modal(
      'paged',
      'long arguments, paged with PgDn',
      afterKey('\x1b[6~', ask({ title: 'write', rawInput: longArgs }, THREE)),
      { rows: 16, done: ['Section'] },
    ),
    ...modal(
      'candidate',
      'plugin candidate test',
      ask(
        {
          title: 'ignored',
          rawInput: { packageId: 'acme.devboard', candidateHash: `sha256-${'ab12'.repeat(16)}` },
          _meta: { 'ai.agnes.harness': { tool: 'plugin_candidate_test' } },
        },
        THREE,
      ),
      { done: ['acme.devboard'] },
    ),
  ]
}
