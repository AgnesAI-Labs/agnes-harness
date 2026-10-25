import type { WorkspaceInfo } from '@agnes/cli-tui'
import type { JsonRpcNotification } from '@agnes/sdk'
import type { FakeTerminal } from '../src/tui/terminal.js'
import type { FakeEndpoint } from '../test/fake-endpoint.js'
import { laneCScenes } from './tui-gallery-scenes-timeline.js'

export type Ctx = { term: FakeTerminal; endpoint: FakeEndpoint; sessionId: string }
export type Scene = {
  id: string
  title: string
  cols?: number
  rows?: number
  locale?: 'zh-CN'
  timeline: { upto: number } & Record<string, unknown>
  handlers?: Record<string, () => unknown>
  ready?: string[]
  act?: (ctx: Ctx) => void
  done?: string[]
  /** Files the scene's working directory holds, for the `@` menu. */
  files?: string[]
  /** What the composer rail's git probe answers; the bare gallery cwd otherwise. */
  workspace?: WorkspaceInfo
  /** Gives the app a version. */
  welcome?: Record<string, never>
}

export const SID = 'agnes:local:default:cli:dm:4f9c2a7e'
/** Scenes the plan lists that the fakes cannot reach; none today. */
export const SKIPPED: Array<{ scene: string; reason: string }> = []

const text = (t: string) => [{ type: 'text', text: t }]
const user = (t: string) => ({ kind: 'user', id: 'u1', seq: 1, content: text(t) })
const timeline = (nodes: unknown[], extra: Record<string, unknown> = {}) => ({
  sessionId: SID,
  upto: nodes.length,
  generation: 1,
  opState: null,
  turns: [],
  nodes,
  ...extra,
})
const tool = (seq: number, name: string, status: string, summary: string, extra = {}) => ({
  kind: 'tool',
  id: `t${seq}`,
  seq,
  toolUseId: `call-${seq}`,
  name,
  status,
  summary,
  ...extra,
})
const usage = {
  totals: { input: 18_400, output: 2_150, cacheRead: 9_000, cacheWrite: 0, reasoning: 640 },
  cost: { usdMicros: 41_000, source: 'estimated', subscription: false },
  context: { tokens: 27_400, window: 262_144, autoCompact: true },
  model: { route: 'deepseek', id: 'deepseek-v4-pro', thinking: 'high' },
}

const ANSWER = `# Repository layout

The harness is split into **packages** with *narrow* exports; see [the docs](https://example.invalid/docs).

## Main parts

- \`packages/\` holds protocol, Core and clients
- \`docs/\` holds the guides

\`\`\`sh
mise exec -- node tools/toolchain/run.mjs typecheck
\`\`\`

### Packages

| Package | Role |
| --- | --- |
| cli-tui | Terminal UI |
| sdk | Client library |

> Keep changes focused and update tests with behaviour.`
const ZH_ANSWER = `# 仓库结构

代码按**包**拆分，导出面保持*最小*。推送前先运行 \`pnpm typecheck\`。

- \`packages/\`：协议、Core 和客户端
- \`docs/\`：使用指南

\`\`\`sh
mise exec -- node tools/toolchain/run.mjs typecheck
\`\`\`

| 包 | 职责 |
| --- | --- |
| cli-tui | 终端界面 |
| sdk | 客户端库 |

> 改动保持聚焦，测试随行为一起更新。`
const CONVERSATION = [
  user('Summarise the repository layout and how to run the checks.'),
  { kind: 'assistant', id: 'a1', seq: 2, text: ANSWER },
]
const LANE: WorkspaceInfo = {
  root: '~/agnes-harness',
  subpath: 'packages/web',
  worktree: 'lane-a',
  branch: 'feat/agh-plugin-core',
}
/** The composer rail's gauge at `tokens` of a 1M window that compacts at 85%. */
const railUsage = (tokens: number) => ({
  ...usage,
  context: { tokens, window: 1_000_000, autoCompact: true, compactAt: 850_000 },
  model: { route: 'agnes', id: 'GLM-5.3-Flash', thinking: 'high' },
})
const rail = (
  id: string,
  title: string,
  workspace: WorkspaceInfo,
  tokens: number,
  extra: Partial<Scene> = {},
) => ({
  id,
  title,
  cols: 120,
  timeline: timeline(CONVERSATION, { usage: railUsage(tokens) }),
  workspace,
  ready: ['behaviour', `${Math.round(tokens / 10_000)}%`],
  ...extra,
})
const typed =
  (...keys: string[]) =>
  (ctx: Ctx) => {
    for (const k of keys) ctx.term.feed(k)
  }

