import type { ContentBlock, UITimeline } from '@agnes/protocol'
import { DEFAULT_BRANDING, PreviewMerger, type Session } from '@agnes/sdk'
import { createAnsi } from './ansi.js'
import type { TuiAppOptions } from './app-options.js'
import { ApprovalSettle } from './approval-settle.js'
import { BangShell, isBangLine } from './bang-shell.js'
import { Borders } from './borders.js'
import { BusyInput, cancelTurn, textOf } from './busy-input.js'
import { CardFocus } from './card-focus.js'
import { pasteClipboardImage } from './clipboard-image.js'
import { applyCommandResult } from './command-result.js'
import { completeToken, createProviderSetup, opensSwitch, runSlash, slashCommandFor } from './commands.js'
import { type Component, escapeControl, VStack } from './component.js'
import { Loader } from './components/loader.js'
import { DraftStash } from './draft-stash.js'
import { attachDroppedImages } from './dropped-images.js'
import { Editor } from './editor.js'
import { formatTuiErrorNotice } from './error-notice.js'
import { editDraft } from './external-editor.js'
import { attachmentsFrom, createMentionSource, type ReferenceMentionSource } from './file-mentions.js'
import { FooterRenderer } from './footer-renderer.js'
import { foldingTerminal } from './glyphs.js'
import { imageProtocol } from './image-protocol.js'
import { InlineImages } from './inline-image.js'
import { DoubleCtrlC, DoubleEsc } from './interrupt.js'
import { createLinker } from './links.js'
import { type Locale, NOTICE_STATUS, t } from './locale.js'
import { tt } from './locale-extended.js'
import { renderMarkdownChunk } from './markdown.js'
import { ModelChooser } from './model-chooser.js'
import { copyTip, systemCopy, TuiMouse } from './mouse.js'
import { nodeView } from './node-view.js'
import { NotifyPreference } from './notify.js'
import { PackageController } from './package-controller.js'
import { PagerOverlay } from './pager-overlay.js'
import { PermissionModal } from './permission-modal.js'
import { TuiProjection, type TuiProjectionWindow } from './projection.js'
import { type PromptArea, routeClick } from './prompt-click.js'
import { PromptHistory } from './prompt-history.js'
import { RawView } from './raw-view.js'
import { Renderer, type ScreenRenderer } from './renderer.js'
import type { TuiResourceController } from './resource-controller.js'
import { type InputDialog, rootInput } from './root-input.js'
import { rootRender } from './root-layout.js'
import {
  applySwitch,
  beginSwitch,
  chooseSession,
  ResourceConfirmations,
  settleSwitch,
} from './session-switch.js'
import { isSlashCommandLine } from './slash-table.js'
import { type ActionItem, collectSlots } from './slots.js'
import { StatusLineConfig } from './statusline-config.js'
import { SurfaceInbox } from './surface-inbox.js'
import { suspendToShell } from './suspend.js'
import { TerminalSignals } from './terminal-signals.js'
import { brandColour, type TuiTheme, type TuiThemeName } from './theme.js'
import { ThemeController } from './theme-controller.js'
import { LiveView } from './thinking.js'
import { ToolCards } from './tool-cards.js'
import { TurnClock } from './turn-clock.js'
import type { ApprovalCard } from './views/approval-card.js'
import { Composer } from './views/composer.js'
import { Hints } from './views/hints.js'
import { localCommandView } from './views/local-command.js'
import { ModelPicker } from './views/model-picker.js'
import { PlanPanel } from './views/plan-panel.js'
import { SessionPicker } from './views/session-picker.js'
import { StatusBar } from './views/status-bar.js'
import { StatusLinePicker } from './views/statusline-picker.js'
import type { ThemePicker } from './views/theme-picker.js'
import { TIMELINE_RESERVED_ROWS, Timeline } from './views/timeline.js'
import { UsagePanel } from './views/usage-panel.js'
import { Vim } from './vim-mode.js'
import { WelcomeController } from './welcome-controller.js'
import { WindowTitle } from './window-title.js'
import { readWorkspaceInfo, tildePath, workspaceRefresher } from './workspace-info.js'
import { WorktreeKeeper } from './worktree.js'

export { formatTuiErrorNotice } from './error-notice.js'

