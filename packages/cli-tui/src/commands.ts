import { resolve } from 'node:path'
import type {
  ComputerUseDoctorResult,
  ComputerUseStatusResult,
  ContentBlock,
  SlotName,
  ThinkingLevel,
} from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import { agentsSlash } from './agent-commands.js'
import type { TuiApp } from './app.js'
import { uploadLocalAttachment } from './attachment-upload.js'
import { inheritFreshSession, writeComposerMemoryFile } from './composer-memory.js'
import { customCommandsFor, customHelp, customSlash } from './custom-commands.js'
import { deliverablesSlash } from './deliverable-files.js'
import { grantsSlash } from './grant-commands.js'
import { infoSlash } from './info-commands.js'
import { jobsSlash } from './job-commands.js'
import { formatKeys } from './keybindings.js'
import { type ExtendedKey, tt } from './locale-extended.js'
import { queueSlash } from './queue-commands.js'
import type { ResourceCommandKind } from './resource-controller.js'
import { rewindChoices, sessionSlash } from './session-commands.js'
import { freshTuiSessionKey } from './session-key.js'
import type { ThemePreference } from './theme-preference.js'
import { thinkingMode } from './thinking.js'
import { undoSlash } from './undo-commands.js'
import { formatContextBreakdown, formatUsageReport } from './usage-details.js'

