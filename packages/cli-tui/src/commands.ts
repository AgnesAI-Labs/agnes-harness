import { readdirSync } from 'node:fs'
import type {
  ComputerUseDoctorResult,
  ComputerUseStatusResult,
  ContentBlock,
  SlotName,
  ThinkingLevel,
} from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import type { TuiApp } from './app.js'
import { inheritFreshSession, writeComposerMemoryFile } from './composer-memory.js'
import type { ResourceCommandKind } from './resource-controller.js'
import { freshTuiSessionKey } from './session-key.js'
import type { TuiThemeName } from './theme.js'
import { formatContextBreakdown, formatUsageReport } from './usage-details.js'

export type SlashCommand = {
  name: string
  /** Argument shape shown dimmed next to the name in the slash menu, e.g. `<seq>`. */
  args?: string
  /** One-line description shown dimmed under the menu for the highlighted command. */
  description: string
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/help', description: '列出全部斜杆命令及用法' },
  { name: '/quit', description: '退出 TUI' },
  { name: '/new', description: '新建会话并切换过去' },
  { name: '/resume', args: '[id]', description: '恢复指定会话；缺省时打开会话选择器' },
  { name: '/sessions', description: '列出最近的会话' },
  { name: '/cost', description: '显示本会话累计用量和费用' },
  { name: '/usage', description: '查看 Token、缓存、推理和上下文估算' },
  { name: '/computer-use', args: 'status', description: '查看 Computer Use 的只读准入状态' },
  { name: '/doctor', args: 'computer-use', description: '查看 Computer Use 的只读诊断状态' },
  { name: '/rewind', args: '<seq>', description: '从指定序号分叉出新会话' },
  { name: '/compact', args: '[instructions]', description: '通过当前压缩策略手动压缩上下文' },
  { name: '/preset', args: '<name>', description: '切换预设' },
  { name: '/theme', args: '[light|dark|mono]', description: '切换当前 TUI 的明亮、深色或无色主题' },
  {
    name: '/model',
    args: '[<slot> <route>/<model> [<thinking>]]',
    description: '列出可用模型并选择，或直接切换指定槽位（可选带上 thinking 档）',
  },
  { name: '/yolo', description: '本会话剩余部分跳过全部审批，一旦开启不可撤销' },
  { name: '/export', description: '导出当前会话' },
  { name: '/refine', description: '查看精炼提案（尚未投影到时间线）' },
  { name: '/packages', description: '查看已安装插件及其期望/实际状态' },
  { name: '/install', args: '<source>|confirm|cancel', description: '预览、确认或取消插件安装' },
  {
    name: '/package',
    args: '[status|catalog|inspect|trust|enable|disable|update|rollback|remove|operation|cancel] ...',
    description: '管理插件生命周期并查询或取消持久化操作',
  },
  { name: '/skills', description: '查看 Skill 的信任、期望与实际状态' },
  { name: '/skill', args: 'refresh|trust ...', description: '刷新或确认 Skill 修订' },
  { name: '/mcp', args: '<action> ...', description: '管理 MCP 定义、连接和工具目录' },
  { name: '/context', description: '按分段查看当前上下文占用与已知贡献冲突' },
]

export function slashCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((c) => c.name === name)
}

export type ModelChoice = {
  route: string
  model: string
  reasoning: boolean
  thinkingLevelMap?: Record<string, string>
}
export type SessionChoice = {
  sessionId: string
  createdAt: string
  lastSeq: number
  preset: string
  title?: string
}

export type SlashResult = {
  text?: string
  details?: boolean
  /** Long-lived local output belongs in the transcript; omitted text is a short status notice. */
  presentation?: 'transcript'
  title?: string
  switchSession?: Session
  modelChoices?: ModelChoice[]
  sessionChoices?: SessionChoice[]
  quit?: boolean
}

function renderComputerUseStatus(report: ComputerUseStatusResult): string {
  return [
    `Computer Use: ${report.status}`,
    `admission: ${report.admission.state} (${report.admission.reason})`,
    `runtime: ${report.runtime.state}; start attempted: ${String(report.runtime.startAttempted)}`,
    'blockers:',
    ...report.blockers.map((blocker) => `  - ${blocker}`),
  ].join('\n')
}

function renderComputerUseDoctor(report: ComputerUseDoctorResult): string {
  return [
    `Computer Use doctor: ${report.status}`,
    `admission: ${report.admission.state} (${report.admission.reason})`,
    `checks: ${report.checks.state} (${report.checks.reason})`,
  ].join('\n')
}

// `<slot> <route>/<model>`: the slot name has no slash, the route/model pair does, and the model
// half can itself contain slashes (e.g. a vendor/model path), so only the first slash after the
// route token is significant.
const MODEL_ARGS = /^([A-Za-z_]+)\s+([^/\s]+)\/(\S+?)(?:\s+(off|minimal|low|medium|high|xhigh|max))?$/

