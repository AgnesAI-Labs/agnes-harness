import { randomUUID } from 'node:crypto'
import type { ContentBlock, UITimeline, UiActionParams, UiSurfaceRecord } from '@agnes/protocol'
import { numberedSurfaceInput, surfaceText } from '@agnes/protocol/intelligent-ui'
import { type Branding, DEFAULT_BRANDING, type NodeClient, PreviewMerger, type Session } from '@agnes/sdk'
import { createAnsi } from './ansi.js'
import { BusyInput, cancelTurn, textOf } from './busy-input.js'
import { completeToken, runSlash, type SessionChoice, slashCommandFor } from './commands.js'
import { type Component, escapeControl, Text, VStack } from './component.js'
import { Loader } from './components/loader.js'
import { writeComposerMemoryFile } from './composer-memory.js'
import { Editor } from './editor.js'
import { formatTuiErrorNotice } from './error-notice.js'
import { type ExternalEditorConfig, editDraft } from './external-editor.js'
import { attachmentsFrom, createMentionSource, type ReferenceMentionSource } from './file-mentions.js'
import { formatTurnSummary } from './format-usage.js'
import { DoubleCtrlC } from './interrupt.js'
import { parseKey } from './keys.js'
import { type Locale, t } from './locale.js'
import { tt } from './locale-extended.js'
import { copyTip, systemCopy, TuiMouse } from './mouse.js'
import { nodeText } from './node-text.js'
import { PackageController } from './package-controller.js'
import { PermissionModal } from './permission-modal.js'
import { TuiProjection, type TuiProjectionWindow } from './projection.js'
import { PromptHistory } from './prompt-history.js'
import { Renderer } from './renderer.js'
import type { ResourceCommandKind, TuiResourceController } from './resource-controller.js'
import { type ActionItem, collectSlots } from './slots.js'
import { pendingSurface } from './surface-prompt.js'
import type { Terminal } from './terminal.js'
import { TerminalSignals } from './terminal-signals.js'
import { brandColour, TuiTheme, type TuiThemeName } from './theme.js'
import { readTheme, saveTheme } from './theme-preference.js'
import { assistantView, LiveView } from './thinking.js'
import { ToolCards } from './tool-cards.js'
import { ApprovalCard } from './views/approval-card.js'
import { Composer } from './views/composer.js'
import { Hints } from './views/hints.js'
import { localCommandView } from './views/local-command.js'
import { UserMessage } from './views/message.js'
import { ModelPicker, type ModelSelection } from './views/model-picker.js'
import { SessionPicker } from './views/session-picker.js'
import { StatusBar } from './views/status-bar.js'
import { ThemePicker } from './views/theme-picker.js'
import { TIMELINE_RESERVED_ROWS, Timeline } from './views/timeline.js'
import { UsagePanel } from './views/usage-panel.js'
import { WelcomeController, type WelcomeOptions } from './welcome-controller.js'
import { readWorkspaceInfo, tildePath, type WorkspaceProbe, workspaceRefresher } from './workspace-info.js'

export { formatTuiErrorNotice } from './error-notice.js'