/** Read-only answers for the welcome's resource counts and recent sessions: sample data, not a daemon's. */
const WELCOME_HANDLERS: Record<string, () => unknown> = {
  '_agnes/v1/session.list': () => ({
    items: [
      { sessionId: SID, createdAt: '2026-10-21T09:00:00Z', lastSeq: 0, generation: 1, preset: 'standard' },
      {
        sessionId: 'agnes:local:default:cli:dm:a1',
        createdAt: '2026-10-21T10:30:00Z',
        lastSeq: 14,
        generation: 1,
        preset: 'standard',
        title: 'DevBoard v2 seed review',
      },
      {
        sessionId: 'agnes:local:default:cli:dm:a2',
        createdAt: '2026-10-20T10:30:00Z',
        lastSeq: 9,
        generation: 1,
        preset: 'standard',
        title: 'Cold-start profiling',
      },
    ],
  }),
  '_agnes/v1/session.tools': () => {
    const on = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `r${i}`, enabled: true, reasons: [] }))
    const source = { layer: 'default', name: 'gallery' }
    return {
      sessionId: SID,
      tools: [],
      resources: [],
      capabilities: {
        preset: 'standard',
        bundles: [],
        codePin: { legacy: false, packages: [] },
        loop: { value: { id: 'loop', version: '1' }, source },
        modelRoutes: { value: null, source },
        permissions: { preset: 'standard', policy: 'ask', toolRuntime: 'host', readOnly: false, source },
        sandbox: { provider: 'none', onUnavailable: 'allow', source },
        compaction: { engine: null, source },
        persistence: { provider: 'sqlite', source },
        tools: [],
        mcp: on(2),
        skills: on(8),
        modelAdapters: [],
        childEngines: [],
        childModels: [],
        uiModules: [],
        surfaces: [],
        packages: [],
        plugins: on(12),
        selectedModelAdapters: [],
      },
    }
  },
}
const WELCOME_WORKSPACE: WorkspaceInfo = {
  root: '~/agnes-harness',
  subpath: '',
  branch: 'feat/agh-plugin-core',
  ahead: 2,
}

/** The welcome at each breakpoint, plus the condensed return visit. */
function welcomeScenes(): Scene[] {
  const base = {
    timeline: timeline([], { usage }),
    handlers: WELCOME_HANDLERS,
    workspace: WELCOME_WORKSPACE,
    welcome: {},
    ready: ['local agent workbench', 'Cold-start profiling'],
  }
  return [
    { id: 'welcome', title: 'Empty session welcome, 132x40', cols: 132, rows: 40, ...base },
    { id: 'welcome-100x30', title: 'Welcome at 100x30', cols: 100, rows: 30, ...base },
    {
      id: 'welcome-70x24',
      title: 'Welcome at 70x24',
      cols: 70,
      rows: 24,
      ...base,
      ready: ['Start here', 'v0.9.3'],
    },
    {
      id: 'welcome-50x20',
      title: 'Welcome at 50x20',
      cols: 50,
      rows: 20,
      ...base,
      ready: ['agnes ·ᴗ· v0.9.3'],
    },
  ]
}

