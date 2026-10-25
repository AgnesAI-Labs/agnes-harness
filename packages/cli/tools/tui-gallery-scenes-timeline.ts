import type { Ctx, Scene } from './tui-gallery-scenes.js'

/** The builders of tui-gallery-scenes.ts, handed over so this file needs no import cycle. */
export type Kit = {
  text: (t: string) => unknown[]
  user: (t: string) => unknown
  tool: (
    seq: number,
    name: string,
    status: string,
    summary: string,
    extra?: Record<string, unknown>,
  ) => unknown
  timeline: (nodes: unknown[], extra?: Record<string, unknown>) => Scene['timeline']
  usage: unknown
  CONVERSATION: unknown[]
  typed: (...keys: string[]) => (ctx: Ctx) => void
  SID: string
}

/** Timeline blocks, notices, plan panel, pager and the other chrome around the conversation, each in en and zh-CN. */
export function laneCScenes(kit: Kit): Scene[] {
  const { text, user, tool, timeline, usage, CONVERSATION, typed, SID } = kit
  const zh = { locale: 'zh-CN' as const }
  const plan = (items: Array<[string, string]>) =>
    tool(2, 'todo', 'completed', 'update plan', {
      argsPreview: JSON.stringify({ items: items.map(([content, status]) => ({ content, status })) }),
    })
  const PLAN = plan([
    ['Read the config loader', 'completed'],
    ['Fix the parser edge case', 'in_progress'],
    ['Add a regression test', 'pending'],
    ['Run typecheck and lint', 'pending'],
  ])
  const ZH_PLAN = plan([
    ['阅读配置加载器', 'completed'],
    ['修复解析器边界情况', 'in_progress'],
    ['补一个回归测试', 'pending'],
    ['运行类型检查和 lint', 'pending'],
  ])
  const busy = { turn: 2, step: 1, phase: 'thinking' }
  const planScene = (id: string, title: string, nodes: unknown[], extra: Partial<Scene> = {}): Scene => ({
    id,
    title,
    timeline: timeline(nodes, { opState: busy, usage }),
    ready: ['Fix the parser', '修复解析器'].filter((_, i) => (extra.locale ? i === 1 : i === 0)),
    ...extra,
  })
  const askPlan = [user('Fix the parser bug.'), PLAN]
  const askZhPlan = [user('修一下解析器的 bug。'), ZH_PLAN]

  const notice = (
    id: string,
    title: string,
    act: NonNullable<Scene['act']>,
    done: string,
    extra: Partial<Scene> = {},
  ): Scene => ({
    id,
    title,
    timeline: timeline(CONVERSATION.slice(0, 1), { usage }),
    ready: ['Summarise'],
    act,
    done: [done],
    ...extra,
  })
  const daemonNotice =
    (kind: string, detail: Record<string, unknown> = {}) =>
    ({ endpoint, sessionId }: Ctx) =>
      endpoint.pushNotice({ kind, sessionId, detail, at: new Date(0).toISOString() })
  const oneModel = {
    '_agnes/v1/apis.list': () => ({
      profile: {
        name: 'local-dev',
        resolvedProfileHash: 'h',
        presets: { default: 'standard', allowed: ['standard'] },
        models: [{ route: 'deepseek', id: 'deepseek-v4-pro' }],
      },
      families: [],
    }),
  }
  const queuing = {
    '_agnes/v1/submit': () => ({ seq: 1, replayed: false }),
    '_agnes/v1/submit.ack': () => ({}),
    '_agnes/v1/session.controls': () => ({
      controls: { steer: true, interrupt: true },
      paused: false,
      pending: [
        {
          itemId: 'q1',
          target: 'next-turn',
          kind: 'follow_up',
          content: text('Then update the changelog.'),
        },
        { itemId: 'q2', target: 'next-turn', kind: 'follow_up', content: text('Also run the lint step.') },
      ],
    }),
  }
  const queuedTimeline = (extra: Record<string, unknown> = {}) =>
    timeline(CONVERSATION.slice(0, 1), { opState: busy, usage, ...extra })

  const SPECIAL = [
    user('Review the diff with a subagent and keep the build watcher running.'),
    plan([
      ['Spawn a reviewer', 'completed'],
      ['Collect the findings', 'in_progress'],
      ['Write the summary', 'pending'],
    ]),
    tool(3, 'subagent_spawn', 'running', 'spawned', {
      delegatedRole: { ref: 'agnes/base#reviewer', title: { en: 'Reviewer', 'zh-CN': '审阅者' } },
      delegatedTask: {
        childKey: 'child-1',
        task: 'Review the parser diff for edge cases',
        status: 'running',
      },
    }),
    tool(4, 'job_list', 'completed', '2 jobs running', { resultPreview: 'watch  running\nlint  done' }),
    tool(5, 'workflow_status', 'completed', 'release-checks: step 2/4', {}),
  ]
  const LONG_OUTPUT = Array.from(
    { length: 18 },
    (_, i) => `packages/cli-tui/src/views/file-${i + 1}.ts  ${i % 3 === 0 ? 'changed' : 'ok'}`,
  ).join('\n')
  const longTool = (extra = {}) =>
    tool(2, 'shell', 'completed', 'git status --short', {
      resultPreview: LONG_OUTPUT,
      resultSeq: 3,
      ...extra,
    })
  const EDIT_ARGS = JSON.stringify({
    path: 'src/parse.ts',
    edits: [
      {
        oldText: 'function parse(input) {\n  const parts = input.split(",")\n  return parts\n}',
        newText:
          'function parse(input: string) {\n  const parts = input.split(",").map((p) => p.trim())\n  if (parts.length === 0) return []\n  return parts\n}',
      },
    ],
  })
  const editNode = (extra = {}) =>
    tool(2, 'edit', 'completed', 'edit src/parse.ts', {
      argsPreview: EDIT_ARGS,
      resultPreview: 'applied 1 replacement',
      resultSeq: 3,
      ...extra,
    })
  const LSP = [
    'applied 1 replacement',
    'LSP found 3 errors in src/parse.ts:',
    "12:5 Cannot find name 'trim'",
    "14:9 Type 'string[]' is not assignable to type 'number[]'",
    "20:1 Unexpected token '}'",
  ].join('\n')
  /** What an expanded card reads from the daemon: the call's arguments and its result text, in one page. */
  const detail = (
    seq: number,
    name: string,
    args: unknown,
    result: string,
  ): Record<string, () => unknown> => ({
    '_agnes/v1/session.readToolDetail': () => {
      const body = JSON.stringify({
        call: { toolUseId: `call-${seq}`, name, args, ordinal: 0 },
        result: {
          toolUseId: `call-${seq}`,
          content: text(result),
          isError: false,
          authz: { decisionId: 'd1' },
          enforcement: { level: 'partial', scope: ['file'] },
        },
      })
      return {
        sessionId: SID,
        callSeq: seq,
        resultSeq: seq + 1,
        offset: 0,
        totalBytes: Buffer.byteLength(body),
        data: Buffer.from(body).toString('base64'),
        nextOffset: null,
      }
    },
  })
  const history = [
    user('Summarise the repository layout.'),
    { kind: 'assistant', id: 'a1', seq: 2, text: 'The harness splits into packages with narrow exports.' },
    user('And how do I run the checks?'),
    tool(4, 'shell', 'completed', 'pnpm typecheck', { resultPreview: 'no errors' }),
    { kind: 'assistant', id: 'a2', seq: 5, text: 'Run typecheck, lint and the guards from the repo root.' },
  ]
  const thought =
    'The user wants the layout. I should list the packages first, then point at the docs, and keep the answer short.'

  return [
    planScene('plan-panel', 'Plan panel above the prompt', askPlan),
    planScene('plan-panel-zh-CN', 'Plan panel, zh-CN', askZhPlan, zh),
    planScene('plan-panel-60', 'Plan panel at 60x24', askPlan, { cols: 60, rows: 24 }),
    planScene('plan-panel-40', 'Plan panel at 40x16 (one-line summary)', askPlan, { cols: 40, rows: 16 }),
    notice('notice-error', 'Notice: error', daemonNotice('worker_crashed'), 'interrupted'),
    notice('notice-success', 'Notice: success', daemonNotice('resumed', { lastStep: 4 }), 'resumed'),
    notice('notice-warning', 'Notice: warning', typed('\x1bp'), 'No other model', {
      handlers: oneModel,
    }),
    notice(
      'notice-info',
      'Notice: info (queued behind a running turn)',
      typed('Also run lint', '\r'),
      'Queued',
      {
        timeline: queuedTimeline(),
        handlers: queuing,
      },
    ),
    notice('notice-error-zh-CN', 'Notice: error, zh-CN', daemonNotice('worker_crashed'), '执行中断', zh),
    notice(
      'notice-success-zh-CN',
      'Notice: success, zh-CN',
      daemonNotice('resumed', { lastStep: 4 }),
      '已续跑',
      zh,
    ),
    notice('notice-warning-zh-CN', 'Notice: warning, zh-CN', typed('\x1bp'), '没有其他', {
      ...zh,
      handlers: oneModel,
    }),
    notice('notice-info-zh-CN', 'Notice: info, zh-CN', typed('再跑一遍 lint', '\r'), '已排队', {
      ...zh,
      timeline: queuedTimeline(),
      handlers: queuing,
    }),
    notice('notice-error-40', 'Notice: error at 40x16', daemonNotice('worker_crashed'), 'interrupted', {
      cols: 40,
      rows: 16,
    }),
    {
      id: 'special-cards',
      title: 'Special cards: plan, subagent, job, workflow',
      timeline: timeline(SPECIAL, { usage }),
      ready: ['Subagent'],
    },
    {
      id: 'special-cards-zh-CN',
      title: 'Special cards, zh-CN',
      ...zh,
      timeline: timeline(SPECIAL, { usage }),
      ready: ['子智能体'],
    },
    {
      id: 'special-cards-60',
      title: 'Special cards at 60x24',
      cols: 60,
      rows: 24,
      timeline: timeline(SPECIAL, { usage }),
      ready: ['Subagent'],
    },
    {
      id: 'special-cards-40',
      title: 'Special cards at 40x16',
      cols: 40,
      rows: 16,
      timeline: timeline(SPECIAL, { usage }),
      ready: ['Subagent'],
    },
    {
      id: 'local-command',
      title: 'Local command output (/queue)',
      timeline: queuedTimeline(),
      handlers: queuing,
      act: typed('/queue', '\r'),
      done: ['1. Then update'],
    },
    {
      id: 'local-command-zh-CN',
      title: 'Local command output (/queue), zh-CN',
      ...zh,
      ready: ['Summarise'],
      timeline: queuedTimeline(),
      handlers: queuing,
      act: typed('/queue', '\r'),
      done: ['1. Then update'],
    },
    {
      id: 'local-command-40',
      title: 'Local command output at 40x16',
      cols: 40,
      rows: 16,
      timeline: queuedTimeline(),
      handlers: queuing,
      act: typed('/queue', '\r'),
      done: ['1. Then'],
    },
    {
      id: 'lsp-note',
      title: 'LSP note on an edit card, collapsed',
      timeline: timeline([user('Fix the parser.'), editNode({ resultPreview: LSP })], { usage }),
      ready: ['LSP errors', 'trim'],
    },
    {
      id: 'lsp-note-expanded',
      title: 'LSP note on an edit card, expanded',
      timeline: timeline([user('Fix the parser.'), editNode({ resultPreview: LSP })], { usage }),
      handlers: detail(2, 'edit', JSON.parse(EDIT_ARGS), LSP),
      ready: ['LSP errors'],
      act: typed('\x0f'),
      done: ['Unexpected token'],
    },
    {
      id: 'lsp-note-zh-CN',
      title: 'LSP note, zh-CN',
      ...zh,
      timeline: timeline([user('修一下解析器。'), editNode({ resultPreview: LSP })], { usage }),
      ready: ['3'],
    },
    {
      id: 'lsp-note-40',
      title: 'LSP note at 40x16',
      cols: 40,
      rows: 16,
      timeline: timeline([user('Fix the parser.'), editNode({ resultPreview: LSP })], { usage }),
      ready: ['LSP errors'],
    },
    {
      id: 'tool-long-collapsed',
      title: 'Tool card with long output, collapsed',
      timeline: timeline([user('Show the changed files.'), longTool()], { usage }),
      ready: ['git status'],
    },
    {
      id: 'tool-long-expanded',
      title: 'Tool card with long output, expanded',
      rows: 40,
      timeline: timeline([user('Show the changed files.'), longTool()], { usage }),
      handlers: detail(2, 'shell', { command: 'git status --short' }, LONG_OUTPUT),
      ready: ['git status'],
      act: typed('\x0f'),
      done: ['file-18'],
    },
    {
      id: 'tool-long-collapsed-zh-CN',
      title: 'Tool card with long output, collapsed, zh-CN',
      ...zh,
      timeline: timeline([user('列出改动的文件。'), longTool()], { usage }),
      ready: ['git status'],
    },
    {
      id: 'tool-long-collapsed-40',
      title: 'Tool card with long output, collapsed, 40x16',
      cols: 40,
      rows: 16,
      timeline: timeline([user('Show the changed files.'), longTool()], { usage }),
      ready: ['git status'],
    },
    {
      id: 'tool-long-expanded-60',
      title: 'Tool card with long output, expanded, 60x30',
      cols: 60,
      rows: 30,
      timeline: timeline([user('Show the changed files.'), longTool()], { usage }),
      handlers: detail(2, 'shell', { command: 'git status --short' }, LONG_OUTPUT),
      ready: ['git status'],
      act: typed('\x0f'),
      done: ['file-18'],
    },
    {
      id: 'tool-edit-diff',
      title: 'Edit card with a diff, expanded',
      rows: 36,
      timeline: timeline([user('Make parse trim its parts.'), editNode()], { usage }),
      handlers: detail(2, 'edit', JSON.parse(EDIT_ARGS), 'applied 1 replacement'),
      ready: ['edit src/parse.ts'],
      act: typed('\x0f'),
      done: ['applied 1 replacement'],
    },
    {
      id: 'tool-edit-diff-zh-CN',
      title: 'Edit card with a diff, expanded, zh-CN',
      ...zh,
      rows: 36,
      timeline: timeline([user('让 parse 去掉空白。'), editNode()], { usage }),
      handlers: detail(2, 'edit', JSON.parse(EDIT_ARGS), 'applied 1 replacement'),
      ready: ['src/parse.ts'],
      act: typed('\x0f'),
      done: ['applied 1 replacement'],
    },
    {
      id: 'tool-edit-diff-40',
      title: 'Edit card with a diff, expanded, 40x24',
      cols: 40,
      rows: 24,
      timeline: timeline([user('Make parse trim its parts.'), editNode()], { usage }),
      handlers: detail(2, 'edit', JSON.parse(EDIT_ARGS), 'applied 1 replacement'),
      ready: ['src/parse.ts'],
      act: typed('\x0f'),
      done: ['applied 1 replacement'],
    },
    {
      id: 'queued-busy',
      title: 'Queued messages while a turn runs',
      timeline: queuedTimeline(),
      handlers: queuing,
      ready: ['Summarise'],
      act: typed('Then update the changelog.', '\r'),
      done: ['Queued'],
    },
    {
      id: 'queued-busy-60',
      title: 'Queued messages while a turn runs, 60x24',
      cols: 60,
      rows: 24,
      timeline: queuedTimeline(),
      handlers: queuing,
      ready: ['Summarise'],
      act: typed('Then update the changelog.', '\r'),
      done: ['Queued'],
    },
    {
      id: 'pager',
      title: 'Pager overlay (Ctrl-T)',
      rows: 24,
      timeline: timeline(history, { usage }),
      ready: ['run the checks'],
      act: typed('\x14'),
      done: ['you: Summarise'],
    },
    {
      id: 'pager-zh-CN',
      title: 'Pager overlay, zh-CN',
      ...zh,
      rows: 24,
      timeline: timeline(history, { usage }),
      ready: ['run the checks'],
      act: typed('\x14'),
      done: ['you: Summarise'],
    },
    {
      id: 'pager-search',
      title: 'Pager overlay with a search hit',
      rows: 24,
      timeline: timeline(history, { usage }),
      ready: ['run the checks'],
      act: typed('\x14', '/', 'checks', '\r'),
      done: ['you: Summarise'],
    },
    {
      id: 'pager-40',
      title: 'Pager overlay at 40x16',
      cols: 40,
      rows: 16,
      timeline: timeline(history, { usage }),
      ready: ['checks'],
      act: typed('\x14'),
      done: ['you: Summarise'],
    },
    {
      id: 'thinking',
      title: 'Finished reply with folded thoughts',
      timeline: timeline(
        [
          user('Summarise the repository layout.'),
          {
            kind: 'assistant',
            id: 'a1',
            seq: 2,
            text: 'Packages with narrow exports; see docs/.',
            thinking: thought,
          },
        ],
        { usage },
      ),
      ready: ['narrow exports', 'Thought'],
    },
    {
      id: 'thinking-zh-CN',
      title: 'Finished reply with folded thoughts, zh-CN',
      ...zh,
      timeline: timeline(
        [
          user('介绍一下仓库结构。'),
          {
            kind: 'assistant',
            id: 'a1',
            seq: 2,
            text: '按包拆分，导出面最小；详见 docs/。',
            thinking: thought,
          },
        ],
        { usage },
      ),
      ready: ['导出面最小'],
    },
    {
      id: 'interrupted',
      title: 'Interrupted turn: cancelled tool, lost output',
      timeline: timeline(
        [
          user('Run the whole test suite.'),
          tool(2, 'shell', 'cancelled', 'pnpm test'),
          { kind: 'assistant', id: 'a1', seq: 3, text: '', lostChars: 1200 },
        ],
        { usage },
      ),
      ready: ['pnpm test'],
    },
    {
      id: 'interrupted-zh-CN',
      title: 'Interrupted turn, zh-CN',
      ...zh,
      timeline: timeline(
        [
          user('运行全部测试。'),
          tool(2, 'shell', 'cancelled', 'pnpm test'),
          { kind: 'assistant', id: 'a1', seq: 3, text: '', lostChars: 1200 },
        ],
        { usage },
      ),
      ready: ['pnpm test'],
    },
    {
      id: 'timeline-rhythm',
      title: 'Timeline rhythm: user, reply, tool group, reply, user',
      rows: 36,
      timeline: timeline(
        [
          ...history.slice(0, 2),
          user('Check the build.'),
          tool(4, 'read', 'completed', 'read package.json'),
          tool(5, 'shell', 'completed', 'pnpm typecheck', { resultPreview: 'no errors' }),
          { kind: 'assistant', id: 'a2', seq: 6, text: 'The build is clean.' },
          user('Thanks.'),
        ],
        { usage },
      ),
      ready: ['Thanks.'],
    },
  ]
}
