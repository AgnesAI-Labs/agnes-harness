import type { JsonRpcNotification } from '@agnes/sdk'
import type { FakeTerminal } from '../src/tui/terminal.js'
import type { FakeEndpoint } from '../test/fake-endpoint.js'

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
const typed =
  (...keys: string[]) =>
  (ctx: Ctx) => {
    for (const k of keys) ctx.term.feed(k)
  }

export const SCENES: Scene[] = [
  { id: 'welcome', title: 'Empty session welcome', timeline: timeline([]) },
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
  { id: 'slash-menu', title: 'Open slash menu', timeline: timeline([]), act: typed('/'), done: ['/help'] },
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
    done: ['Esc cancel'],
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
]
