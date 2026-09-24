import type { ContentBlock, UINode, UITimeline } from '@agnes/protocol'
import { type Branding, DEFAULT_BRANDING, type NodeClient, PreviewMerger, type Session } from '@agnes/sdk'
import { createAnsi, xterm256 } from './ansi.js'
import { attachmentsFrom, completeToken, runSlash, type SessionChoice, slashCommand } from './commands.js'
import { type Component, escapeControl, Text, VStack } from './component.js'
import { Loader } from './components/loader.js'
import { writeComposerMemoryFile } from './composer-memory.js'
import { Editor } from './editor.js'
import { formatTurnSummary } from './format-usage.js'
import { parseKey } from './keys.js'
import { type Locale, t } from './locale.js'
import { renderMarkdown } from './markdown.js'
import { PackageController } from './package-controller.js'
import { PermissionModal } from './permission-modal.js'
import { TuiProjection, type TuiProjectionWindow } from './projection.js'
import { Renderer } from './renderer.js'
import type { ResourceCommandKind, TuiResourceController } from './resource-controller.js'
import { type ActionItem, collectSlots } from './slots.js'
import type { Terminal } from './terminal.js'
import { TuiTheme, type TuiThemeName } from './theme.js'
import { readTheme, saveTheme } from './theme-preference.js'
import { ApprovalCard } from './views/approval-card.js'
import { Composer } from './views/composer.js'
import { Hints } from './views/hints.js'
import { UserMessage } from './views/message.js'
import { ModelPicker, type ModelSelection } from './views/model-picker.js'
import { SessionPicker } from './views/session-picker.js'
import { Header, StatusBar } from './views/status-bar.js'
import { ThemePicker } from './views/theme-picker.js'
import { TIMELINE_RESERVED_ROWS, Timeline } from './views/timeline.js'
import { ToolCard } from './views/tool-card.js'
import { UsagePanel } from './views/usage-panel.js'
import { WelcomeBanner } from './views/welcome-banner.js'

/** Text presentation while the richer cards are assembled around the same projected nodes. */
function nodeText(node: UINode): string {
  switch (node.kind) {
    case 'user':
      return `you: ${node.content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n')}`
    case 'assistant':
      // An attempt whose streamed text died with its process has only that fact to show.
      return node.text === '' && node.lostChars !== undefined
        ? `(output interrupted, at least ${node.lostChars} characters not saved)`
        : node.text
    case 'tool':
      return `${node.name}: ${node.status}\n${node.summary}`
    case 'approval':
      return `approval ${node.state}: ${node.summary}`
    case 'cost':
      // Aggregate usage already lives in the fixed footer and /usage keeps the detailed report.
      // Repeating four accounting rows after every answer drowns the conversation itself.
      return ''
    case 'artifact':
      return `artifact: ${node.name}`
    case 'compaction':
      return `compacted: ${node.summary ?? node.range.join('–')}`
    case 'context':
      // A per-request environment snapshot or a harness note. It is content the model is sent, not
      // a message for the human reading the transcript, so it gets no line here -- same treatment
      // as the 'slot' case below, and the same treatment the channel renderer already gives it.
      // The node stays in the projection; only this rendering of it goes away.
      return ''
    case 'slot':
      // A standalone slot node (status.line / sidebar.action / notification) has no timeline
      // presence of its own: collectSlots() reads it out of the projected timeline directly and
      // routes it to the hint row or status bar instead. Never dump its payload as text here.
      return ''
    case 'context-sections':
    case 'contribute-conflict':
      // Advisory diagnostic rows, not turn transcript: /context reads these directly off
      // projectUIOpening().timeline.nodes (formatContextBreakdown), so they have no chat-line
      // rendering of their own any more than a slot node does.
      return ''
  }
}

// `data.reason` is opaque transport input, not a display contract. Only exact, local business
// rejections get an actionable explanation; every other reason stays out of the terminal.
const ACTIONABLE_ERROR_REASONS: Readonly<Record<string, string>> = {
  'SEMANTIC_REJECTED:fork boundary must be a completed turn/end': 'Choose a completed turn/end sequence.',
}

// TURN_ERROR is daemon's envelope for a turn that ran and ended in `error`; the cause is that turn's
// own stable code (AUTH, RATE_LIMIT, ...). Its message stays out of the terminal like any reason.
const TURN_ERROR_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['AUTH', 'The provider refused this model or its credentials; pick another with /model or sign in again.'],
])

const stableCode = (raw: unknown): string =>
  typeof raw === 'string' || typeof raw === 'number'
    ? String(raw)
        .replace(/[^A-Za-z0-9_.-]/g, '')
        .slice(0, 64)
    : ''

/** Formats stable codes and only locally approved business rejection explanations. */
export function formatTuiErrorNotice(error?: unknown): string {
  try {
    if (error === null || typeof error !== 'object') return 'Request failed. Try again.'
    const value = error as {
      code?: unknown
      data?: { code?: unknown; kind?: unknown; reason?: unknown; error?: { code?: unknown } }
    }
    const data = value.data
    const code = stableCode(data?.code ?? data?.kind ?? value.code)
    if (!code) return 'Request failed. Try again.'
    let reason: unknown
    try {
      if (code === 'TURN_ERROR') {
        const turnCode = stableCode(data?.error?.code)
        if (turnCode) {
          const turnAction = TURN_ERROR_ACTIONS.get(turnCode)
          return turnAction ? `Request failed (${turnCode}): ${turnAction}` : `Request failed (${turnCode}).`
        }
      }
      reason = data?.reason
    } catch {
      return `Request failed (${code}).`
    }
    const action = typeof reason === 'string' ? ACTIONABLE_ERROR_REASONS[`${code}:${reason}`] : undefined
    if (action) return `Request failed (${code}): ${action}`
    return `Request failed (${code}).`
  } catch {
    // Getters and Proxies are untrusted presentation input.
    return 'Request failed. Try again.'
  }
}