export type SlashCommand = {
  name: string
  /** Argument shape shown dimmed next to the name in the slash menu, e.g. `<seq>`. */
  args?: string
  /** Locale key of the one-line description; translated when the menu renders. */
  descriptionKey: ExtendedKey
  /** Locale key of the short summary shown beside the name in the slash menu. */
  summaryKey: ExtendedKey
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/help', descriptionKey: 'commands.help', summaryKey: 'commands.helpSummary' },
  { name: '/quit', descriptionKey: 'commands.quit', summaryKey: 'commands.quitSummary' },
  { name: '/new', args: '[dir]', descriptionKey: 'commands.new', summaryKey: 'commands.newSummary' },
  {
    name: '/resume',
    args: '[id|all]',
    descriptionKey: 'commands.resume',
    summaryKey: 'commands.resumeSummary',
  },
  { name: '/sessions', descriptionKey: 'commands.sessions', summaryKey: 'commands.sessionsSummary' },
  { name: '/pin', descriptionKey: 'commands.pin', summaryKey: 'commands.pinSummary' },
  { name: '/unpin', descriptionKey: 'commands.unpin', summaryKey: 'commands.unpinSummary' },
  {
    name: '/rename',
    args: '<title>',
    descriptionKey: 'commands.rename',
    summaryKey: 'commands.renameSummary',
  },
  { name: '/archive', descriptionKey: 'commands.archive', summaryKey: 'commands.archiveSummary' },
  {
    name: '/search',
    args: '<query>',
    descriptionKey: 'commands.search',
    summaryKey: 'commands.searchSummary',
  },
  { name: '/cost', descriptionKey: 'commands.cost', summaryKey: 'commands.costSummary' },
  { name: '/usage', descriptionKey: 'commands.usage', summaryKey: 'commands.usageSummary' },
  {
    name: '/computer-use',
    args: 'status',
    descriptionKey: 'commands.computerUse',
    summaryKey: 'commands.computerUseSummary',
  },
  {
    name: '/doctor',
    args: 'computer-use',
    descriptionKey: 'commands.doctor',
    summaryKey: 'commands.doctorSummary',
  },
  { name: '/rewind', args: '[seq]', descriptionKey: 'commands.rewind', summaryKey: 'commands.rewindSummary' },
  {
    name: '/undo',
    args: '[turn|confirm|cancel]',
    descriptionKey: 'commands.undo',
    summaryKey: 'commands.undoSummary',
  },
  {
    name: '/compact',
    args: '[instructions]',
    descriptionKey: 'commands.compact',
    summaryKey: 'commands.compactSummary',
  },
  {
    name: '/goal',
    args: '[create|edit|pause|resume|complete|clear] ...',
    descriptionKey: 'commands.goal',
    summaryKey: 'commands.goalSummary',
  },
  {
    name: '/plan',
    args: '[on|off|status|pending|instruction]',
    descriptionKey: 'commands.plan',
    summaryKey: 'commands.planSummary',
  },
  {
    name: '/preset',
    args: '<name>',
    descriptionKey: 'commands.preset',
    summaryKey: 'commands.presetSummary',
  },
  {
    name: '/theme',
    args: '[auto|light|dark|mono]',
    descriptionKey: 'commands.theme',
    summaryKey: 'commands.themeSummary',
  },
  { name: '/keys', descriptionKey: 'commands.keys', summaryKey: 'commands.keysSummary' },
  { name: '/mouse', descriptionKey: 'commands.mouse', summaryKey: 'commands.mouseSummary' },
  { name: '/thinking', descriptionKey: 'commands.thinking', summaryKey: 'commands.thinkingSummary' },
  {
    name: '/model',
    args: '[<slot> <route>/<model> [<thinking>]]',
    descriptionKey: 'commands.model',
    summaryKey: 'commands.modelSummary',
  },
  { name: '/yolo', args: '[on|off]', descriptionKey: 'commands.yolo', summaryKey: 'commands.yoloSummary' },
  {
    name: '/grants',
    args: '[revoke <n|id>]',
    descriptionKey: 'commands.grants',
    summaryKey: 'commands.grantsSummary',
  },
  {
    name: '/deliverables',
    args: '[save <n|id> [path]]',
    descriptionKey: 'commands.deliverables',
    summaryKey: 'commands.deliverablesSummary',
  },
  {
    name: '/attach',
    args: '<path>',
    descriptionKey: 'commands.attach',
    summaryKey: 'commands.attachSummary',
  },
  { name: '/export', descriptionKey: 'commands.export', summaryKey: 'commands.exportSummary' },
  { name: '/refine', descriptionKey: 'commands.refine', summaryKey: 'commands.refineSummary' },
  { name: '/packages', descriptionKey: 'commands.packages', summaryKey: 'commands.packagesSummary' },
  {
    name: '/install',
    args: '<source>|confirm|cancel',
    descriptionKey: 'commands.install',
    summaryKey: 'commands.installSummary',
  },
  {
    name: '/package',
    args: '[status|catalog|inspect|trust|enable|disable|update|rollback|remove|operation|cancel] ...',
    descriptionKey: 'commands.package',
    summaryKey: 'commands.packageSummary',
  },
  { name: '/skills', descriptionKey: 'commands.skills', summaryKey: 'commands.skillsSummary' },
  {
    name: '/skill',
    args: 'invoke <name> [arguments]|refresh|trust ...',
    descriptionKey: 'commands.skill',
    summaryKey: 'commands.skillSummary',
  },
  { name: '/mcp', args: '<action> ...', descriptionKey: 'commands.mcp', summaryKey: 'commands.mcpSummary' },
  { name: '/context', descriptionKey: 'commands.context', summaryKey: 'commands.contextSummary' },
  {
    name: '/agents',
    args: '[stop <n|id>|resume <n|id> <message>]',
    descriptionKey: 'commands.agents',
    summaryKey: 'commands.agentsSummary',
  },
  {
    name: '/jobs',
    args: '[stop <n|id>]',
    descriptionKey: 'commands.jobs',
    summaryKey: 'commands.jobsSummary',
  },
  {
    name: '/queue',
    args: '[edit|drop|now|steer <n>]',
    descriptionKey: 'commands.queue',
    summaryKey: 'commands.queueSummary',
  },
  { name: '/status', descriptionKey: 'commands.status', summaryKey: 'commands.statusSummary' },
  { name: '/copy', args: '[n|code]', descriptionKey: 'commands.copy', summaryKey: 'commands.copySummary' },
  {
    name: '/diff',
    args: '[turn] [path]',
    descriptionKey: 'commands.diff',
    summaryKey: 'commands.diffSummary',
  },
  { name: '/init', descriptionKey: 'commands.init', summaryKey: 'commands.initSummary' },
]

export function slashCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((c) => c.name === name)
}

const isBuiltin = (name: string): boolean => slashCommand(name) !== undefined

/** 描述在渲染期翻译：编辑器菜单每次重绘都会经此取词。 */
export function slashCommandFor(
  name: string,
  locale: string,
  app?: TuiApp,
): { name: string; args?: string; description: string; summary: string } | undefined {
  const command = slashCommand(name)
  if (!command) {
    // A custom command shows its file's description; a project one also says where it came from.
    const custom = app && customCommandsFor(app, isBuiltin).commands.get(name.slice(1))
    if (!custom) return undefined
    const from =
      custom.scope === 'project' ? `[${tt('custom.project', locale, { path: custom.shown })}] ` : ''
    return {
      name,
      ...(custom.hint ? { args: custom.hint } : {}),
      description: `${from}${custom.description}`,
      summary: `${from}${custom.description}`,
    }
  }
  return {
    ...command,
    description: tt(command.descriptionKey, locale),
    summary: tt(command.summaryKey, locale),
  }
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
  preset: string | null
  title?: string
  /** Set by the /rewind picker: choosing forks this session at that completed-turn boundary. */
  forkAt?: number
}