/** `resumableFrom` (the picker): only other sessions this TUI's workspace can load. */
async function listSessionChoices(session: Session, resumableFrom?: string): Promise<SessionChoice[]> {
  const items: Awaited<ReturnType<typeof session.client.session.list>>['items'] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  while (true) {
    const page = await session.client.session.list({ limit: 500, ...(cursor ? { cursor } : {}) })
    items.push(...page.items)
    if (!page.next) break
    if (cursors.has(page.next)) throw new Error('session listing cursor did not advance')
    cursors.add(page.next)
    cursor = page.next
  }
  // daemon binds a session to its canonical workspace root and refuses to load it from another one
  // (ID_CONFLICT), while the list spans every workspace. The open session's own row carries this
  // TUI's canonical root; the raw cwd stands in when that row has none. Unbound rows stay offered.
  const here = items.find((item) => item.sessionId === session.id)?.cwd ?? resumableFrom
  return items
    .filter((i) => resumableFrom === undefined || (i.sessionId !== session.id && (i.cwd ?? here) === here))
    .map((item) => ({
      sessionId: item.sessionId,
      createdAt: item.createdAt,
      lastSeq: item.lastSeq,
      preset: item.preset,
      ...(item.title ? { title: item.title } : {}),
    }))
    .sort((a, b) => {
      const aTime = Date.parse(a.createdAt)
      const bTime = Date.parse(b.createdAt)
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime
      if (Number.isFinite(aTime) !== Number.isFinite(bTime)) return Number.isFinite(bTime) ? 1 : -1
      return b.sessionId.localeCompare(a.sessionId)
    })
}