export class TuiApp {
  private readonly modal: PermissionModal
  private offPermission: (() => void) | undefined
  // Registered once in `start()` against whichever client the initial session belongs to. A
  // session switch (`applySwitch`) never replaces the underlying `Client` -- the daemon
  // connection outlives any one session -- so these are not re-registered per session.
  private offClientEvents: Array<() => void> = []
  private readonly renderer: Renderer
  // Not readonly: `applySwitch` (a slash command that switches session -- /new, /resume, /rewind)
  // replaces it with a fresh projection built for the newly current session.
  private projection: TuiProjection
  private readonly timeline: Timeline
  private readonly welcomeBanner: WelcomeBanner
  private readonly toolCards = new Map<string, ToolCard>()
  private latestTool: string | undefined
  private readonly approvalCards = new Map<string, ApprovalCard>()
  private latestApproval: string | undefined
  private reservedRows = TIMELINE_RESERVED_ROWS
  // Rows rendered under the permission modal, measured before the modal itself renders each frame.
  private belowModal = 0
  private readonly live = new Text('')
  private readonly loader = new Loader('')
  private turnActive = false
  private turnStartedAt: number | undefined
  private currentTurn = 0
  private ticker: ReturnType<typeof setInterval> | undefined
  private readonly pendingPrompts: ContentBlock[][] = []
  private pendingResourceCommand: { kind: ResourceCommandKind; args: readonly string[] } | undefined
  private flushingQueued = false
  private queuedWake: ReturnType<typeof setTimeout> | undefined
  private readonly header: Header
  private readonly statusBar: StatusBar
  private readonly hints: Hints
  private hintActions: ActionItem[] = []
  private readonly editor: Editor
  private readonly composer: Composer
  private readonly theme: TuiTheme
  private readonly themePicker: ThemePicker
  private readonly usagePanel: UsagePanel
  private readonly modelPicker: ModelPicker
  private readonly sessionPicker: SessionPicker
  private readonly packageController: PackageController
  private readonly localCommandView: (command: string, output: string) => Component
  // Streamed text is never in the projected timeline: a streaming node stays empty there, and the
  // live line shows what the previews of every inference still streaming have said.
  private readonly previews = new PreviewMerger()
  private readonly previewEffects: string[] = []
  private stopped = false
  // Set once the client reports 'closed' (daemon shutting down). The session can never render again,
  // and the SDK would still re-dial on the next call, so input is refused rather than run unseen.
  private closedNotice: string | undefined
  private localTurn = false
  private lastInterrupt: number | undefined
  // A client-local, per-connection counter -- never a ledger seq, never `UINode.seq`, and never
  // the slot fill's own `requestSeq`. It is minted fresh at the moment of a real click, so the
  // server's (requestSeq, action) idempotency check sees a genuinely new pair every time, even
  // when the same action is clicked twice on purpose. It does not survive a reconnect; that is
  // an accepted limitation, not an oversight.
  private nextRequestSeq = 1
  onQuit: () => void = () => {}