export type SlashResult = {
  text?: string
  prompt?: string
  content?: ContentBlock[]
  details?: boolean
  /** Text to put in the editor, replacing what it holds (the line that ran the command is already gone). */
  draft?: string
  /** Attachment blocks of a message taken back into the editor: they are sent with the next message. */
  keep?: ContentBlock[]
  /** Long-lived local output belongs in the transcript; omitted text is a short status notice. */
  presentation?: 'transcript'
  title?: string
  switchSession?: Session
  modelChoices?: ModelChoice[]
  sessionChoices?: SessionChoice[]
  sessionPickerTitle?: ExtendedKey
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
export async function listSessionChoices(session: Session, resumableFrom?: string): Promise<SessionChoice[]> {
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
  const locale = app.locale
  // Refused before the daemon creates, forks or loads a session this app would then not switch to. A bare
  // /resume only opens the picker, which refuses the choice itself.
  const opens =
    cmd === '/new' ||
    (cmd === '/rewind' && args.length > 0) ||
    (cmd === '/resume' && args.length > 0 && args[0] !== 'all')
  if (opens && app.refuseSwitch()) return {}
  const s = app.session
  const c = s.client
  if (cmd === '/attach') {
    const path = line.trim().slice('/attach'.length).trim()
    if (!path) throw new Error('Usage: /attach <path>')
    return { content: [await uploadLocalAttachment(s, app.cwd, path, app.attachmentSignal)] }
  }
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
          tt('commands.helpHeading', locale),
          ...SLASH_COMMANDS.map(
            (command, index) =>
              `  ${(usages[index] as string).padEnd(usageWidth + 2)}${tt(command.descriptionKey, locale)}`,
          ),
          ...customHelp(app, isBuiltin),
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
      // A directory the daemon has not authorised is refused by the daemon, and shown as it comes.
      const dir = line.trim().slice('/new'.length).trim()
      const created = await c.session.new({
        cwd: dir ? resolve(app.cwd, dir) : app.cwd,
        sessionKey: freshTuiSessionKey(app.profile),
      })
      const inherited = await inheritFreshSession(created, app.composerSelectionPath, undefined, locale)
      return {
        switchSession: created,
        ...(inherited.notice ? { text: inherited.notice } : {}),
      }
    }
    case '/resume': {
      const id = args[0] === 'all' ? undefined : args[0]
      // A listed durable session may not have a live worker in this daemon process. `attach` only
      // subscribes to an already-open registry entry and therefore answers SESSION_NOT_FOUND for
      // exactly that normal historical-session case. `load` reopens/replays it first, matching the
      // CLI's `agnes resume <id>` and `--resume` paths.
      if (id) return { switchSession: await c.session.load(id, { cwd: app.cwd }) }
      const everywhere = args[0] === 'all'
      const sessionChoices = await listSessionChoices(s, everywhere ? undefined : app.cwd)
      if (sessionChoices.length) return { sessionChoices }
      return { text: everywhere ? 'no sessions' : 'no other sessions in this workspace' }
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
      return { text: formatUsageReport(result.timeline.usage, locale), details: true }
    }
    case '/context': {
      const result = await s.projectUIOpening({ surface: 'tui' })
      return {
        text: formatContextBreakdown(result.timeline.nodes, locale),
        details: true,
        title: tt('usage.context.breakdownTitle', locale),
      }
    }
    case '/rewind': {
      if (args.length === 0) {
        const sessionChoices = await rewindChoices(app)
        return sessionChoices.length
          ? { sessionChoices, sessionPickerTitle: 'picker.rewindTitle' }
          : { text: tt('session.noTurns', locale) }
      }
      const at = Number(args[0])
      if (!Number.isInteger(at)) return { text: 'usage: /rewind [seq]' }
      // The daemon forks a session only for its owner and only at a completed turn boundary; any
      // other request is refused there, and that refusal is shown as it comes.
      return { switchSession: await c.session.fork(s.id, at) }
    }
    case '/undo':
      return undoSlash(app, args)
    case '/grants':
      return grantsSlash(app, line)
    case '/deliverables':
      return deliverablesSlash(app, line)
    case '/agents':
      return agentsSlash(app, line)
    case '/jobs':
      return jobsSlash(app, line)
    case '/queue':
      return queueSlash(app, line)
    case '/status':
    case '/copy':
    case '/diff':
    case '/init':
      return infoSlash(app, cmd, line)
    case '/pin':
    case '/unpin':
    case '/rename':
    case '/archive':
    case '/search':
      return sessionSlash(app, cmd, line)
    case '/goal': {
      if (line.trim() === '/goal' || line.trim() === '/goal show') {
        const { timeline } = await s.projectUIOpening({ surface: 'tui' })
        const live = timeline.slots?.find(
          (fill) => fill.extId === 'agnes/goal' && fill.slot === 'status.line',
        )
        if (live) return { text: String((live.payload as { text: string }).text) }
        const slot = [...timeline.nodes]
          .reverse()
          .find(
            (node) =>
              node.kind === 'slot' && node.fill.extId === 'agnes/goal' && node.fill.slot === 'status.line',
          )
        return {
          text: slot?.kind === 'slot' ? String((slot.fill.payload as { text: string }).text) : 'No goal',
        }
      }
      if (app.busy) await s.steer(line.trim())
      else await s.prompt(line.trim())
      return {}
    }
    case '/plan':
      return c.call<{ active: boolean; text: string }>('_agnes/v1/admin.plan', {
        cwd: app.cwd,
        sessionId: s.id,
        line: line.trim(),
      })
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
      if (args.length !== 1 || !['auto', 'light', 'dark', 'mono'].includes(name ?? ''))
        return { text: 'usage: /theme [auto|light|dark|mono]' }
      return { text: app.setTheme(name as ThemePreference) }
    }
    case '/thinking':
      return { text: tt(thinkingMode.toggle() ? 'thinking.open' : 'thinking.folded', app.locale) }
    case '/keys':
      return { text: formatKeys(locale), details: true, title: tt('keys.title', locale) }
    case '/mouse':
      return { text: tt(app.renderer.toggleMouse() ? 'mouse.on' : 'mouse.off', app.locale) }
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
      if (args.length > 1 || (args[0] !== undefined && args[0] !== 'on' && args[0] !== 'off'))
        return { text: 'usage: /yolo [on|off]' }
      if (args[0] === 'off') {
        const off = await s.setYolo(false)
        return { text: tt('session.yoloOff', locale, { seq: off.effectiveFromSeq }) }
      }
      const r = await s.setYolo(true)
      return {
        text: `routine approvals skipped from seq ${r.effectiveFromSeq}; the current preset and its domain confirmations remain in effect. Explicit denies, OS permissions and command sandbox limits still apply. /yolo off asks again.`,
      }
    }
    case '/export':
      return { text: `run: agh export ${s.id}${args.includes('--html') ? ' --html' : ''}` }
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
      if (args[0] === 'invoke' && args[1]) {
        return { prompt: line }
      }
      if (args[0] === 'refresh') return resourceCommand('skills', ['refresh', ...args.slice(1)])
      if (args[0] === 'trust') return resourceCommand('skills', ['trust', ...args.slice(1)])
      if (args[0] === 'confirm' || args[0] === 'cancel') return resourceCommand('skills', args)
      return {
        text: 'usage: /skill invoke <name> [arguments] | /skill refresh [--root-key <key>] | /skill trust <resourceId> <revision> [trusted|rejected]',
      }
    case '/mcp':
      return resourceCommand('mcp', args.length ? args : ['list'])
    default:
      return (
        customSlash(app, cmd, line, isBuiltin) ?? {
          text:
            cmd === '/session'
              ? 'unknown command /session; did you mean /sessions?'
              : `unknown command ${cmd}; use /help to list commands`,
        }
      )
  }
}

/** '/…' completes against the command table and the custom commands; '@' mentions have their own menu (file-mentions.ts). */
export function completeToken(prefix: string, app?: TuiApp): string[] {
  if (!prefix.startsWith('/')) return []
  const builtin = SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(prefix)).map((cmd) => cmd.name)
  if (!app) return builtin
  const custom = [...customCommandsFor(app, isBuiltin).commands.keys()].map((name) => `/${name}`)
  return [...builtin, ...custom.filter((name) => name.startsWith(prefix))]
}