/** Dispatches one slash line against the session/client the app currently holds. */
export async function runSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const [cmd = '', ...args] = line.trim().split(/\s+/)
  // Refused before the daemon creates, forks or loads a session this app would then not switch to. A bare
  // /resume only opens the picker, which refuses the choice itself.
  const opens = cmd === '/new' || cmd === '/rewind' || (cmd === '/resume' && args.length > 0)
  if (opens && app.refuseSwitch()) return {}
  const s = app.session
  const c = s.client
  const computerUseStatus = async (): Promise<SlashResult> => {
    const report = await c.call<ComputerUseStatusResult>('_agnes/v1/computerUse.status', {})
    return { text: renderComputerUseStatus(report), presentation: 'transcript' }
  }
  const computerUseDoctor = async (): Promise<SlashResult> => {
    const report = await c.call<ComputerUseDoctorResult>('_agnes/v1/computerUse.doctor', {})
    return { text: renderComputerUseDoctor(report), presentation: 'transcript' }
  }
  const resourceCommand = async (
    kind: ResourceCommandKind,
    input: readonly string[],
  ): Promise<SlashResult> => {
    let values = input
    const controller = app.resourceController
    if (!controller) return { text: 'resource control is not supported by this Daemon' }
    if (values[0] === 'cancel')
      return {
        text: app.cancelResourceConfirmation(kind)
          ? 'resource operation cancelled'
          : 'no pending resource operation',
      }
    // The resource parser takes each flag with one value, anywhere, and its action is the first other word:
    // `--expected-revision <rev> trust srv` is a trust, and must wait for confirm like any other.
    let at = 0
    while (values[at]?.startsWith('-')) at += 2
    const action = values[at] ?? ''
    const mutating =
      kind === 'resources'
        ? action === 'enable' || action === 'disable'
        : kind === 'skills'
          ? action === 'refresh' || action === 'trust'
          : ['add', 'update', 'remove', 'test', 'enable', 'disable', 'reconnect', 'trust'].includes(action)
    if (mutating) {
      app.queueResourceConfirmation(kind, values)
      const command = kind === 'skills' ? 'skill' : kind
      return {
        text: `Pending resource operation. Review the revision and trust details, then run /${command} confirm or /${command} cancel.`,
      }
    }
    if (values[0] === 'confirm') {
      const pending = app.takeResourceConfirmation(kind)
      if (!pending) return { text: 'no pending resource operation' }
      values = pending
    }
    const result = await controller.execute(kind, app.profile, values)
    if (result.unsupported) return { text: 'resource control is not supported by this Daemon' }
    return {
      text: result.text,
      ...(result.text.includes('\n') ? { presentation: 'transcript' as const } : {}),
    }
  }
  switch (cmd) {
    case '/help': {
      const usages = SLASH_COMMANDS.map(
        (command) => `${command.name}${command.args ? ` ${command.args}` : ''}`,
      )
      const usageWidth = Math.max(...usages.map((usage) => usage.length))
      return {
        text: [
          'Slash commands',
          ...SLASH_COMMANDS.map(
            (command, index) => `  ${(usages[index] as string).padEnd(usageWidth + 2)}${command.description}`,
          ),
        ].join('\n'),
        presentation: 'transcript',
      }
    }
    case '/quit':
      return { quit: true }
    case '/computer-use': {
      if (args.length !== 1 || args[0] !== 'status')
        return {
          text: 'usage: /computer-use status (read-only while P0 admission is blocked)',
        }
      return computerUseStatus()
    }
    case '/doctor': {
      if (args.length !== 1 || args[0] !== 'computer-use')
        return {
          text: 'usage: /doctor computer-use (read-only while P0 admission is blocked)',
        }
      return computerUseDoctor()
    }
    case '/new': {
      const created = await c.session.new({
        cwd: app.cwd,
        sessionKey: freshTuiSessionKey(app.profile),
      })
      const inherited = await inheritFreshSession(created, app.composerSelectionPath)
      return {
        switchSession: created,
        ...(inherited.notice ? { text: inherited.notice } : {}),
      }
    }
    case '/resume': {
      const id = args[0]
      // A listed durable session may not have a live worker in this daemon process. `attach` only
      // subscribes to an already-open registry entry and therefore answers SESSION_NOT_FOUND for
      // exactly that normal historical-session case. `load` reopens/replays it first, matching the
      // CLI's `agnes resume <id>` and `--resume` paths.
      if (id) return { switchSession: await c.session.load(id, { cwd: app.cwd }) }
      const sessionChoices = await listSessionChoices(s, app.cwd)
      return sessionChoices.length ? { sessionChoices } : { text: 'no other sessions in this workspace' }
    }
    case '/sessions': {
      const choices = (await listSessionChoices(s)).slice(0, 20)
      const rows = choices.flatMap((m, index) => [
        `${index + 1}. ${m.preset} · seq ${m.lastSeq}`,
        `   ${m.sessionId}`,
      ])
      return {
        text: rows.length ? ['Recent sessions', ...rows].join('\n') : 'no sessions',
        presentation: 'transcript',
      }
    }
    case '/cost':
    case '/usage': {
      const result = await s.projectUIOpening({ surface: 'tui', maxNodes: 1 })
      return { text: formatUsageReport(result.timeline.usage), details: true }
    }
    case '/context': {
      const result = await s.projectUIOpening({ surface: 'tui' })
      return { text: formatContextBreakdown(result.timeline.nodes), details: true, title: '上下文分解' }
    }
    case '/rewind': {
      const at = Number(args[0])
      if (!Number.isInteger(at)) return { text: 'usage: /rewind <seq>' }
      // `session.fork` is wired end-to-end (protocol/sdk), but daemon's forkSession handler always
      // answers CAPABILITY_DENIED today -- host's CreateSessionOptions has no parent/forkAt support
      // yet. That denial is real, known debt, not something to route around here: the call below is
      // the honest real path, and it will surface exactly that error against a real daemon.
      return { switchSession: await c.session.fork(s.id, at) }
    }
    case '/compact': {
      const instructions = args.join(' ').trim()
      const outcome = await s.compactDetailed(instructions || undefined)
      if (outcome.state === 'completed') return { text: `compaction completed at seq ${outcome.endSeq}` }
      if (outcome.state === 'failed') return { text: 'compaction failed; session history was preserved' }
      return { text: 'compaction result is unknown; session history was preserved' }
    }
    case '/preset': {
      const name = args[0]
      if (!name) return { text: 'usage: /preset <name>' }
      const r = await s.setPreset(name)
      return { text: `preset ${name} from seq ${r.effectiveFromSeq}` }
    }
    case '/theme': {
      const name = args[0]
      if (args.length === 0) {
        app.showThemePicker()
        return {}
      }
      if (args.length !== 1 || !['light', 'dark', 'mono'].includes(name ?? ''))
        return { text: 'usage: /theme [light|dark|mono]' }
      return { text: app.setTheme(name as TuiThemeName) }
    }
    case '/model': {
      if (args.length === 0) {
        const models = (await c.apis()).profile.models ?? []
        const unique = new Map<string, ModelChoice>()
        for (const item of models) {
          const key = `${item.route}/${item.id}`
          if (!unique.has(key))
            unique.set(key, {
              route: item.route,
              model: item.id,
              reasoning: item.reasoning ?? false,
              ...(item.thinkingLevelMap ? { thinkingLevelMap: item.thinkingLevelMap } : {}),
            })
        }
        const modelChoices = [...unique.values()]
        return modelChoices.length ? { modelChoices } : { text: 'no models available in the current profile' }
      }
      const m = MODEL_ARGS.exec(args.join(' '))
      if (!m) return { text: 'usage: /model [<slot> <route>/<model> [<thinking>]]' }
      const route = m[2] as string
      const model = m[3] as string
      const r = await s.setModel({
        slot: m[1] as SlotName,
        route,
        model,
        ...(m[4] ? { thinking: m[4] as ThinkingLevel } : {}),
      })
      if (m[1] === 'primary')
        writeComposerMemoryFile(app.composerSelectionPath, {
          model: { route, id: model, ...(m[4] ? { thinking: m[4] as ThinkingLevel } : {}) },
        })
      return { text: `model from seq ${r.effectiveFromSeq}` }
    }
    case '/yolo': {
      // No dedicated SDK wrapper (unlike setPreset/setModel): this is the one caller today, and
      // `s.client` is the same public escape hatch a Web caller would reach for later.
      const r = (await s.client.call('_agnes/v1/session.setYolo', {
        sessionId: s.id,
        enabled: true,
      })) as { effectiveFromSeq: number }
      writeComposerMemoryFile(app.composerSelectionPath, { permission: 'full' })
      return {
        text: `yolo on from seq ${r.effectiveFromSeq} — every ask for the rest of this session is skipped`,
      }
    }
    case '/export':
      return { text: `run: agnes export ${s.id}${args.includes('--html') ? ' --html' : ''}` }
    case '/refine':
      // `harness/refine` exists as a raw ledger event type (protocol session-v1 schema), but
      // UITimeline/UINode has no kind that projects it -- there is no 'notice' or 'refine' UINode
      // kind today, so filtering a projected timeline for one would just always return nothing,
      // silently, forever. Reporting the gap directly is the honest behaviour; it is not this
      // command's job to make projectUI() show something it structurally cannot show yet.
      return { text: 'refine proposals are not projected into the TUI timeline yet' }
    case '/packages':
      if (args.length > 0) return { text: 'usage: /packages' }
      return { text: await app.packages.packages(), presentation: 'transcript' }
    case '/install': {
      if (args.length > 1) return { text: 'usage: /install <source>|confirm|cancel' }
      const text = await app.packages.install(args[0])
      return { text, ...(text.includes('\n') ? { presentation: 'transcript' as const } : {}) }
    }
    case '/package':
      return { text: await app.packages.manage(args), presentation: 'transcript' }
    case '/skills':
      if (args.length) return { text: 'usage: /skills' }
      return resourceCommand('resources', ['list', '--kind', 'skill'])
    case '/skill':
      if (args[0] === 'refresh') return resourceCommand('skills', ['refresh', ...args.slice(1)])
      if (args[0] === 'trust') return resourceCommand('skills', ['trust', ...args.slice(1)])
      if (args[0] === 'confirm' || args[0] === 'cancel') return resourceCommand('skills', args)
      return {
        text: 'usage: /skill refresh [--root-key <key>] | /skill trust <resourceId> <revision> [trusted|rejected]',
      }
    case '/mcp':
      return resourceCommand('mcp', args.length ? args : ['list'])
    default:
      return {
        text:
          cmd === '/session'
            ? 'unknown command /session; did you mean /sessions?'
            : `unknown command ${cmd}; use /help to list commands`,
      }
  }
}