  constructor(
    // `header` is a back-compat fallback: real callers (`modes/tui.ts`) pass `profile`/`preset`
    // directly; existing tests that only ever set a plain `header` string still get a header line
    // out of it (via `profile: o.profile ?? o.header`), just with an empty preset segment.
    private readonly o: {
      term: Terminal
      session: Session
      header?: string
      profile?: string
      preset?: string
      /** The model the user explicitly chose on argv; omitted when the session default applies. */
      model?: string
      /** Resolved once by sdk before construction; session switches retain the same client brand. */
      branding?: Branding
      locale?: Locale
      controlClient?: NodeClient
      /** Resource commands use this injected port; the chat/session client has no such authority. */
      resourceController?: TuiResourceController
      /** The CLI has already entered its alternate screen before opening the session. */
      screenAlreadyEntered?: boolean
      /** The workspace the CLI opened its first session in (`--cwd`); defaults to `process.cwd()`. */
      cwd?: string
      /** Last model and permission for the next fresh session. Omitted in tests that do not inherit. */
      composerSelectionPath?: string
      themePreferencePath?: string
      /** Shown once on the status bar after a fresh session inherits a model or full permission. */
      initialNotice?: string
    },
  ) {
    // One ansi instance per colour tier for the whole frame: header, status bar, banner, editor
    // chrome and the cards all degrade through the same tier (none emits zero escape sequences).
    this.theme = new TuiTheme(readTheme(o.themePreferencePath))
    const ansi = this.theme.ansi(createAnsi(o.term.caps.color))
    const branding = o.branding ?? DEFAULT_BRANDING
    const locale = o.locale ?? 'en'
    this.hints = new Hints()
    this.localCommandView = (command, output) =>
      new VStack([
        new Text(`${ansi.bold(ansi.fg(141, '›'))} ${ansi.bold(escapeControl(command.trim()))}`),
        new Text(escapeControl(output)),
      ])
    this.header = new Header(ansi, branding)
    // Placeholder until the first `apply()` tick lands (moments later, inside `start()`, before
    // any render happens): real profile/preset/sessionId are already known now, generation is not.
    this.header.set({
      profile: o.profile ?? o.header ?? '',
      preset: o.preset ?? '',
      sessionId: o.session.id,
      generation: 1,
    })
    this.statusBar = new StatusBar(ansi, locale)
    this.welcomeBanner = new WelcomeBanner({
      profile: o.profile ?? o.header ?? '',
      preset: o.preset ?? '',
      ...(o.model ? { model: o.model } : {}),
      branding,
      ansi,
    })
    this.timeline = new Timeline({
      rows: () => o.term.size().rows,
      reservedRows: () => this.reservedRows,
      // The welcome banner rides at the top of the timeline: it is built once here, so a session
      // switch (`/new`, `/resume`, `/rewind`) reuses it. It scrolls inside the fullscreen
      // viewport, never into the shell's history.
      top: this.welcomeBanner,
      nodeView: (node) => {
        if (node.kind === 'tool') {
          const card = new ToolCard(node, {
            collapsed: this.toolCards.get(node.id)?.collapsed ?? true,
            ansi,
            onAction: (actionId) => this.dispatchAction(actionId),
          })
          this.toolCards.set(node.id, card)
          return card
        }
        if (node.kind === 'approval') {
          const card = new ApprovalCard(node, {
            ansi,
            locale,
            onDecide: async (ticket, verdict) => {
              if (this.refuseClosed()) return
              await this.o.session.client.approval.decide(ticket, verdict, { kind: 'local' })
            },
            // The decide call's settlement (in particular a rejection, which produces no new
            // ledger event for TuiProjection to pick up) has to ask for its own repaint: nothing
            // else in the render loop is watching that promise.
            changed: () => {
              if (!this.stopped) this.renderer.requestRender()
            },
          })
          this.approvalCards.set(node.id, card)
          return card
        }
        if (node.kind === 'assistant')
          return {
            render: (width) => ['', ...renderMarkdown(nodeText(node), width, ansi)],
            transcript: (width) => renderMarkdown(nodeText(node), width, ansi),
            invalidate() {},
          }
        if (node.kind === 'user') {
          const text = nodeText(node)
          return new UserMessage(
            text.startsWith('you: ') ? text.slice('you: '.length) : text,
            ansi,
            this.theme,
            xterm256(branding.accent),
          )
        }
        const text = nodeText(node)
        return text ? new Text(escapeControl(text)) : new VStack()
      },
    })
    this.modal = new PermissionModal(
      () => {
        if (!this.stopped) this.renderer.requestRender()
      },
      {
        locale,
        // The renderer drops a tall frame's top rows, so the modal gets no more than the rows below it
        // leave: an option it counts as visible has to be on screen.
        maxRows: () => {
          const { rows } = o.term.size()
          return Math.max(1, Math.min(rows - Math.max(1, Math.floor(rows / 3)) - 4, rows - this.belowModal))
        },
      },
    )
    this.editor = new Editor({
      maxRows: () => Math.max(1, Math.floor(o.term.size().rows / 3)),
      placeholder: '想做点什么？从一句话开始。',
      dim: (s) => ansi.dim(s),
      promptStyle: (s) => ansi.bold(ansi.fg(141, s)),
      menuStyle: (s) => this.theme.menu(ansi, s),
      onSubmit: (text) => {
        void this.runInput(text)
      },
      onCancelKey: () => {
        void this.cancel().catch((error) => this.showError(error))
      },
      complete: (prefix) => completeToken(prefix, this.cwd),
      menuInfo: (name) => slashCommand(name),
    })
    this.editor.setKitty(o.term.caps.kittyKeyboard)
    this.modelPicker = new ModelPicker({
      ansi,
      maxRows: () => Math.max(4, o.term.size().rows - 6),
      onChoose: (choice) => void this.chooseModel(choice),
      changed: () => {
        if (!this.stopped) this.renderer.requestRender()
      },
    })
    this.themePicker = new ThemePicker(ansi, (name) => {
      this.statusBar.setNotice(this.setTheme(name))
    })
    this.sessionPicker = new SessionPicker({
      ansi,
      maxRows: () => Math.max(4, o.term.size().rows - 6),
      onChoose: (choice) => void this.chooseSession(choice),
      changed: () => {
        if (!this.stopped) this.renderer.requestRender()
      },
    })
    this.usagePanel = new UsagePanel({
      ansi,
      maxRows: () => Math.max(4, o.term.size().rows - 7),
      changed: () => {
        if (!this.stopped) this.renderer.requestRender()
      },
    })
    this.packageController = new PackageController(o.controlClient, () => this.profile)
    this.composer = new Composer(this.editor, ansi)
    // Zero rows until the first turn starts (spec RP1.2). `Loader`'s own constructor is
    // immediately visible by design (see loader.ts's doc comment), so the app -- not the
    // component -- is what decides a fresh session shows nothing yet.
    this.loader.hide()
    const root = new VStack([
      this.header,
      this.timeline,
      this.live,
      this.loader,
      this.modal,
      this.composer,
      // Transient command dialogs belong immediately above the footer, not in the conversation.
      // Closed pickers render zero rows, preserving the normal rule/editor/status adjacency.
      this.modelPicker,
      this.themePicker,
      this.sessionPicker,
      this.usagePanel,
      this.statusBar,
      this.hints,
    ])
    // A pending approval takes every keystroke, so the dialogs give up their rows until it is answered
    // and then reappear unchanged.
    const dialogs: readonly Component[] = [
      this.modelPicker,
      this.themePicker,
      this.sessionPicker,
      this.usagePanel,
    ]
    root.render = (width) => {
      const shown = root.children.filter((child) => !(this.modal.pending && dialogs.includes(child)))
      let rows = 0
      for (const child of shown.toReversed()) {
        if (child === this.modal) this.belowModal = rows
        if (child !== this.timeline) rows += child.render(width).length
      }
      this.reservedRows = Math.max(TIMELINE_RESERVED_ROWS, rows)
      return this.theme.frame(
        createAnsi(o.term.caps.color),
        shown.flatMap((child) => child.render(width)),
        width,
        o.term.size().rows,
      )
    }
    const handle = root.handleInput.bind(root)
    root.handleInput = (data) => {
      if (this.modal.handleInput(data)) return true
      if (this.themePicker.handleInput(data)) return true
      if (this.modelPicker.handleInput(data)) return true
      if (this.sessionPicker.handleInput(data)) return true
      if (this.usagePanel.handleInput(data)) return true
      // Digits reach the persisted approval projection next -- the most recently projected
      // ApprovalCard, which is only interactive while its node is genuinely pending-with-a-ticket
      // (the synchronous path's own dialog is the modal above, already tried).
      // After 'closed' both card kinds are inert: their actions would re-dial the daemon (a parked
      // ticket survives a restart) and run where nothing renders; digits fall to the editor instead.
      const inert = this.closedNotice !== undefined
      if (!inert && this.latestApproval && this.approvalCards.get(this.latestApproval)?.handleInput(data))
        return true
      // Numbered actions inside the most recently projected tool card, tried before the digit
      // reaches anything else. A collapsed card (or one with no matching action) declines, and
      // the keystroke falls through to the editor like any other character.
      if (!inert && this.latestTool && this.toolCards.get(this.latestTool)?.handleInput(data)) return true
      const key = parseKey(data, o.term.caps.kittyKeyboard)
      if (key.name === 'ctrl-o') {
        if (this.latestTool) this.toolCards.get(this.latestTool)?.toggle()
        return true
      }
      if (key.name === 'f1' || key.name === 'f2' || key.name === 'f3' || key.name === 'f4') {
        const action = this.hintActions[Number(key.name.slice(1)) - 1]
        if (action && !action.disabled) this.dispatchAction(action.id)
        return true
      }
      if (key.name === 'pgup' || key.name === 'pgdn') {
        const page = Math.max(1, o.term.size().rows - this.reservedRows)
        const needsEarlier = this.timeline.scroll(key.name === 'pgup' ? -page : page)
        if (needsEarlier)
          void this.projection.loadEarlier().then((loaded) => {
            if (!loaded || this.stopped) return
            this.renderer.requestRender()
          })
        return true
      }
      // Idle Alt+Enter inserts a newline (the editor's own default, reached via `handle(data)`
      // below). Busy, it means something else: send the current draft as a followUp queued behind
      // the turn in flight, rather than a newline nobody is here to keep composing around.
      if (key.name === 'alt-enter' && this.busy) {
        const text = this.editor.text
        if (text.trim()) {
          this.editor.clear()
          void this.o.session.followUp(attachmentsFrom(text)).catch((error) => this.showError(error))
        }
        return true
      }
      if (parseKey(data, o.term.caps.kittyKeyboard).name === 'ctrl-c') {
        const now = Date.now()
        const quit = this.lastInterrupt !== undefined && now - this.lastInterrupt <= 1_000
        this.lastInterrupt = quit ? undefined : now
        void this.cancel()
          .catch((error) => this.showError(error))
          .finally(() => {
            if (quit) this.onQuit()
          })
        return true
      }
      if (parseKey(data, o.term.caps.kittyKeyboard).name === 'ctrl-d' && !this.editor.text && !this.busy) {
        this.onQuit()
        return true
      }
      return handle(data)
    }
    this.renderer = new Renderer(o.term, root, o.screenAlreadyEntered)
    this.projection = this.makeProjection(o.session)
  }