export const SCENES: Scene[] = [
  ...welcomeScenes(),
  {
    id: 'conversation',
    title: 'Full turn: user message and Markdown answer',
    timeline: timeline(CONVERSATION, { usage }),
    ready: ['Summarise', 'behaviour'],
  },
  {
    id: 'tools',
    title: 'Tool cards: collapsed success, running, error, one expanded',
    timeline: timeline([
      user('Check the build and fix what fails.'),
      tool(2, 'read', 'completed', 'read package.json'),
      tool(3, 'shell', 'running', 'pnpm typecheck'),
      tool(4, 'shell', 'failed', 'pnpm lint exited 1'),
      tool(5, 'edit', 'completed', 'edit src/index.ts', {
        argsPreview: '{"path":"src/index.ts","old":"let x","new":"const x"}',
        resultPreview: 'applied 1 replacement',
        enforcement: { level: 'partial', scope: ['file'] },
      }),
    ]),
    ready: ['edit src/index.ts'],
    act: typed('\x0f'),
    done: ['applied 1 replacement'],
  },
  {
    id: 'approval',
    title: 'Pending approval card',
    timeline: timeline([
      user('Clean the temporary directory.'),
      {
        kind: 'approval',
        id: 'ap1',
        seq: 2,
        state: 'pending',
        summary: 'shell rm -rf tmp',
        risk: 'destructive',
        options: ['allow_once', 'allow_always', 'reject_once'],
        decisionRef: { sessionId: SID, id: 'tk-abcdef123456', revision: 1 },
        expiresAt: '2026-10-20T00:00:00Z',
      },
    ]),
    ready: ['rm -rf tmp'],
  },
  {
    id: 'permission',
    title: 'Permission modal',
    timeline: timeline([user('Write the release notes file.')]),
    ready: ['release notes'],
    act: ({ endpoint, sessionId }) =>
      endpoint.push({
        jsonrpc: '2.0',
        id: 'perm-1',
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: 'tool-1',
            status: 'pending',
            title: 'write',
            rawInput: { path: 'docs/release-notes.md', bytes: 2048 },
          },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      } as JsonRpcNotification),
    done: ['Always allow'],
  },
  { id: 'slash-menu', title: 'Open slash menu', timeline: timeline([]), act: typed('/'), done: ['/exit'] },
  {
    id: 'mention-menu',
    title: 'Open @ file menu',
    timeline: timeline([]),
    files: ['README.md', 'packages/cli-tui/src/editor.ts', 'packages/cli-tui/src/app.ts', 'docs/cli/tui.md'],
    act: typed('look at @tui'),
    done: ['packages/cli-tui/'],
  },
  {
    id: 'model-picker',
    title: 'Model picker',
    timeline: timeline([]),
    handlers: {
      '_agnes/v1/apis.list': () => ({
        profile: {
          name: 'local-dev',
          resolvedProfileHash: 'h',
          presets: { default: 'standard', allowed: ['standard'] },
          models: [
            { route: 'deepseek', id: 'deepseek-v4-flash' },
            { route: 'deepseek', id: 'deepseek-v4-pro' },
            { route: 'account-kimi', id: 'kimi-for-coding-highspeed' },
          ],
        },
        families: [],
      }),
    },
    act: typed('/model', '\r'),
    done: ['Select Model', 'kimi-for-coding-highspeed'],
  },
  {
    id: 'session-picker',
    title: 'Session picker',
    timeline: timeline([]),
    handlers: {
      'session/load': () => ({}),
      '_agnes/v1/session.list': () => ({
        items: [
          [SID, '2026-10-19T09:00:00Z', 0, undefined],
          ['agnes:local:default:cli:session:newer', '2026-10-18T12:00:00Z', 14, 'Release checklist'],
          [
            'agnes:local:default:cli:session:older',
            '2026-10-11T08:30:00Z',
            8,
            'Refactor the projection window',
          ],
        ].map(([sessionId, createdAt, lastSeq, title]) => ({
          sessionId,
          createdAt,
          lastSeq,
          generation: 1,
          preset: 'standard',
          ...(title ? { title } : {}),
        })),
      }),
    },
    act: typed('/resume', '\r'),
    done: ['Select Session', 'Release checklist'],
  },
  {
    id: 'theme-picker',
    title: 'Theme picker',
    timeline: timeline([]),
    act: typed('/theme', '\r'),
    done: ['esc close'],
  },
  {
    id: 'busy',
    title: 'Busy turn: spinner, notice and usage line',
    timeline: timeline(CONVERSATION.slice(0, 1), {
      opState: { turn: 2, step: 1, phase: 'thinking' },
      usage,
      budget: { slot: 'primary', escalate: false, creditsUsed: 78, creditsCap: 100 },
    }),
    ready: ['Summarise'],
    act: ({ endpoint, sessionId }) =>
      endpoint.pushNotice({
        kind: 'resumed',
        sessionId,
        detail: { lastStep: 4 },
        at: new Date(0).toISOString(),
      }),
    done: ['credits 78/100', 'resumed'],
  },
  {
    id: 'busy-zh-CN',
    title: 'Busy turn, zh-CN: spinner, notice and usage line',
    locale: 'zh-CN',
    timeline: timeline(CONVERSATION.slice(0, 1), {
      opState: { turn: 2, step: 1, phase: 'thinking' },
      usage,
      budget: { slot: 'primary', escalate: false, creditsUsed: 78, creditsCap: 100 },
    }),
    ready: ['Summarise'],
    act: ({ endpoint, sessionId }) =>
      endpoint.pushNotice({
        kind: 'resumed',
        sessionId,
        detail: { lastStep: 4 },
        at: new Date(0).toISOString(),
      }),
    done: ['credits 78/100', '已续跑'],
  },
  {
    id: 'conversation-60',
    title: 'Full turn at 60×24',
    cols: 60,
    rows: 24,
    timeline: timeline(CONVERSATION, { usage }),
    ready: ['behaviour'],
  },
  {
    id: 'conversation-40',
    title: 'Full turn at 40×16',
    cols: 40,
    rows: 16,
    timeline: timeline(CONVERSATION, { usage }),
    ready: ['behaviour'],
  },
  {
    id: 'zh-CN',
    title: 'zh-CN conversation',
    locale: 'zh-CN',
    timeline: timeline(
      [
        user('介绍一下仓库结构，以及怎么运行检查。'),
        { kind: 'assistant', id: 'a1', seq: 2, text: ZH_ANSWER },
      ],
      { usage },
    ),
    ready: ['介绍一下', '改动保持聚焦'],
  },
  rail('rail-worktree', 'Composer rail: linked worktree in a subdirectory', LANE, 230_000),
  rail(
    'rail-detached',
    'Composer rail: detached HEAD',
    { root: '~/agnes-harness', subpath: '', detached: '16f42a3' },
    80_000,
  ),
  rail('rail-no-git', 'Composer rail: outside git', { root: '~/Downloads/notes', subpath: '' }, 20_000),
  rail('rail-gauge-normal', 'Composer rail gauge: 12%', LANE, 120_000),
  rail('rail-gauge-half', 'Composer rail gauge: 58%', LANE, 580_000),
  rail('rail-gauge-warning', 'Composer rail gauge: 78%, amber', LANE, 780_000),
  rail('rail-gauge-crossed', 'Composer rail gauge: 93%, past the compaction mark', LANE, 930_000),
  rail('rail-80', 'Composer rail at 80 columns: degraded labels', LANE, 230_000, { cols: 80, rows: 24 }),
  rail('rail-zh-CN', 'Composer rail, zh-CN hints', LANE, 230_000, {
    locale: 'zh-CN',
    ready: ['behaviour', '思考 高'],
  }),
  ...dialogScenes(),
  ...laneCScenes({ text, user, tool, timeline, usage, CONVERSATION, typed, SID }),
]