export class TuiApp {
  // The fields from here to `previewEffects` that carry no `private` are the ones session-switch.ts swaps.
  attachmentController = new AbortController()
  get attachmentSignal(): AbortSignal {
    return this.attachmentController.signal
  }
  readonly surfaces: SurfaceInbox
  readonly modal: PermissionModal
  offPermission: (() => void) | undefined
  // Registered once in `start()` against whichever client the initial session belongs to. A
  // session switch (`applySwitch`) never replaces the underlying `Client` -- the daemon
  // connection outlives any one session -- so these are not re-registered per session.
  private offClientEvents: Array<() => void> = []
  /** Public so `/mouse` can switch the terminal's mouse reporting. */
  readonly renderer: ScreenRenderer
  // Not readonly: `applySwitch` (a slash command that switches session -- /new, /resume, /rewind)
  // replaces it with a fresh projection built for the newly current session.
  projection: TuiProjection
  readonly timeline: Timeline
  readonly welcome: WelcomeController
  readonly cards: ToolCards
  private readonly approvalCards = new Map<string, ApprovalCard>()
  private latestApproval: string | undefined
  private reservedRows = TIMELINE_RESERVED_ROWS
  // Rows rendered under the permission modal, measured before the modal itself renders each frame.
  private belowModal = 0
  // Where the draft's rows were drawn last frame, and whether a picker or panel covered the prompt.
  private promptArea: PromptArea | undefined
  private dialogShown = false
  private readonly live: LiveView
  private readonly loader: Loader
  readonly clock: TurnClock
  readonly mouse: TuiMouse
  readonly statusBar: StatusBar
  private readonly models = new ModelChooser(
    this,
    () => this.refuseClosed(),
    () => this.stopped,
  )
  private readonly hints: Hints
  private hintActions: ActionItem[] = []
  readonly editor: Editor
  private readonly drafts: DraftStash
  readonly mentions: ReferenceMentionSource
  private readonly composer: Composer
  private readonly theme: TuiTheme
  readonly themes: ThemeController
  readonly themePicker: ThemePicker
  readonly usagePanel: UsagePanel
  readonly planPanel: PlanPanel
  readonly statusLine: StatusLinePicker
  readonly windowTitle: WindowTitle
  readonly raw: RawView
  readonly borders: Borders
  readonly images: InlineImages
  private readonly pager: PagerOverlay
  readonly cardFocus: CardFocus
  readonly modelPicker: ModelPicker
  readonly sessionPicker: SessionPicker
  readonly providerSetup: ReturnType<typeof createProviderSetup>
  readonly packages: PackageController
  readonly localCommandView: (command: string, output: string, quiet?: boolean) => Component
  // Streamed text is never in the projected timeline: a streaming node stays empty there, and the
  // live line shows what the previews of every inference still streaming have said.
  readonly previews = new PreviewMerger()
  readonly previewEffects: string[] = []
  stopped = false
  /** Sessions this run sent a message to: the exit hint is for those only. */
  readonly prompted = new Set<string>()
  private readonly signals: TerminalSignals
  private readonly settle = new ApprovalSettle(
    () => this.stopped || this.renderer.requestRender(),
    () => this.modal.head ?? this.approvalCards.get(this.latestApproval ?? '')?.key,
  )
  readonly notify: NotifyPreference
  // Set once the client reports 'closed' (daemon shutting down). The session can never render again,
  // and the SDK would still re-dial on the next call, so input is refused rather than run unseen.
  private closedNotice: string | undefined
  private localTurn = false
  private readonly interrupts = new DoubleCtrlC()
  private readonly escapes = new DoubleEsc()
  /** `!cmd` / `!!cmd` shell lines of the prompt. */
  readonly bang = new BangShell(this)
  readonly busyInput = new BusyInput({
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
  /** True while Ctrl-G has handed the terminal to an external editor. */
  externalEditorOpen = false
  /** True when a double Ctrl-C quit before the daemon answered the cancel. */
  get cancelUnconfirmed(): boolean {
    return this.interrupts.unconfirmed
  }
  readonly refreshWorkspace: () => void
  /** The worktrees this run made; a session in one of them shows its branch on the rail. */
  readonly worktrees = new WorktreeKeeper()
  private readonly shown = (): string => this.worktrees.current()?.path ?? this.cwd

  constructor(
    // `header` is a back-compat fallback: real callers (`modes/tui.ts`) pass `profile`/`preset`
    // directly; existing tests that only ever set a plain `header` string still get a header line
    // out of it (via `profile: o.profile ?? o.header`), just with an empty preset segment.
    readonly o: TuiAppOptions,
  ) {
    // One ansi instance per colour tier for the whole frame: header, status bar, banner, editor
    // chrome and the cards all degrade through the same tier (none emits zero escape sequences).
    this.borders = new Borders({
      path: o.themePreferencePath,
      env: process.env,
      changed: () => this.stopped || this.renderer.redraw(),
    })
    this.images = new InlineImages({
      protocol: o.noAltScreen ? undefined : imageProtocol(process.env),
      path: o.themePreferencePath,
      raw: () => this.theme.raw,
      session: () => this.o.session,
      repaint: () => this.stopped || this.renderer.requestRender(),
    })
    this.notify = new NotifyPreference(o.notifyPreferencePath, process.env, () => this.locale)
    const base = createAnsi(o.term.caps.color)
    this.themes = new ThemeController({
      term: o.term,
      path: o.themePreferencePath,
      locale: o.locale ?? 'en',
      base,
      notice: (text) => this.statusBar.setNotice(text),
      repaint: () => {
        this.timeline.refreshViews()
        this.editor.invalidate()
        if (!this.stopped) this.renderer.requestRender()
      },
    })
    this.theme = this.themes.theme
    this.themePicker = this.themes.picker
    const ansi = this.theme.ansi(base)
    const branding = o.branding ?? DEFAULT_BRANDING
    const locale = o.locale ?? 'en'
    this.hints = new Hints(ansi, () => this.timeline.newOutputHint(this.editor.text !== ''))
    this.loader = new Loader('', ansi)
    this.clock = new TurnClock(
      this.loader,
      () => this.stopped || this.renderer.requestRender(),
      () => this.refreshWorkspace(),
    )
    this.live = new LiveView(ansi, locale)
    this.localCommandView = localCommandView(ansi)
    this.statusLine = new StatusLinePicker({
      config: new StatusLineConfig(o.themePreferencePath),
      ansi,
      locale,
      changed: () => this.stopped || this.renderer.requestRender(),
    })
    this.statusBar = new StatusBar(ansi, locale, o.safeMode, o.preset, this.statusLine.config)
    this.mouse = new TuiMouse(
      (rows) => this.scrollTimeline(rows),
      o.copy ?? systemCopy((s) => o.term.write(s)),
      copyTip(ansi, locale),
      () => this.stopped || this.renderer.requestRender(),
      (row, col) =>
        routeClick(
          this.promptArea,
          row,
          col,
          this.promptClickable(),
          (r, c) => this.editor.moveCursorToCell(r, c),
          (r) => !this.pager.open && this.timeline.click(r),
        ),
    )
    this.welcome = new WelcomeController(o, {
      branding,
      ansi,
      theme: this.theme,
      locale,
      viewport: () => ({ rows: o.term.size().rows, reserved: this.reservedRows }),
      shows: () => !this.stopped && !this.clock.active && this.timeline.showsWelcome(),
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
      split: o.noAltScreen === true,
      stream: {
        text: (id) => this.previews.text(id)?.text,
        markdown: (md, width) => renderMarkdownChunk(md, width, ansi),
      },
      rows: () => o.term.size().rows,
      reservedRows: () => this.reservedRows,
      locale,
      // The welcome banner rides at the top of the timeline: it is built once here, so a session
      // switch (`/new`, `/resume`, `/rewind`) reuses it. It scrolls inside the fullscreen
      // viewport, never into the shell's history.
      top: this.welcome.banner,
      groupView: (nodes) => this.cards.group(nodes),
      nodeView: nodeView({
        ansi,
        locale,
        theme: this.theme,
        accent: brandColour(branding.accent),
        cards: this.cards,
        approvalCards: this.approvalCards,
        session: () => this.o.session,
        settled: () => this.settle.settled,
        letters: () => this.editor.text === '',
        dialog: () => this.modal.pending,
        waiting: (id) => this.latestApproval !== undefined && id !== this.latestApproval,
        refuseClosed: () => this.refuseClosed(),
        repaint: () => this.stopped || this.renderer.requestRender(),
        images: this.images,
      }),
    })
    this.modal = new PermissionModal(() => this.stopped || this.renderer.requestRender(), {
      locale,
      ansi,
      settled: () => this.settle.settled,
      letters: () => this.editor.text === '',
      // The renderer drops a tall frame's top rows, so the modal gets no more than the rows below it
      // leave: an option it counts as visible has to be on screen.
      maxRows: () => {
        const { rows } = o.term.size()
        return Math.max(1, Math.min(rows - Math.max(1, Math.floor(rows / 3)) - 4, rows - this.belowModal))
      },
    })
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
      onSubmit: (text, raw, chips) => {
        void this.runInput(text, raw, chips)
      },
      onPasteText: (text) => attachDroppedImages(this, text),
      onPasteImage: () => void pasteClipboardImage(this).catch((error) => this.showError(error)),
      onExternalEdit: () => {
        this.externalEditorOpen = true
        void editDraft(this.editor, this.renderer, this.statusBar, locale, o.externalEditor).finally(() => {
          this.externalEditorOpen = false
        })
      },
      onCancelKey: (hadDraft) => {
        const idle = !this.busy
        void this.cancel().catch((error) => this.showError(error))
        this.escapes.press(idle && !hadDraft, () => void this.runInput('/rewind'))
      },
      complete: (prefix, before) => completeToken(prefix, this, before),
      mentions: this.mentions,
      mentionNotes: {
        loading: tt('composer.mentionLoading', locale),
        empty: tt('composer.mentionEmpty', locale),
        failed: tt('composer.mentionFailed', locale),
      },
      menuInfo: (name) => slashCommandFor(name, this.o.locale ?? 'en', this),
      vim: new Vim(o.themePreferencePath),
    })
    this.editor.setKitty(o.term.caps.kittyKeyboard)
    this.modelPicker = new ModelPicker({
      ansi,
      locale,
      maxRows: () => Math.max(4, o.term.size().rows - 6),
      onChoose: (choice) => void this.models.choose(choice),
      changed: () => this.stopped || this.renderer.requestRender(),
    })
    this.sessionPicker = new SessionPicker({
      ansi,
      locale,
      maxRows: () => Math.max(4, o.term.size().rows - 6),
      onChoose: (choice) => void chooseSession(this, choice),
      changed: () => this.stopped || this.renderer.requestRender(),
    })
    this.providerSetup = createProviderSetup(this, ansi, locale)
    this.usagePanel = new UsagePanel({
      ansi,
      locale,
      maxRows: () => Math.max(4, o.term.size().rows - 7),
      changed: () => this.stopped || this.renderer.requestRender(),
    })
    this.pager = new PagerOverlay({
      theme: this.theme,
      term: o.term,
      locale,
      timeline: this.timeline,
      loadEarlier: () => this.projection.loadEarlier(),
      mouse: this.mouse,
      changed: () => this.stopped || this.renderer.requestRender(),
    })
    this.planPanel = new PlanPanel(ansi, locale)
    this.windowTitle = new WindowTitle({
      path: o.themePreferencePath,
      cwd: this.cwd,
      session: () => this.o.session,
      changed: () => this.stopped || this.renderer.requestRender(),
    })
    this.cardFocus = new CardFocus({
      timeline: this.timeline,
      cards: this.cards,
      ansi,
      locale,
      notice: (text) => this.statusBar.setNotice(text),
      changed: () => this.stopped || this.renderer.requestRender(),
    })
    this.packages = new PackageController(o.controlClient, () => this.profile)
    this.composer = new Composer(this.editor, ansi, locale, this.statusLine.config)
    this.composer.setWorkspace({ root: tildePath(this.cwd), subpath: '' })
    // At startup and after every turn (the agent may have switched branch); never blocks a frame.
    this.refreshWorkspace = workspaceRefresher(this.shown, o.probeWorkspace ?? readWorkspaceInfo, (info) => {
      this.composer.setWorkspace(info)
      this.welcome.workspace(info)
      if (!this.stopped) this.renderer.requestRender()
    })
    // Zero rows until the first turn starts. `Loader`'s own constructor is
    // immediately visible by design (see loader.ts's doc comment), so the app -- not the
    // component -- is what decides a fresh session shows nothing yet.
    this.loader.hide()
    // A pending approval takes every keystroke, so the dialogs give up their rows until it is answered
    // and then reappear unchanged. Transient command dialogs belong immediately above the footer, not in
    // the conversation; closed ones render zero rows, preserving the normal rule/editor/status adjacency.
    const dialogs: readonly (Component & InputDialog)[] = [
      this.modelPicker,
      this.themePicker,
      this.sessionPicker,
      this.providerSetup,
      this.usagePanel,
      this.statusLine,
    ]
    const root = new VStack([
      this.timeline,
      this.live,
      this.loader,
      this.modal,
      this.planPanel,
      this.cardFocus,
      this.composer,
      ...dialogs,
      this.statusBar,
      this.hints,
    ])
    root.render = rootRender({
      sync: () => this.signals.sync(),
      pager: this.pager,
      modal: this.modal,
      timeline: this.timeline,
      composer: this.composer,
      dialogs,
      children: () => root.children,
      rows: () => o.term.size().rows,
      noAltScreen: o.noAltScreen,
      textRows: () => this.editor.textRows,
      frame: (rows, width, height) => this.theme.frame(createAnsi(o.term.caps.color), rows, width, height),
      overlay: (rows, row, width) => this.mouse.overlay(rows, row, width),
      report: (l) => {
        this.belowModal = l.belowModal
        this.reservedRows = l.reservedRows
        this.promptArea = l.promptArea
        this.dialogShown = l.dialogShown
      },
    })
    this.drafts = new DraftStash(
      this.editor,
      (text, tone) => this.statusBar.setNotice(text, tone),
      () => this.locale,
    )
    root.handleInput = rootInput(
      {
        signals: () => this.signals,
        settle: this.settle,
        modal: this.modal,
        dialogs: [this.pager, this.cardFocus, ...dialogs],
        openPager: () => this.pager.show(),
        openCards: () => this.cardFocus.enter(),
        approvalCards: this.approvalCards,
        latestApproval: () => this.latestApproval,
        closed: () => this.closedNotice !== undefined,
        cards: this.cards,
        models: this.models,
        stashDraft: () => this.drafts.press(),
        redraw: () => this.renderer.redraw(),
        suspend: () => suspendToShell(this.renderer, o.suspendIO),
        hintActions: () => this.hintActions,
        dispatchAction: (id) => this.dispatchAction(id),
        timeline: this.timeline,
        editor: this.editor,
        kitty: o.term.caps.kittyKeyboard,
        noAltScreen: o.noAltScreen,
        pageRows: () => Math.max(1, o.term.size().rows - this.reservedRows),
        scroll: (rows) => this.scrollTimeline(rows),
        busy: () => this.busy,
        refuseClosed: () => this.refuseClosed(),
        steer: (text) =>
          this.submitBlocks(
            [...attachmentsFrom(text, this.cwd, this.o.remote), ...this.busyInput.takeKept(text)],
            text,
            true,
          ),
        runInput: (text, raw, chips) => this.runInput(text, raw, chips),
        interrupts: this.interrupts,
        shellInterrupt: () => this.bang.interrupt(),
        cancel: () => this.cancel(),
        onQuit: () => this.onQuit(),
        showError: (error) => this.showError(error),
      },
      root.handleInput.bind(root),
    )
    this.signals = new TerminalSignals(
      o.term,
      this.cwd,
      () => this.clock.active,
      this.modal,
      this.approvalCards,
      this.notify,
      this.windowTitle,
    )
    // Frames, scrollback lines and the exit text all go through the glyph table when `/borders ascii` is on.
    const term = foldingTerminal(o.term, () => this.borders.ascii)
    this.renderer = o.noAltScreen
      ? new FooterRenderer(term, root, this.timeline)
      : new Renderer(
          term,
          root,
          o.screenAlreadyEntered,
          this.mouse,
          o.mouse !== false,
          createLinker(process.env),
          this.images.layer,
        )
    this.surfaces = new SurfaceInbox({
      session: () => this.o.session,
      stopped: () => this.stopped,
      closed: () => Boolean(this.closedNotice),
      locale: () => this.locale,
      statusBar: this.statusBar,
      appendLocal: (id, view) => this.timeline.appendLocal(id, view),
      localCommandView: this.localCommandView,
      repaint: () => this.renderer.requestRender(),
      showError: (error) => this.showError(error),
    })
    this.raw = new RawView({
      theme: this.theme,
      renderer: this.renderer,
      statusBar: this.statusBar,
      refresh: () => {
        this.timeline.refreshViews()
        this.renderer.requestRender()
      },
    })
    this.projection = this.makeProjection(o.session)
  }