  get busy(): boolean {
    // A projection is presentation data and can arrive behind the ledger (or be a historical cut
    // during attach). It must never turn an idle editor into a local queue. This client owns one
    // prompt at a time, so its actual in-flight RPC is the authoritative interaction gate.
    return this.localTurn
  }

  /** Refuses, with a notice, while this client's own turn or queued prompts still belong to the current
   * session: a switch would send those prompts, and Ctrl-C's cancel, to the next session instead. */
  refuseSwitch(): boolean {
    const refused = this.busy || this.pendingPrompts.length > 0
    if (refused)
      this.statusBar.setNotice('Turn or queued prompt pending: finish or Ctrl-C before switching.', 'warning')
    return refused
  }

  get session(): Session {
    return this.o.session
  }

  get profile(): string {
    return this.o.profile ?? this.o.header ?? 'local-dev'
  }

  /** Every session this app opens or reopens belongs to one workspace, so the daemon never sees two. */
  get cwd(): string {
    return this.o.cwd ?? process.cwd()
  }

  get composerSelectionPath(): string | undefined {
    return this.o.composerSelectionPath
  }

  get packages(): PackageController {
    return this.packageController
  }

  get themeName(): TuiThemeName {
    return this.theme.name
  }

  showThemePicker(): void {
    this.modelPicker.close()
    this.sessionPicker.close()
    this.usagePanel.close()
    this.themePicker.show(this.theme.name)
    if (!this.stopped) this.renderer.requestRender()
  }