/** Picker, panel and menu scenes (UI review lane A): each in English, zh-CN and, where layout matters, 60 columns. */
function dialogScenes(): Scene[] {
  const DOWN = '\x1b[B'
  const models = (list: Array<[string, string, boolean?]>) => ({
    '_agnes/v1/apis.list': () => ({
      profile: {
        name: 'local-dev',
        resolvedProfileHash: 'h',
        presets: { default: 'standard', allowed: ['standard'] },
        models: list.map(([route, id, reasoning]) => ({ route, id, ...(reasoning ? { reasoning } : {}) })),
      },
      families: [],
    }),
  })
  const MODELS = models([
    ['deepseek', 'deepseek-v4-pro', true],
    ['deepseek', 'deepseek-v4-flash'],
    ['account-kimi', 'kimi-for-coding-highspeed'],
  ])
  const MANY = models(
    Array.from({ length: 20 }, (_, i): [string, string] => [
      'agnes',
      `model-${String(i + 1).padStart(2, '0')}`,
    ]),
  )
  const sessions = {
    'session/load': () => ({}),
    '_agnes/v1/session.list': () => ({
      items: [
        [SID, '2026-10-19T09:00:00Z', 0, undefined],
        ['agnes:local:default:cli:session:newer', '2026-10-18T12:00:00Z', 14, 'Release checklist'],
        [
          'agnes:local:default:cli:session:older',
          '2026-10-11T08:30:00Z',
          8,
          'Refactor the projection window',
        ],
        [
          'agnes:local:default:cli:session:oldest',
          '2026-09-30T08:30:00Z',
          31,
          'Why the status bar flickers on resize in narrow terminals',
        ],
      ].map(([sessionId, createdAt, lastSeq, title]) => ({
        sessionId,
        createdAt,
        lastSeq,
        generation: 1,
        preset: 'standard',
        ...(title ? { title } : {}),
      })),
    }),
  }
  /** Opens a picker with `open`, then types `keys` once its async list has arrived. */
  const afterOpen =
    (open: string[], ...keys: string[]) =>
    (ctx: Ctx) => {
      typed(...open)(ctx)
      setTimeout(() => typed(...keys)(ctx), 150)
    }
  const zh = { locale: 'zh-CN' } as const
  const narrow = { cols: 60, rows: 24 } as const
  const empty = { timeline: timeline([]), ready: ['/workspace/demo'] }
  const model = { ...empty, handlers: MODELS, act: typed('/model', '\r') }
  const resume = { ...empty, handlers: sessions, act: typed('/resume', '\r') }
  return [
    { id: 'dlg-model', title: 'Model picker', ...model, done: ['Select Model', 'kimi-for-coding-highspeed'] },
    {
      id: 'dlg-model-zh-CN',
      title: 'Model picker, zh-CN',
      ...zh,
      ...model,
      done: ['选择模型', 'kimi-for-coding-highspeed'],
    },
    {
      id: 'dlg-model-60',
      title: 'Model picker at 60x24',
      ...narrow,
      ...model,
      done: ['kimi-for-coding-highspeed'],
    },
    {
      id: 'dlg-reasoning',
      title: 'Reasoning-level picker',
      ...empty,
      handlers: MODELS,
      act: afterOpen(['/model', '\r'], '\r'),
      done: ['Reasoning Level', 'medium'],
    },
    {
      id: 'dlg-reasoning-zh-CN',
      title: 'Reasoning-level picker, zh-CN',
      ...zh,
      ...empty,
      handlers: MODELS,
      act: afterOpen(['/model', '\r'], '\r'),
      done: ['思考等级', 'medium'],
    },
    {
      id: 'dlg-reasoning-60',
      title: 'Reasoning-level picker at 60x24',
      ...narrow,
      ...empty,
      handlers: MODELS,
      act: afterOpen(['/model', '\r'], '\r'),
      done: ['medium'],
    },
    {
      id: 'dlg-sessions',
      title: 'Session picker, this workspace',
      ...resume,
      done: ['Select Session', 'Release checklist'],
    },
    {
      id: 'dlg-sessions-zh-CN',
      title: 'Session picker, zh-CN',
      ...zh,
      ...resume,
      done: ['选择会话', 'Release checklist'],
    },
    {
      id: 'dlg-sessions-60',
      title: 'Session picker at 60x24',
      ...narrow,
      ...resume,
      done: ['Release checklist'],
    },
    {
      id: 'dlg-sessions-all',
      title: 'Session picker after Tab, all workspaces',
      ...empty,
      handlers: sessions,
      act: afterOpen(['/resume', '\r'], '\t'),
      done: ['all workspaces', 'Release checklist'],
    },
    {
      id: 'dlg-sessions-all-zh-CN',
      title: 'Session picker after Tab, zh-CN',
      ...zh,
      ...empty,
      handlers: sessions,
      act: afterOpen(['/resume', '\r'], '\t'),
      done: ['全部工作区', 'Release checklist'],
    },
    { id: 'dlg-theme', title: 'Theme picker', ...empty, act: typed('/theme', '\r'), done: ['Theme'] },
    {
      id: 'dlg-theme-zh-CN',
      title: 'Theme picker, zh-CN',
      ...zh,
      ...empty,
      act: typed('/theme', '\r'),
      done: ['主题'],
    },
    {
      id: 'dlg-theme-60',
      title: 'Theme picker at 60x24',
      ...narrow,
      ...empty,
      act: typed('/theme', '\r'),
      done: ['Theme'],
    },
    {
      id: 'dlg-statusline',
      title: 'Status line picker',
      ...empty,
      act: typed('/statusline', '\r'),
      done: ['branch'],
    },
    {
      id: 'dlg-statusline-zh-CN',
      title: 'Status line picker, zh-CN',
      ...zh,
      ...empty,
      act: typed('/statusline', '\r'),
      done: ['状态'],
    },
    {
      id: 'dlg-statusline-60',
      title: 'Status line picker at 60x24',
      ...narrow,
      ...empty,
      act: typed('/statusline', '\r'),
      done: ['branch'],
    },
    {
      id: 'dlg-usage',
      title: 'Usage panel',
      timeline: timeline([], { usage }),
      ready: ['/workspace/demo'],
      act: typed('/usage', '\r'),
      done: ['Session usage'],
    },
    {
      id: 'dlg-usage-zh-CN',
      title: 'Usage panel, zh-CN',
      ...zh,
      timeline: timeline([], { usage }),
      ready: ['/workspace/demo'],
      act: typed('/usage', '\r'),
      done: ['会话用量'],
    },
    {
      id: 'dlg-usage-60',
      title: 'Usage panel at 60x24',
      ...narrow,
      timeline: timeline([], { usage }),
      ready: ['/workspace/demo'],
      act: typed('/usage', '\r'),
      done: ['Session usage'],
    },
    { id: 'dlg-slash', title: 'Slash menu', ...empty, act: typed('/'), done: ['/exit'] },
    { id: 'dlg-slash-zh-CN', title: 'Slash menu, zh-CN', ...zh, ...empty, act: typed('/'), done: ['/exit'] },
    {
      id: 'dlg-slash-60',
      title: 'Slash menu at 60x24',
      ...narrow,
      ...empty,
      act: typed('/'),
      done: ['/exit'],
    },
    {
      id: 'dlg-mention',
      title: '@ menu',
      ...empty,
      files: [
        'README.md',
        'packages/cli-tui/src/editor.ts',
        'packages/cli-tui/src/app.ts',
        'docs/cli/tui.md',
      ],
      act: typed('look at @tui'),
      done: ['packages/cli-tui/'],
    },
    {
      id: 'dlg-mention-zh-CN',
      title: '@ menu, zh-CN',
      ...zh,
      ...empty,
      files: [
        'README.md',
        'packages/cli-tui/src/editor.ts',
        'packages/cli-tui/src/app.ts',
        'docs/cli/tui.md',
      ],
      act: typed('look at @tui'),
      done: ['packages/cli-tui/'],
    },
    {
      id: 'dlg-mention-60',
      title: '@ menu at 60x24',
      ...narrow,
      ...empty,
      files: [
        'README.md',
        'packages/cli-tui/src/editor.ts',
        'packages/cli-tui/src/app.ts',
        'docs/cli/tui.md',
      ],
      act: typed('look at @tui'),
      done: ['packages/cli-tui/'],
    },
    {
      id: 'dlg-nomatch',
      title: 'Picker whose typed filter matches nothing',
      ...empty,
      handlers: MODELS,
      act: afterOpen(['/model', '\r'], 'zzzz'),
      done: ['zzzz'],
    },
    {
      id: 'dlg-nomatch-zh-CN',
      title: 'Picker whose typed filter matches nothing, zh-CN',
      ...zh,
      ...empty,
      handlers: MODELS,
      act: afterOpen(['/model', '\r'], 'zzzz'),
      done: ['zzzz'],
    },
    {
      id: 'dlg-long',
      title: 'Long model list, scrolled down',
      rows: 16,
      ...empty,
      handlers: MANY,
      act: afterOpen(['/model', '\r'], ...Array<string>(12).fill(DOWN)),
      done: ['❯ 13. agnes/model-13'],
    },
    {
      id: 'dlg-long-zh-CN',
      title: 'Long model list, scrolled down, zh-CN',
      rows: 16,
      ...zh,
      ...empty,
      handlers: MANY,
      act: afterOpen(['/model', '\r'], ...Array<string>(12).fill(DOWN)),
      done: ['❯ 13. agnes/model-13'],
    },
    {
      id: 'dlg-long-60',
      title: 'Long model list at 60x24, scrolled down',
      ...narrow,
      rows: 16,
      ...empty,
      handlers: MANY,
      act: afterOpen(['/model', '\r'], ...Array<string>(12).fill(DOWN)),
      done: ['❯ 13. agnes/model-13'],
    },
  ]
}