export class TuiApp {
  private attachmentController = new AbortController()
  get attachmentSignal(): AbortSignal {
    return this.attachmentController.signal
  }
  private surfacePrompt: UiSurfaceRecord | undefined
  private surfaceCommand: Omit<UiActionParams, 'sessionId'> | undefined
  private readingSurfaces: Session | undefined
  private surfaceReadAgain = false
  private surfaceWatermark = 0
  private readonly surfaceVersions = new Map<string, number>()
  private readonly modal: PermissionModal
  private offPermission: (() => void) | undefined
  // Registered once in `start()` against whichever client the initial session belongs to. A
  // session switch (`applySwitch`) never replaces the underlying `Client` -- the daemon
  // connection outlives any one session -- so these are not re-registered per session.
  private offClientEvents: Array<() => void> = []
  /** Public so `/mouse` can switch the terminal's mouse reporting. */
  readonly renderer: Renderer
  // Not readonly: `applySwitch` (a slash command that switches session -- /new, /resume, /rewind)
  // replaces it with a fresh projection built for the newly current session.
  private projection: TuiProjection
  private readonly timeline: Timeline
  private readonly welcome: WelcomeController
  private readonly cards: ToolCards
  private readonly approvalCards = new Map<string, ApprovalCard>()
  private latestApproval: string | undefined
  private reservedRows = TIMELINE_RESERVED_ROWS
  // Rows rendered under the permission modal, measured before the modal itself renders each frame.
  private belowModal = 0
  private readonly live: LiveView
  private readonly loader: Loader
  private turnActive = false
  private turnStartedAt: number | undefined
  private currentTurn = 0
  private ticker: ReturnType<typeof setInterval> | undefined
  private pendingResourceCommand: { kind: ResourceCommandKind; args: readonly string[] } | undefined
  private readonly mouse: TuiMouse
  private readonly statusBar: StatusBar
  private readonly hints: Hints
  private hintActions: ActionItem[] = []
  private readonly editor: Editor
  private readonly mentions: ReferenceMentionSource
  private readonly composer: Composer
  private readonly theme: TuiTheme
  private readonly themePicker: ThemePicker
  private readonly usagePanel: UsagePanel
  private readonly modelPicker: ModelPicker
  private readonly sessionPicker: SessionPicker
  private readonly packageController: PackageController
  private readonly localCommandView: (command: string, output: string, quiet?: boolean) => Component
  // Streamed text is never in the projected timeline: a streaming node stays empty there, and the
  // live line shows what the previews of every inference still streaming have said.
  private readonly previews = new PreviewMerger()
  private readonly previewEffects: string[] = []
  private stopped = false
  /** Sessions this run sent a message to: the exit hint is for those only. */
  readonly prompted = new Set<string>()
  private readonly signals: TerminalSignals
  // Set once the client reports 'closed' (daemon shutting down). The session can never render again,
  // and the SDK would still re-dial on the next call, so input is refused rather than run unseen.
  private closedNotice: string | undefined
  private localTurn = false
  private readonly interrupts = new DoubleCtrlC()
  private readonly busyInput = new BusyInput({
    session: () => this.o.session,
    locale: () => this.locale,
    notice: (text, tone) => {
      this.statusBar.setNotice(text, tone)
      this.renderer.requestRender()
    },
    restore: (draft) => this.editor.setText(draft),
  })
  // A client-local, per-connection counter -- never a ledger seq, never `UINode.seq`, and never
  // the slot fill's own `requestSeq`. It is minted fresh at the moment of a real click, so the
  // server's (requestSeq, action) idempotency check sees a genuinely new pair every time, even
  // when the same action is clicked twice on purpose. It does not survive a reconnect; that is
  // an accepted limitation, not an oversight.
  private nextRequestSeq = 1
  onQuit: () => void = () => {}
  private readonly refreshWorkspace: () => void

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
      /** Where mouse-selected text goes; defaults to the system clipboard. */
      copy?: (text: string, fail: () => void) => unknown
      /** The workspace the CLI opened its first session in (`--cwd`); defaults to `process.cwd()`. */
      cwd?: string
      /** True over `--connect`: `@` completion then never falls back to this machine's disk. */
      remote?: boolean
      /** Last model and permission for the next fresh session. Omitted in tests that do not inherit. */
      composerSelectionPath?: string
      themePreferencePath?: string
      /** Where sent prompts persist between runs; without it history lasts this run only. */
      historyPath?: string
      /** Ctrl-G's editor command source and temp directory (`<AGH_HOME>/tmp`); tests leave it to the defaults. */
      externalEditor?: ExternalEditorConfig
      /** What the launcher knows for the welcome, and what tests pin (see `WelcomeOptions`). */
      welcome?: WelcomeOptions
      /** Shown once on the status bar after a fresh session inherits a model or full permission. */
      initialNotice?: string
      /** Reads branch and worktree for the composer rail; the gallery injects fixed answers. */
      probeWorkspace?: WorkspaceProbe
    },
  ) {
    // One ansi instance per colour tier for the whole frame: header, status bar, banner, editor
    // chrome and the cards all degrade through the same tier (none emits zero escape sequences).
    this.theme = new TuiTheme(readTheme(o.themePreferencePath))
    const ansi = this.theme.ansi(createAnsi(o.term.caps.color))
    const branding = o.branding ?? DEFAULT_BRANDING
    const locale = o.locale ?? 'en'
    this.hints = new Hints(ansi, () => this.timeline.newOutputHint(this.editor.text !== ''))
    this.loader = new Loader('', ansi)
    this.live = new LiveView(ansi, locale)
    this.localCommandView = localCommandView(ansi)
    this.statusBar = new StatusBar(ansi, locale)
    this.mouse = new TuiMouse(
      (rows) => this.scrollTimeline(rows),
      o.copy ?? systemCopy((s) => o.term.write(s)),
      copyTip(ansi, locale),
      () => this.stopped || this.renderer.requestRender(),
      (row) => this.timeline.click(row),
    )
    this.welcome = new WelcomeController(o, {
      branding,
      ansi,
      theme: this.theme,
      locale,
      viewport: () => ({ rows: o.term.size().rows, reserved: this.reservedRows }),
      shows: () => !this.stopped && !this.turnActive && this.timeline.showsWelcome(),
      repaint: () => this.stopped || this.renderer.requestRender(),
    })
    this.cards = new ToolCards({
      ansi,
      locale,
      session: () => this.o.session,
      closed: () => this.closedNotice !== undefined,
      changed: () => this.stopped || this.renderer.requestRender(),
      onAction: (actionId) => this.dispatchAction(actionId),
    })
    this.timeline = new Timeline({
      rows: () => o.term.size().rows,
      reservedRows: () => this.reservedRows,
      locale,
      // The welcome banner rides at the top of the timeline: it is built once here, so a session
      // switch (`/new`, `/resume`, `/rewind`) reuses it. It scrolls inside the fullscreen
      // viewport, never into the shell's history.
      top: this.welcome.banner,
      groupView: (nodes) => this.cards.group(nodes),
      nodeView: (node) => {
        if (node.kind === 'tool') return this.cards.view(node)
        if (node.kind === 'approval') {
          const card = new ApprovalCard(node, {
            ansi,
            locale,
            onDecide: async (ref, verdict) => {
              if (this.refuseClosed()) return
              await this.o.session.client.approval.decide({
                ...ref,
                commandId: `${ref.id}:${ref.revision}:${verdict}`,
                response: {
                  option: verdict,
                  value: (node.presentation?.[locale] ?? node.presentation?.en)?.responseValue ?? null,
                },
              })
            },
            // The decide call's settlement (in particular a rejection, which produces no new
            // ledger event for TuiProjection to pick up) has to ask for its own repaint: nothing
            // else in the render loop is watching that promise.
            changed: () => this.stopped || this.renderer.requestRender(),
          })
          this.approvalCards.set(node.id, card)
          return card
        }
        if (node.kind === 'assistant') return assistantView(node, ansi, locale)
        if (node.kind === 'user') {
          const text = nodeText(node)
          return new UserMessage(
            text.startsWith('you: ') ? text.slice('you: '.length) : text,
            ansi,
            this.theme,
            brandColour(branding.accent),
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
        ansi,
        // The renderer drops a tall frame's top rows, so the modal gets no more than the rows below it
        // leave: an option it counts as visible has to be on screen.
        maxRows: () => {
          const { rows } = o.term.size()
          return Math.max(1, Math.min(rows - Math.max(1, Math.floor(rows / 3)) - 4, rows - this.belowModal))
        },
      },
    )
    // Asks whichever session is current; applySwitch resets the cached answers.
    this.mentions = createMentionSource({
      session: { searchReferences: (query) => this.session.searchReferences(query) },
      cwd: this.cwd,
      remote: o.remote ?? false,
      locale,
      changed: () => this.stopped || this.renderer.requestRender(),
    })
    this.editor = new Editor({
      maxRows: () => Math.max(1, Math.floor(o.term.size().rows / 3)),
      placeholder: tt('app.composerPlaceholder', locale),
      locale,
      ansi,
      busy: () => this.busy,
      history: new PromptHistory(o.historyPath),
      onSubmit: (text) => {
        void this.runInput(text)
      },
      onExternalEdit: () =>
        void editDraft(this.editor, this.renderer, this.statusBar, locale, o.externalEditor),
      onCancelKey: () => {
        void this.cancel().catch((error) => this.showError(error))
      },
      complete: completeToken,
      mentions: this.mentions,
      mentionNotes: {
        loading: tt('composer.mentionLoading', locale),
        empty: tt('composer.mentionEmpty', locale),
        failed: tt('composer.mentionFailed', locale),
      },
      menuInfo: (name) => slashCommandFor(name, this.o.locale ?? 'en'),
    })
    this.editor.setKitty(o.term.caps.kittyKeyboard)
    this.modelPicker = new ModelPicker({
      ansi,
      locale,
      maxRows: () => Math.max(4, o.term.size().rows - 6),
      onChoose: (choice) => void this.chooseModel(choice),
      changed: () => this.stopped || this.renderer.requestRender(),
    })
    this.themePicker = new ThemePicker(ansi, locale, (name) => {
      this.statusBar.setNotice(this.setTheme(name))
    })
    this.sessionPicker = new SessionPicker({
      ansi,
      locale,
      maxRows: () => Math.max(4, o.term.size().rows - 6),
      onChoose: (choice) => void this.chooseSession(choice),
      changed: () => this.stopped || this.renderer.requestRender(),
    })
    this.usagePanel = new UsagePanel({
      ansi,
      locale,
      maxRows: () => Math.max(4, o.term.size().rows - 7),
      changed: () => this.stopped || this.renderer.requestRender(),
    })
    this.packageController = new PackageController(o.controlClient, () => this.profile)
    this.composer = new Composer(this.editor, ansi, locale)
    this.composer.setWorkspace({ root: tildePath(this.cwd), subpath: '' })
    // At startup and after every turn (the agent may have switched branch); never blocks a frame.
    this.refreshWorkspace = workspaceRefresher(this.cwd, o.probeWorkspace ?? readWorkspaceInfo, (info) => {
      this.composer.setWorkspace(info)
      this.welcome.workspace(info)
      if (!this.stopped) this.renderer.requestRender()
    })
    // Zero rows until the first turn starts (spec RP1.2). `Loader`'s own constructor is
    // immediately visible by design (see loader.ts's doc comment), so the app -- not the
    // component -- is what decides a fresh session shows nothing yet.
    this.loader.hide()
    const root = new VStack([
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
      this.signals.sync()
      const shown = root.children.filter((child) => !(this.modal.pending && dialogs.includes(child)))
      let rows = 0
      for (const child of shown.toReversed()) {
        if (child === this.modal) this.belowModal = rows
        if (child !== this.timeline) rows += child.render(width).length
      }
      this.reservedRows = Math.max(TIMELINE_RESERVED_ROWS, rows)
      const height = o.term.size().rows
      const at = shown.indexOf(this.modal)
      const above = shown.slice(0, at).flatMap((child) => child.render(width))
      const below = shown.slice(at).flatMap((child) => child.render(width))
      // The input area, from the approval dialog down, sits on the bottom edge; a short
      // conversation leaves its gap above it rather than below.
      const gap = Number.isFinite(height) ? Math.max(0, height - above.length - below.length) : 0
      const screen = [...above, ...Array.from({ length: gap }, () => ''), ...below]
      this.mouse.overlay(screen, above.length + gap - 1, width)
      return this.theme.frame(createAnsi(o.term.caps.color), screen, width, height)
    }
    const handle = root.handleInput.bind(root)
    root.handleInput = (data) => {
      if (this.signals.focus(data)) return true
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
      if (!inert && this.cards.handleInput(data)) return true
      const key = parseKey(data, o.term.caps.kittyKeyboard)
      if (key.name === 'ctrl-o') {
        this.cards.toggleLatest()
        return true
      }
      if (key.name === 'f1' || key.name === 'f2' || key.name === 'f3' || key.name === 'f4') {
        const action = this.hintActions[Number(key.name.slice(1)) - 1]
        if (action && !action.disabled) this.dispatchAction(action.id)
        return true
      }
      if (this.timeline.jumpKey(key.name, this.editor.text !== '')) return true
      if (key.name === 'pgup' || key.name === 'pgdn') {
        const page = Math.max(1, o.term.size().rows - this.reservedRows)
        this.scrollTimeline(key.name === 'pgup' ? -page : page)
        return true
      }
      // Idle Alt+Enter inserts a newline (the editor's own default, reached via `handle(data)`
      // below). Busy, it steers the draft into the turn in flight, where Enter queues it behind.
      if (key.name === 'alt-enter' && this.busy) {
        const text = this.editor.expanded()
        if (text.trim() && !this.refuseClosed()) {
          this.editor.clear()
          void this.submitBlocks(attachmentsFrom(text, this.cwd, this.o.remote), text, true).catch((error) =>
            this.showError(error),
          )
        }
        return true
      }
      if (key.name === 'ctrl-c') {
        this.interrupts.press(
          () => this.cancel(),
          () => this.onQuit(),
          (error) => this.showError(error),
        )
        return true
      }
      if (parseKey(data, o.term.caps.kittyKeyboard).name === 'ctrl-d' && !this.editor.text && !this.busy) {
        this.onQuit()
        return true
      }
      return handle(data)
    }
    this.signals = new TerminalSignals(
      o.term,
      this.cwd,
      () => this.turnActive,
      this.modal,
      this.approvalCards,
    )
    this.renderer = new Renderer(o.term, root, o.screenAlreadyEntered, this.mouse)
    this.projection = this.makeProjection(o.session)
  }

  get busy(): boolean {
    // A turn counts whoever started it: the projection shows turns of other clients, and the
    // local flag covers the window before the projection catches up with this client's own prompt.
    return this.localTurn || this.turnActive
  }

  /** Refuses, with a notice, while this client's own prompt still belongs to the current session: a
   * switch would send Ctrl-C's cancel to the next session instead. */
  refuseSwitch(): boolean {
    // Only this client's own in-flight prompt belongs to the session: a turn the projection shows
    // is the daemon's, and the cancel it needs goes by session, not by what this client displays.
    const refused = this.localTurn
    if (refused) this.statusBar.setNotice('Turn pending: finish or Ctrl-C before switching.', 'warning')
    return refused
  }

  get session(): Session {
    return this.o.session
  }

  get locale(): Locale {
    return this.o.locale ?? 'en'
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
      ? tt('app.themeSaved', this.locale, { name })
      : tt('app.themeEphemeral', this.locale, { name })
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

  private scrollTimeline(delta: number): void {
    if (!this.timeline.scroll(delta)) return
    void this.projection.loadEarlier().then((ok) => ok && !this.stopped && this.renderer.requestRender())
  }

  private makeProjection(session: Session): TuiProjection {
    let opening = true
    return new TuiProjection(session, {
      timeline: (value, window) => {
        this.apply(value, { opening: opening || window.reason === 'opening', window })
        opening = false
      },
      preview: (p) => {
        if (!this.previews.add(p)) return
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
    this.refreshWorkspace()
    try {
      this.signals.start()
      this.renderer.start()
      await this.projection.start()
    } catch (error) {
      await this.stop()
      throw error
    }
    this.welcome.start()
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
  // (packages/daemon-foundation/src/lease/reclaim.ts) and worker pool (packages/daemon/src/supervisor/
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
  // tick that would stop the spinner never arrives.
  private handleClosed(): void {
    this.closedNotice = t('notice.closed', this.o.locale ?? 'en', { id: escapeControl(this.o.session.id) })
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

  private async syncSurfaces(): Promise<void> {
    const session = this.o.session
    if (this.stopped || this.closedNotice || typeof session.uiRead !== 'function') return
    if (this.readingSurfaces === session) {
      this.surfaceReadAgain = true
      return
    }
    this.readingSurfaces = session
    try {
      const page = await session.uiRead()
      let cursor = page.nextCursor
      while (cursor) {
        const next = await session.uiRead({ cursor })
        page.surfaces.push(...next.surfaces)
        cursor = next.nextCursor
      }
      if (this.stopped || this.closedNotice || session !== this.o.session) return
      if (page.lastSeq < this.surfaceWatermark) {
        this.surfaceReadAgain = true
        return
      }
      this.surfaceWatermark = page.lastSeq
      for (const record of page.surfaces) {
        if (this.surfaceVersions.get(record.surface.id) === record.updatedSeq) continue
        this.surfaceVersions.set(record.surface.id, record.updatedSeq)
        this.timeline.appendLocal(
          session.id,
          this.localCommandView(
            record.surface.title,
            surfaceText(record.surface) +
              `\n[Open in Web](/?session=${encodeURIComponent(session.id)}&surface=${encodeURIComponent(record.surface.id)})`,
            false,
          ),
        )
      }
      const next = pendingSurface(page)
      // Keep the displayed request binding until submission; backend refuses an old revision.
      if (!this.surfacePrompt || this.surfacePrompt.surface.id !== next?.surface.id) this.surfacePrompt = next
      if (this.surfacePrompt) this.statusBar.setNotice(tt('app.surfacePrompt', this.locale))
      this.renderer.requestRender()
    } catch (error) {
      const code = (error as { data?: { code?: string } } | undefined)?.data?.code
      if (code !== 'CAPABILITY_DENIED' && code !== 'METHOD_NOT_FOUND' && session === this.o.session)
        this.showError(error)
    } finally {
      if (this.readingSurfaces === session) {
        this.readingSurfaces = undefined
        if (this.surfaceReadAgain) {
          this.surfaceReadAgain = false
          void this.syncSurfaces()
        }
      }
    }
  }

  private apply(value: UITimeline, options: { opening?: boolean; window?: TuiProjectionWindow } = {}): void {
    void this.syncSurfaces()
    this.cards.sync(value)
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
    this.statusBar.setParked(value.opState?.parked?.decisionRef.id)
    this.statusBar.setUsage(value.usage)
    this.composer.setUsage(value.usage)
    // `UITimeline.budget` (core's project/ui.ts:282,330) rides along on every projection tick for
    // free -- it is read out of the same register snapshot the rest of this timeline was built
    // from, in the same transaction. That is a stronger consistency guarantee than a separate
    // `session.budget()` round-trip could offer (which could land between two ticks and show a
    // value older or newer than what the rest of this repaint reflects), so this reads `value.
    // budget` directly rather than polling `session.budget()` on `turn/end`.
    if (value.budget) this.statusBar.setBudget(value.budget.creditsUsed, value.budget.creditsCap ?? undefined)
    this.welcome.projected(value.usage)
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
      this.refreshWorkspace()
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
    this.live.set(this.previewEffects.flatMap((effectId) => this.previews.text(effectId) ?? []))
    this.renderer.requestRender()
  }

  private showError(error?: unknown): void {
    if (this.stopped) return
    this.statusBar.setNotice(formatTuiErrorNotice(error, this.o.locale ?? 'en'), 'error')
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
    const owner = this.o.session
    const r = await runSlash(this, text)
    if (r.content) {
      if (this.stopped || owner !== this.o.session) throw new Error('ATTACHMENT_NOT_AUTHORIZED')
      await this.submitBlocks(r.content)
    }
    if (r.prompt) await this.submit(r.prompt)
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
    if (r.draft !== undefined) this.editor.setText(r.draft)
    if (r.modelChoices) {
      this.statusBar.setNotice(undefined)
      this.modelPicker.show(r.modelChoices)
    }
    if (r.sessionChoices) {
      this.statusBar.setNotice(undefined)
      this.sessionPicker.show(r.sessionChoices, r.sessionPickerTitle)
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
    this.editor.resetUndo()
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
    this.welcome.banner.setModel(undefined)
    this.surfacePrompt = undefined
    this.surfaceCommand = undefined
    this.surfaceVersions.clear()
    this.surfaceWatermark = 0
    this.surfaceReadAgain = false
    this.attachmentController.abort()
    this.attachmentController = new AbortController()
    this.mentions.reset()
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
      // A rewind row forks the open session at its completed-turn boundary; any other row resumes.
      const next =
        choice.forkAt === undefined
          ? await this.o.session.client.session.load(choice.sessionId, { cwd: this.cwd })
          : await this.o.session.client.session.fork(choice.sessionId, choice.forkAt)
      if (await this.applySwitch(next))
        this.statusBar.setNotice(
          choice.forkAt === undefined
            ? `Resumed ${escapeControl(choice.sessionId)}`
            : tt('session.rewound', this.locale, {
                turn: choice.title?.match(/^#(\d+)/)?.[1] ?? choice.forkAt,
              }),
          'success',
        )
      if (!this.stopped) this.renderer.requestRender()
    } catch (error) {
      this.showError(error)
    }
  }

  async submit(text: string): Promise<void> {
    if (this.stopped) throw new Error('TUI stopped')
    if (!text.trim()) return
    const skillCommand = /^\/skill\s+invoke\s+\S+/.test(text)
    if (text.startsWith('/') && !skillCommand) throw new Error('Command unavailable')
    this.statusBar.setNotice(undefined)
    if ((this.surfacePrompt || this.surfaceCommand) && !skillCommand) {
      const record = this.surfacePrompt
      const session = this.o.session
      const command =
        this.surfaceCommand ??
        (record
          ? {
              surfaceId: record.surface.id,
              revision: record.surface.revision,
              commandId: randomUUID(),
              ...numberedSurfaceInput(record.surface, text),
            }
          : undefined)
      if (!command) return
      this.surfaceCommand = command
      const receipt = await session.uiAction(command)
      if (session !== this.o.session || this.stopped) return
      this.surfaceWatermark = Math.max(this.surfaceWatermark, receipt.seq)
      this.surfaceCommand = undefined
      this.surfacePrompt = undefined
      await this.syncSurfaces()
      this.statusBar.setNotice(
        receipt.refusal?.message ?? tt('app.questionSent', this.locale),
        receipt.status === 'rejected' ? 'error' : 'success',
      )
      this.renderer.requestRender()
      return
    }
    await this.submitBlocks(attachmentsFrom(text, this.cwd, this.o.remote), text)
  }

  /** Sends one input: a prompt when idle; while a turn runs it goes to the daemon queue, or into the turn with `steer`. */
  private async submitBlocks(blocks: ContentBlock[], draft = textOf(blocks), steer = false): Promise<void> {
    this.prompted.add(this.o.session.id)
    if (this.busy) return this.busyInput.queue(blocks, draft, steer ? 'steer' : 'followUp')
    this.localTurn = true
    try {
      await this.busyInput.prompt(blocks, draft)
    } finally {
      this.localTurn = false
    }
  }

  async cancel(): Promise<void> {
    this.attachmentController.abort()
    this.attachmentController = new AbortController()
    if (!this.busy) return
    const refused = await cancelTurn(this.o.session, this.locale)
    if (refused) {
      this.statusBar.setNotice(refused, 'error')
      this.renderer.requestRender()
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.mentions.dispose()
    this.attachmentController.abort()
    this.mouse.dispose()
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
      this.signals.stop()
      this.renderer.stop()
    } finally {
      await this.projection.stop()
    }
  }
}