  /** Changes local presentation and persists the preference without touching session data. */
  setTheme(name: TuiThemeName): string {
    this.themePicker.close()
    this.theme.set(name)
    this.timeline.refreshViews()
    this.editor.invalidate()
    if (!this.stopped) this.renderer.requestRender()
    return saveTheme(this.o.themePreferencePath, name)
      ? `theme ${name} · 已保存`
      : `theme ${name} · 未能保存偏好，仅本次生效`
  }

  /** Resource control is supplied only by the Node CLI bootstrap, never the chat/session client. */
  get resourceController(): TuiResourceController | undefined {
    return this.o.resourceController
  }

  queueResourceConfirmation(kind: ResourceCommandKind, args: readonly string[]): void {
    this.pendingResourceCommand = { kind, args: [...args] }
  }

  takeResourceConfirmation(kind: ResourceCommandKind): readonly string[] | undefined {
    const pending = this.pendingResourceCommand
    if (!pending || pending.kind !== kind) return undefined
    this.pendingResourceCommand = undefined
    return pending.args
  }

  cancelResourceConfirmation(kind: ResourceCommandKind): boolean {
    if (!this.pendingResourceCommand || this.pendingResourceCommand.kind !== kind) return false
    this.pendingResourceCommand = undefined
    return true
  }

  private makeProjection(session: Session): TuiProjection {
    let opening = true
    return new TuiProjection(session, {
      timeline: (value, window) => {
        this.apply(value, { opening: opening || window.reason === 'opening', window })
        opening = false
      },
      preview: (p) => {
        if (p.stream !== 'text' || !this.previews.add(p)) return
        if (!this.previewEffects.includes(p.effectId)) this.previewEffects.push(p.effectId)
        this.renderLive()
      },
      error: (error) => this.showError(error),
    })
  }