/** '/…' completes against the fixed command table; '@…' completes against `cwd`'s entries. */
export function completeToken(prefix: string, cwd: string): string[] {
  if (prefix.startsWith('/'))
    return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(prefix)).map((cmd) => cmd.name)
  if (prefix.startsWith('@')) {
    const needle = prefix.slice(1)
    let entries: string[]
    try {
      entries = readdirSync(cwd)
    } catch {
      // An unreadable or vanished cwd offers nothing, as a prefix that matches nothing does. Tab calls this
      // from the terminal's input callback, where a throw would exit the process in the alternate screen.
      return []
    }
    return entries
      .filter((entry) => entry.startsWith(needle))
      .slice(0, 20)
      .map((entry) => `@${entry}`)
  }
  return []
}

/**
 * Turns every `@path` mention in a line into a `resource_link` block and strips the `@` from the
 * text left behind, so a submitted prompt reads naturally while the path also travels as its own
 * attachment block. The path travels verbatim (whatever followed `@`), not resolved against `cwd`:
 * ContentBlock's `resource_link.uri` is an unconstrained string, and resolving it here would silently
 * change what the user typed into something the completion list never offered.
 */
export function attachmentsFrom(text: string): ContentBlock[] {
  const links: ContentBlock[] = []
  const cleaned = text.replace(/@(\S+)/g, (_match, path: string) => {
    links.push({ type: 'resource_link', uri: `file://${path}`, name: path })
    return path
  })
  return [{ type: 'text', text: cleaned }, ...links]
}