  /** A click may move the prompt cursor only while nothing else (approval, pager, card focus, a picker) has the keyboard. */
  private promptClickable(): boolean {
    return (
      !this.pager.open && !this.modal.pending && !this.cardFocus.open && !this.dialogShown && !this.raw.on
    )
  }

  get busy(): boolean {
    // A turn counts whoever started it: the projection shows turns of other clients, and the
    // local flag covers the window before the projection catches up with this client's own prompt.
    return this.localTurn || this.clock.active
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

  /** A local note under the current session's transcript, headed by the command that caused it. */
  noteLocal(command: string, text: string): void {
    this.timeline.appendLocal(this.session.id, this.localCommandView(command, text))
  }

  get composerSelectionPath(): string | undefined {
    return this.o.composerSelectionPath
  }

  get themeName(): TuiThemeName {
    return this.theme.name
  }

  showThemePicker(): void {
    this.modelPicker.close()
    this.sessionPicker.close()
    this.usagePanel.close()
    this.themes.show()
    if (!this.stopped) this.renderer.requestRender()
  }

  /** Resource control is supplied only by the Node CLI bootstrap, never the chat/session client. */
  private readonly confirmations = new ResourceConfirmations()
  readonly queueResourceConfirmation = this.confirmations.queue
  readonly takeResourceConfirmation = this.confirmations.take
  readonly cancelResourceConfirmation = this.confirmations.cancel

  get resourceController(): TuiResourceController | undefined {
    return this.o.resourceController
  }

  private scrollTimeline(delta: number): void {
    if (this.pager.open) this.pager.scroll(delta)
    else if (this.timeline.scroll(delta))
      void this.projection.loadEarlier().then((ok) => ok && !this.stopped && this.renderer.requestRender())
  }

  makeProjection(session: Session): TuiProjection {
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

  /** Text typed before the session was ready; it lands in the editor unsent. */
  setDraft(text: string): void {
    this.editor.setText(text)
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
      this.themes.follow()
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
  // `{kind, sessionId?, detail, at}` with `detail` an open `JsonValue`); only the kinds in
  // `NOTICE_STATUS` get a status-bar rendering: what daemon's reclaim path (packages/daemon-foundation/
  // src/lease/reclaim.ts) and worker pool (packages/daemon/src/supervisor/worker-pool.ts) emit, plus the
  // SDK's own `stream-recovery-failed`. Anything else is left alone rather than guessed at.
  private handleNotice(payload: unknown): void {
    const n = payload as { kind?: string; sessionId?: string; detail?: { lastStep?: number } }
    // The previous session stays attached after /new, /resume and /cd, so its notices still arrive.
    if (n.sessionId !== undefined && n.sessionId !== this.o.session.id) return
    const entry = NOTICE_STATUS.get(n.kind ?? '')
    if (!entry) return
    this.statusBar.setNotice(
      t(entry[0], this.o.locale ?? 'en', { step: n.detail?.lastStep ?? '?' }),
      entry[1],
    )
    if (!this.stopped) this.renderer.requestRender()
  }

  // 'closed' is terminal: the projection's event stream has ended, so the closing `opState: null`
  // tick that would stop the spinner never arrives.
  private handleClosed(): void {
    this.closedNotice = t('notice.closed', this.o.locale ?? 'en', { id: escapeControl(this.o.session.id) })
    void this.projection.stop()
    this.clock.reset()
    this.refuseClosed()
  }

  /** Every path that would call the daemon after 'closed' routes through here instead. */
  refuseClosed(): boolean {
    if (this.closedNotice === undefined) return false
    this.statusBar.setNotice(this.closedNotice)
    if (!this.stopped) this.renderer.requestRender()
    return true
  }

  private apply(value: UITimeline, options: { opening?: boolean; window?: TuiProjectionWindow } = {}): void {
    void this.surfaces.sync()
    this.o.onTimeline?.(value, options.window?.hasEarlier)
    this.cards.sync(value)
    this.planPanel.apply(value)
    this.windowTitle.tick(value)
    this.signals.watch(value.nodes)
    const approvals = value.nodes.filter((node) => node.kind === 'approval')
    const approvalIds = new Set(approvals.map((node) => node.id))
    for (const id of this.approvalCards.keys()) if (!approvalIds.has(id)) this.approvalCards.delete(id)
    this.latestApproval = approvals.findLast((node) => node.state === 'pending' && node.decisionRef)?.id
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
    this.clock.apply(value.opState)
    this.statusBar.setParked(value.opState?.parked?.decisionRef.id)
    this.statusBar.setUsage(value.usage, value.yolo)
    this.models.current = value.usage?.model
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

  private renderLive(): void {
    for (let i = this.previewEffects.length - 1; i >= 0; i--)
      if (this.previews.text(this.previewEffects[i] ?? '') === undefined) this.previewEffects.splice(i, 1)
    // Read when drawn, not now: the frame may write more of this text into scrollback first.
    this.live.set(() =>
      this.previewEffects.flatMap((id) => {
        const s = this.previews.text(id)
        return s ? [{ ...s, text: this.timeline.pending(id, s.text) }] : []
      }),
    )
    this.renderer.requestRender()
  }

  showError(error?: unknown): void {
    if (this.stopped) return
    this.statusBar.setNotice(formatTuiErrorNotice(error, this.o.locale ?? 'en'), 'error')
    this.signals.event('error')
    this.renderer.requestRender()
  }

  /** The one way to run a line of user input, for the editor and for the prompt `agnes "…"` starts
   * with alike: routes `/…` to `command()`, everything else to `submit()`, and reports either one's
   * failure on the status bar instead of throwing, so a recoverable turn error keeps the session. */
  async runInput(text: string, raw = text, chips = false): Promise<void> {
    if (this.closedNotice !== undefined) {
      // Decide and act on the same normalized text: a padded ' /quit' must not reach submit().
      if (text.trim() !== '/quit' && text.trim() !== '/exit') return void this.refuseClosed()
      text = '/quit'
    }
    const task = isBangLine(raw)
      ? this.bang.run(raw, chips)
      : isSlashCommandLine(text)
        ? this.command(text)
        : this.submit(text)
    await task.catch((error: unknown) => this.showError(error))
  }

  /** Dispatches one `/…` line typed into the editor. Can reject -- `runSlash` makes real RPC calls
   * underneath /cost, /rewind, /preset, /model, /resume, /sessions and /new -- so callers reach it
   * through `runInput()` above, which owns the `.catch((error) => this.showError(error))`. */
  async command(text: string): Promise<void> {
    if (this.stopped) return
    const owner = this.o.session
    const [cmd = '', ...args] = text.trim().split(/\s+/)
    const ticket = opensSwitch(cmd, args) ? beginSwitch(this) : undefined
    const r = await settleSwitch(this, ticket, runSlash(this, text))
    if (r.content) {
      if (this.stopped || owner !== this.o.session) throw new Error('ATTACHMENT_NOT_AUTHORIZED')
      await this.submitBlocks(r.content, undefined, r.steer)
    }
    if (owner !== this.o.session && !r.switchSession) return // the session it was for is gone
    if (r.prompt) await this.submit(r.prompt)
    // Switch first: local output anchors to the session shown, and the next session's timeline drops older anchors.
    if (r.switchSession) await applySwitch(this, r.switchSession, ticket)
    applyCommandResult(
      {
        statusBar: this.statusBar,
        usagePanel: this.usagePanel,
        modelPicker: this.modelPicker,
        sessionPicker: this.sessionPicker,
        providerSetup: this.providerSetup,
        editor: this.editor,
        busyInput: this.busyInput,
        appendLocal: (view) => this.timeline.appendLocal(this.session.id, view),
        localCommandView: this.localCommandView,
      },
      text,
      r,
    )
    if (r.quit) this.onQuit()
    if (!this.stopped) this.renderer.requestRender()
  }

  async submit(text: string): Promise<void> {
    if (this.stopped) throw new Error('TUI stopped')
    if (!text.trim()) return
    const skillCommand = /^\/skill\s+invoke\s+\S+/.test(text)
    if (isSlashCommandLine(text) && !skillCommand) throw new Error('Command unavailable')
    this.statusBar.setNotice(undefined)
    if (this.surfaces.pending && !skillCommand) return this.surfaces.answer(text)
    const kept = this.busyInput.takeKept(text)
    await this.submitBlocks([...attachmentsFrom(text, this.cwd, this.o.remote), ...kept], text)
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
    this.clock.stop()
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