  async start(): Promise<void> {
    this.offPermission = this.o.session.onPermissionRequest((request, context) =>
      this.modal.ask(request, context),
    )
    // Registered against whichever `Client` the initial session belongs to -- see the field
    // comment on `offClientEvents`. The SDK emits all three recovery states: a transport loss
    // begins reconnecting, a successful reattach resumes the projection, and a cursor gap causes
    // a full catch-up. Keeping the status bar aligned with those events makes recovery visible
    // without exposing transport internals to the TUI.
    const client = this.o.session.client
    this.offClientEvents = [
      client.on('notice', (payload) => this.handleNotice(payload)),
      client.on('reconnecting', () => {
        this.statusBar.setLink('reconnecting')
        this.renderer.requestRender()
      }),
      client.on('reconnected', () => {
        this.statusBar.setLink('ok')
        void this.resync()
      }),
      client.on('gap', () => {
        this.statusBar.setLink('catching-up')
        void this.resync()
      }),
      client.on('closed', () => this.handleClosed()),
    ]
    if (this.o.initialNotice) this.statusBar.setNotice(this.o.initialNotice)
    try {
      this.renderer.start()
      await this.projection.start()
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  // Forces a full re-fetch of the projected timeline through the same `apply()` path an
  // incremental tick uses, rather than waiting for `TuiProjection`'s debounced event loop: after a
  // reconnect (or a resumed cursor the server could not honour in full, `'gap'`) the client wants
  // the whole current picture rather than trusting whatever partial state the last incremental
  // tick before the drop left behind.
  private async resync(): Promise<void> {
    try {
      await this.projection.resync()
    } catch (error) {
      this.showError(error)
    }
  }

  // `daemon.notice` payloads are heterogeneous (packages/protocol's `DaemonNotice` is
  // `{kind, sessionId?, detail, at}` with `detail` an open `JsonValue`); only the two kinds the
  // spec calls out get a status-bar rendering today, matching what daemon's reclaim path
  // (packages/daemon/src/lease/reclaim.ts) and worker pool (packages/daemon/src/supervisor/
  // worker-pool.ts) actually emit. Anything else is left alone rather than guessed at.
  private handleNotice(payload: unknown): void {
    const n = payload as { kind?: string; detail?: { lastStep?: number } }
    if (n.kind === 'resumed') {
      const step = n.detail?.lastStep
      this.statusBar.setNotice(t('notice.resumed', this.o.locale ?? 'en', { step: step ?? '?' }), 'success')
    } else if (n.kind === 'worker_crashed') {
      this.statusBar.setNotice(t('notice.crashed', this.o.locale ?? 'en'), 'error')
    } else {
      return
    }
    if (!this.stopped) this.renderer.requestRender()
  }

  // 'closed' is terminal: the projection's event stream has ended, so the closing `opState: null`
  // tick that would stop the spinner never arrives. Queued drafts are dropped for the same reason
  // input is refused: sending them would run a turn nobody can see.
  private handleClosed(): void {
    this.closedNotice = t('notice.closed', this.o.locale ?? 'en', { id: escapeControl(this.o.session.id) })
    this.pendingPrompts.length = 0
    // Timers armed before the close would still call resync()/projectUI and re-dial.
    if (this.queuedWake) clearTimeout(this.queuedWake)
    this.queuedWake = undefined
    void this.projection.stop()
    this.resetTurn()
    this.refuseClosed()
  }

  /** Every path that would call the daemon after 'closed' routes through here instead. */
  private refuseClosed(): boolean {
    if (this.closedNotice === undefined) return false
    this.statusBar.setNotice(this.closedNotice)
    if (!this.stopped) this.renderer.requestRender()
    return true
  }

  private resetTurn(): void {
    this.stopTicker()
    this.turnActive = false
    this.turnStartedAt = undefined
    this.currentTurn = 0
    this.loader.hide()
  }

  private apply(value: UITimeline, options: { opening?: boolean; window?: TuiProjectionWindow } = {}): void {
    const tools = value.nodes.filter((node) => node.kind === 'tool')
    const ids = new Set(tools.map((node) => node.id))
    for (const id of this.toolCards.keys()) if (!ids.has(id)) this.toolCards.delete(id)
    this.latestTool = tools.at(-1)?.id
    const approvals = value.nodes.filter((node) => node.kind === 'approval')
    const approvalIds = new Set(approvals.map((node) => node.id))
    for (const id of this.approvalCards.keys()) if (!approvalIds.has(id)) this.approvalCards.delete(id)
    this.latestApproval = approvals.at(-1)?.id
    this.timeline.apply(value, {
      ...(options.opening ? { opening: true } : {}),
      ...(options.window ? { hasEarlier: options.window.hasEarlier } : {}),
    })
    // Keep the existing tail-relative offset when older rows are prepended. That moves the
    // viewport into the newly loaded page without a second PageUp jump over it.
    if (value.opState === null && this.pendingPrompts.length > 0) void this.flushQueuedPrompts()
    // A node that stopped streaming carries its final text; its preview is finished with.
    this.previews.apply(value)
    this.renderLive()
    // One `collectSlots` call feeds both the hint row (`sidebar.action`) and the status bar
    // (`status.line`) -- there is exactly one projected timeline per tick, so there is exactly
    // one slot collection.
    const slots = collectSlots(value)
    this.hintActions = slots.actions
    this.hints.set(this.hintActions)
    this.statusBar.setSlots(slots.status)
    this.applyOpState(value.opState)
    this.statusBar.setParked(value.opState?.parked?.ticket)
    this.statusBar.setUsage(value.usage)
    if (value.usage) {
      this.welcomeBanner.setModel(value.usage.model.id)
    }
    this.composer.setMeta(
      value.usage
        ? `${escapeControl(value.usage.model.id)}${
            value.usage.model.thinking ? ` · ${escapeControl(value.usage.model.thinking)}` : ''
          }`
        : undefined,
    )
    // `UITimeline.budget` (core's project/ui.ts:282,330) rides along on every projection tick for
    // free -- it is read out of the same register snapshot the rest of this timeline was built
    // from, in the same transaction. That is a stronger consistency guarantee than a separate
    // `session.budget()` round-trip could offer (which could land between two ticks and show a
    // value older or newer than what the rest of this repaint reflects), so this reads `value.
    // budget` directly rather than polling `session.budget()` on `turn/end`.
    if (value.budget) this.statusBar.setBudget(value.budget.creditsUsed, value.budget.creditsCap ?? undefined)
    this.header.set({
      profile: this.o.profile ?? this.o.header ?? '',
      preset: this.o.preset ?? '',
      sessionId: this.o.session.id,
      generation: value.generation,
      ...(value.opState
        ? { opState: { turn: value.opState.turn, step: value.opState.step, phase: value.opState.phase } }
        : {}),
    })
    // Projection callbacks arrive after the renderer's input frame.  Updating the component tree
    // alone leaves that old frame on screen (for example a completed tool still reads "running"),
    // which in turn makes a healthy idle session look as if subsequent input is queued forever.
    this.renderer.requestRender()
  }

  // The one place that turns "a user really clicked an action" into a wire call: it mints a
  // fresh requestSeq right here, never earlier and never off a field that already exists on the
  // projected node. Two clicks of the same action -- even the same action id, even back to back
  // -- always carry two different requestSeq values, because minting happens at the call site,
  // not at slot-fill time.
  private dispatchAction(actionId: string): void {
    if (this.refuseClosed()) return
    const requestSeq = this.nextRequestSeq++
    void this.o.session.client
      .call('_agnes/v1/ext.ui.response', {
        sessionId: this.o.session.id,
        requestSeq,
        action: 'accept',
        data: { id: actionId },
      })
      .catch((error) => this.showError(error))
  }

  /**
   * Turn-lifecycle edge detection: `value.opState` flips null↔non-null exactly at turn
   * boundaries (protocol's `UIOperationState`), and both the spinner (RP1) and the local wall
   * clock (RP3) key off the same two edges, so they are driven from one place rather than two.
   *
   * A null↔non-null flip is not the only boundary that matters, though: `opState.turn` can also
   * change while `opState` stays non-null the whole time, because projection delivery is
   * debounced (projection.ts's `REPROJECT_DEBOUNCE_MS`) and can coalesce turn N's end and turn
   * N+1's start into one tick with no intervening `opState: null` ever reaching `apply()`. Left
   * undetected, that reads as "still turn N" and both fabricates turn N+1's elapsed time (it would
   * include turn N's own duration plus the idle gap between them) and drops turn N's own summary
   * silently. This re-baselines on `opState.turn` changing exactly like a fresh turn start, and
   * accepts that the coalesced turn N never gets its own `✓ turn N · Xs` line -- silently losing
   * that one summary is far less harmful than showing a fabricated number for the next one.
   */
  private applyOpState(opState: UITimeline['opState']): void {
    const active = opState !== null
    if (active && (!this.turnActive || opState.turn !== this.currentTurn)) {
      this.turnStartedAt = Date.now()
      this.currentTurn = opState.turn
      this.loader.restart(opState.phase)
      this.startTicker()
    } else if (!active && this.turnActive) {
      this.stopTicker()
      const elapsedMs = this.turnStartedAt !== undefined ? Date.now() - this.turnStartedAt : undefined
      this.loader.stop(elapsedMs !== undefined ? formatTurnSummary(this.currentTurn, elapsedMs) : undefined)
      this.turnStartedAt = undefined
    } else if (active) {
      this.loader.setLabel(opState.phase)
    }
    this.turnActive = active
  }

  // One shared 80ms ticker, not a timer per component (spec RP1, matching the reference
  // implementations surveyed for this design). RP1.1 measured Timeline.render() at well under
  // 1ms per tick even at 1,000 nodes, so this calls the same requestRender() every other repaint
  // uses rather than a narrower single-row redraw path.
  private startTicker(): void {
    if (this.ticker !== undefined) return
    this.ticker = setInterval(() => {
      this.loader.tick()
      if (!this.stopped) this.renderer.requestRender()
    }, 80)
    this.ticker.unref()
  }

  private stopTicker(): void {
    if (this.ticker === undefined) return
    clearInterval(this.ticker)
    this.ticker = undefined
  }

  private renderLive(): void {
    for (let i = this.previewEffects.length - 1; i >= 0; i--)
      if (this.previews.text(this.previewEffects[i] ?? '') === undefined) this.previewEffects.splice(i, 1)
    const text = this.previewEffects.map((effectId) => this.previews.text(effectId)?.text ?? '').join('')
    this.live.set(escapeControl(text))
    this.renderer.requestRender()
  }

  private showError(error?: unknown): void {
    if (this.stopped) return
    this.statusBar.setNotice(formatTuiErrorNotice(error), 'error')
    this.renderer.requestRender()
  }

  /** The one way to run a line of user input, for the editor and for the prompt `agnes "…"` starts
   * with alike: routes `/…` to `command()`, everything else to `submit()`, and reports either one's
   * failure on the status bar instead of throwing, so a recoverable turn error keeps the session. */
  async runInput(text: string): Promise<void> {
    if (this.closedNotice !== undefined) {
      // Decide and act on the same normalized text: a padded ' /quit' must not reach submit().
      if (text.trim() !== '/quit') return void this.refuseClosed()
      text = '/quit'
    }
    const task = text.startsWith('/') ? this.command(text) : this.submit(text)
    await task.catch((error: unknown) => this.showError(error))
  }

  /** Dispatches one `/…` line typed into the editor. Can reject -- `runSlash` makes real RPC calls
   * underneath /cost, /rewind, /preset, /model, /resume, /sessions and /new -- so callers reach it
   * through `runInput()` above, which owns the `.catch((error) => this.showError(error))`. */
  async command(text: string): Promise<void> {
    if (this.stopped) return
    const r = await runSlash(this, text)
    if (r.details && r.text !== undefined) {
      this.statusBar.setNotice(undefined)
      this.usagePanel.show(r.text, r.title)
    } else if (r.text !== undefined) {
      // Explicit transcript output, and every multiline fallback, stays connection-local: Timeline
      // anchors it beside projected nodes but never manufactures a UINode or writes the ledger.
      if (r.presentation === 'transcript' || r.text.includes('\n')) {
        this.statusBar.setNotice(undefined)
        this.timeline.appendLocal(this.session.id, this.localCommandView(text, r.text))
      } else {
        this.statusBar.setNotice(r.text)
      }
    }
    if (r.modelChoices) {
      this.statusBar.setNotice(undefined)
      this.modelPicker.show(r.modelChoices)
    }
    if (r.sessionChoices) {
      this.statusBar.setNotice(undefined)
      this.sessionPicker.show(r.sessionChoices)
    }
    if (r.switchSession) await this.applySwitch(r.switchSession)
    if (r.quit) this.onQuit()
    if (!this.stopped) this.renderer.requestRender()
  }

  // Stops the old projection's local subscription, swaps the session this app renders, and starts
  // a fresh projection against the new one. The old session is left attached at the protocol level
  // (its own `Client.close()` cleans that up eventually) -- an explicit detach here is a step this
  // task's own interface spec never asks for, and one this method has no test coverage compelling.
  private async applySwitch(next: Session): Promise<boolean> {
    // runSlash and chooseSession refuse up front; a prompt submitted while the daemon was still opening
    // `next` is caught here.
    if (this.refuseClosed() || this.refuseSwitch()) return false
    this.themePicker.close()
    this.modelPicker.close()
    this.sessionPicker.close()
    this.usagePanel.close()
    this.offPermission?.()
    await this.projection.stop()
    // stop() may have run before this switch's session arrived or during the await above. It stops only the
    // projection it finds, so one started from here on would never be stopped: its opening retry timer keeps
    // the process alive after the TUI has quit. A terminal close during the await is the same case:
    // starting the next projection would re-dial the daemon.
    if (this.stopped || this.refuseClosed()) return false
    // `projection.stop()` only unsubscribes from the old session's ledger events; it never
    // synthesizes a closing `opState: null` tick for a turn that was still in flight. Left alone,
    // a mid-turn switch leaves the ticker genuinely running past this point (confirmed reachable:
    // nothing else stops it once the old projection is torn down) and the loader still labelled
    // with the old session's turn/phase, so the new session's first idle tick would otherwise
    // paint a stale, fabricated elapsed time for a turn that belongs to a session no longer even
    // attached. Reset turn-lifecycle state to exactly what a freshly-constructed TuiApp looks like.
    this.resetTurn()
    this.welcomeBanner.setModel(undefined)
    this.o.session = next
    this.previews.reset()
    this.previewEffects.length = 0
    this.projection = this.makeProjection(next)
    this.offPermission = next.onPermissionRequest((request, context) => this.modal.ask(request, context))
    await this.projection.start()
    return true
  }

  private async chooseModel(choice: ModelSelection): Promise<void> {
    if (this.refuseClosed()) return
    try {
      const result = await this.o.session.setModel({
        slot: 'primary',
        route: choice.route,
        model: choice.model,
        ...(choice.thinking === undefined ? {} : { thinking: choice.thinking }),
      })
      writeComposerMemoryFile(this.composerSelectionPath, {
        model: {
          route: choice.route,
          id: choice.model,
          ...(choice.thinking ? { thinking: choice.thinking } : {}),
        },
      })
      this.statusBar.setNotice(
        `model ${escapeControl(choice.route)}/${escapeControl(choice.model)} from seq ${result.effectiveFromSeq}`,
        'success',
      )
      if (!this.stopped) this.renderer.requestRender()
    } catch (error) {
      this.showError(error)
    }
  }

  private async chooseSession(choice: SessionChoice): Promise<void> {
    if (this.refuseClosed()) return
    try {
      // The picker stays open during a turn; picking from it is refused before the daemon loads anything.
      if (this.refuseSwitch()) return this.renderer.requestRender()
      this.statusBar.setNotice(`Loading session ${escapeControl(choice.sessionId)}…`)
      this.renderer.requestRender()
      const next = await this.o.session.client.session.load(choice.sessionId, { cwd: this.cwd })
      if (await this.applySwitch(next))
        this.statusBar.setNotice(`Resumed ${escapeControl(choice.sessionId)}`, 'success')
      if (!this.stopped) this.renderer.requestRender()
    } catch (error) {
      this.showError(error)
    }
  }

  async submit(text: string): Promise<void> {
    if (this.stopped) throw new Error('TUI stopped')
    if (!text.trim()) return
    if (text.startsWith('/')) throw new Error('Command unavailable')
    this.statusBar.setNotice(undefined)
    const blocks = attachmentsFrom(text)
    if (this.busy) {
      // The daemon's followUp endpoint durably enqueues input, but this TUI has no background
      // turn runner to wake that queue after the current turn ends. Keep the draft locally and
      // dispatch it as an ordinary prompt on the first idle projection instead.
      this.pendingPrompts.push(blocks)
      this.statusBar.setNotice(`Queued: ${escapeControl(text)}`)
      this.renderer.requestRender()
      this.wakeQueuedPrompt()
      return
    }
    this.localTurn = true
    try {
      await this.o.session.prompt(blocks)
    } finally {
      this.localTurn = false
      // The idle projection can arrive before the prompt RPC itself settles. In that ordering the
      // projection-side flush sees localTurn=true and correctly backs off, but there may be no
      // later projection to wake it. The RPC settlement is the other authoritative idle edge.
      if (this.pendingPrompts.length > 0) void this.flushQueuedPrompts()
    }
  }

  private async flushQueuedPrompts(): Promise<void> {
    if (this.flushingQueued || this.stopped || this.busy || this.pendingPrompts.length === 0) return
    this.flushingQueued = true
    try {
      while (!this.stopped && !this.busy && this.pendingPrompts.length > 0) {
        const next = this.pendingPrompts.shift()
        if (!next) break
        this.statusBar.setNotice(undefined)
        this.localTurn = true
        try {
          await this.o.session.prompt(next)
        } catch (error) {
          // Only a prompt the daemon refused before recording it may be sent again. Any other failure
          // can arrive after the input was written and the turn ran (TURN_ERROR is exactly that), and
          // sending it again repeats the message, the model call and whatever the turn's tools did.
          // The notice showError writes replaces any notice set here, so none is set.
          const code = (error as { data?: { code?: unknown } } | null)?.data?.code
          if (code === 'SESSION_BUSY' || code === 'OVERLOADED') this.pendingPrompts.unshift(next)
          this.showError(error)
          return
        } finally {
          this.localTurn = false
        }
      }
    } finally {
      this.flushingQueued = false
      // Whatever is still queued when this returns needs a live wake path. The refusal branch above
      // puts its prompt back and returns, and the idle projection edge that would otherwise retry
      // only ticks on a new ledger event -- which a refused prompt never produced. Re-arming here is
      // idempotent: wakeQueuedPrompt() no-ops on an empty queue, a stopped app or a live timer.
      this.wakeQueuedPrompt()
    }
  }

  /** Poll once per short interval while queued input exists, covering a missed idle projection. */
  private wakeQueuedPrompt(): void {
    if (this.queuedWake || this.stopped || this.pendingPrompts.length === 0) return
    this.queuedWake = setTimeout(() => {
      this.queuedWake = undefined
      void this.resync().finally(() => {
        if (this.pendingPrompts.length > 0) this.wakeQueuedPrompt()
      })
    }, 100)
  }

  async cancel(): Promise<void> {
    if (this.busy) await this.o.session.cancel()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.queuedWake) clearTimeout(this.queuedWake)
    this.queuedWake = undefined
    this.stopTicker()
    this.offPermission?.()
    for (const off of this.offClientEvents) off()
    this.offClientEvents = []
    this.modal.close()
    this.themePicker.close()
    this.modelPicker.close()
    this.sessionPicker.close()
    this.usagePanel.close()
    // Restore the terminal before asynchronous teardown can fail or hang. Nothing from the chat is
    // written back to the shell page: it comes back exactly as it was before the TUI started.
    try {
      this.renderer.stop()
    } finally {
      await this.projection.stop()
    }
  }
}
