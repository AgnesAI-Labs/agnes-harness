import { dirname, join } from 'node:path'
import { ExitCode, SIGNAL_EXIT_CODES, type SignalName } from '../errors.js'
import { timingMark } from '../timing.js'
import {
  backgroundSessions,
  type ExportRequest,
  exitSummaryLines,
  HeadsUpWatcher,
  inheritFreshSession,
  installKeybindings,
  mouseFromEnv,
  outcomeLine,
  startedNotices,
  type TimelineFacts,
  TuiApp,
  timelineFacts,
  type WorktreeInfo,
  waitingIn,
} from '../tui/app.js'
import { escapeControl } from '../tui/component.js'
import { resolveLocale } from '../tui/locale.js'
import { tt } from '../tui/locale-extended.js'
import type { TuiResourceController } from '../tui/resource-controller.js'
import { freshTuiSessionKey } from '../tui/session-key.js'
import { type InputStream, NodeTerminal, type OutputStream } from '../tui/terminal.js'
import type { Booted, ParsedArgs } from '../types.js'
import { resolveAppendSystemPrompt, verifyAppendApplied } from './append-system-prompt.js'
import { type Breadcrumb, refuseWhatCannotBeHonoured, sessionToOpen } from './print.js'
import { applyToolFilter } from './tool-filter.js'
import { markFirstFrame, type TuiOpening } from './tui-opening.js'

export { TuiOpening } from './tui-opening.js'

export async function runTui(
  booted: Booted,
  p: ParsedArgs,
  io: {
    stdin: InputStream
    stdout: OutputStream
    env: NodeJS.ProcessEnv
    cwd: string
    registerCancel(cancel: () => Promise<void>): void
    signal(): SignalName | undefined
    resourceController?: TuiResourceController
    composerSelectionPath?: string
    historyPath?: string
    /** Personal custom slash commands (`<AGH_HOME>/commands`). */
    commandsDir?: string
    /** This terminal pane's memory of its last session; absent over --connect and without a pane id. */
    breadcrumb?: Breadcrumb
    /** `/import`; absent unless this is the shared local daemon connection. */
    importSession?: (file: string, from?: string) => Promise<{ key: string }>
    /** `/export`; present under the same condition as `importSession`. */
    exportSession?: (request: ExportRequest) => Promise<void>
    /** Private scratch directory (`<AGH_HOME>/tmp`) for the Ctrl-G draft file. */
    editorTmpDir?: string
    /** The CLI's own version, shown on the welcome. */
    agnesVersion?: string
    /** The composer already drawn while the daemon connected; its screen and draft carry over. */
    opening?: TuiOpening
    /** The git worktree `--worktree` made for this run; `io.cwd` is already inside it. Removed on exit if clean. */
    worktree?: WorktreeInfo
    /** A draft taken off the screen for a prompt that needed it (first-run setup). */
    draft?: string
  },
): Promise<number> {
  refuseWhatCannotBeHonoured(p)
  const append = await resolveAppendSystemPrompt(p, io.cwd)
  // Match Prime's process lifecycle: own the alternate screen *before* any session, branding, or
  // daemon await. This leaves the previous invocation in normal-screen scrollback on exit, while
  // every new invocation starts on an empty alternate screen even when opening is slow.
  const { opening } = io
  const term = opening?.term ?? new NodeTerminal(io.stdin, io.stdout, io.env)
  // --no-alt-screen keeps the shell page: nothing is claimed up front and nothing needs giving back.
  if (!opening && !p.noAltScreen) term.write('\x1b[?1049h\x1b[H\x1b[2J')
  let app: TuiApp | undefined
  let facts: TimelineFacts = { approvals: 0 }
  let earlier = false
  const headsUp = new HeadsUpWatcher(() => app)
  const startedAt = Date.now()
  let left = false
  const leaveScreen = (): void => {
    if (left) return
    left = true
    if (opening) opening.abandon()
    else term.write(p.noAltScreen ? '\x1b[?25h' : '\x1b[?1049l\x1b[?25h')
  }
  // Until a TuiApp exists there is nothing to stop, and the ladder's hard exits skip the finally below:
  // a signal while the session opens gives the shell back at once.
  io.registerCancel(async () => leaveScreen())
  try {
    const resumeId = await sessionToOpen(booted, p, io.cwd, io.breadcrumb)
    if (resumeId === undefined) await booted.client.workspace.add(io.cwd)
    const extraDirs =
      resumeId === undefined && p.addDir
        ? await (await import('./add-dir.js')).addDirectoriesFor(booted.client, p, resolveLocale(io.env))
        : {}
    const session =
      resumeId !== undefined
        ? await booted.client.session.load(resumeId, { cwd: io.cwd })
        : await booted.client.session.new({
            cwd: io.cwd,
            ...extraDirs,
            sessionKey: freshTuiSessionKey(booted.profileName),
            ...(p.preset ? { preset: p.preset } : {}),
            ...(p.permission !== undefined || !p.agent ? { permission: p.permission ?? 'default' } : {}),
            ...(p.loop ? { loop: p.loop } : {}),
            ...(p.agent ? { agent: p.agent } : {}),
            ...(append === undefined ? {} : { systemPromptAppend: append }),
          })
    if (resumeId === undefined && append !== undefined) {
      try {
        await verifyAppendApplied(booted.client, session.id, append)
      } catch (error) {
        await session.detach().catch(() => undefined)
        throw error
      }
    }
    // Before the welcome, the model choice or any prompt: a tool the user took away is gone from the first turn.
    if (p.toolFilter) await applyToolFilter(session, p.toolFilter)
    // A fresh session takes the last model and full-permission choice, unless -m names a model.
    // Resume keeps the historical session's own model and does not read the preference file.
    const inherited =
      resumeId === undefined && !p.agent
        ? await inheritFreshSession(session, io.composerSelectionPath, p.model, resolveLocale(io.env))
        : undefined
    // Rendering is bounded by BrandingCache: a slow or unavailable control plane yields the shared
    // default after at most 1.5 s, while a profile-specific override can replace it when available.
    const branding = await booted.client.branding().forRender()
    // The cancel above already gave the shell back during one of these awaits; starting the TUI now
    // would draw over it.
    if (left) {
      await session.detach().catch(() => undefined)
      const signal = io.signal()
      return signal ? SIGNAL_EXIT_CODES[signal] : ExitCode.OK
    }
    // Read once: the opening composer already did when there was one, and the answer is remembered.
    const keyNotice = io.composerSelectionPath
      ? installKeybindings(join(dirname(io.composerSelectionPath), 'keybindings.json'), resolveLocale(io.env))
      : undefined
    const notice = [inherited?.notice, keyNotice].filter(Boolean).join(' · ')
    const tui = new TuiApp({
      session,
      term,
      remote: p.connect !== undefined,
      profile: booted.profileName,
      branding,
      locale: resolveLocale(io.env),
      // The effective preset name is not returned by `session/new` (only `sessionId` is), and
      // `Session` exposes no live readback of it either (only `setPreset()`, a mutator) -- so this
      // is the requested preset when one was passed on argv, and a placeholder otherwise. See this
      // task's report.
      preset: p.preset ?? '(default)',
      // The model the user pinned with -m, when they did; otherwise the banner leaves the field out
      // rather than guessing at the session default (Session exposes no live readback of it).
      ...(p.model ? { model: p.model.model } : inherited?.modelId ? { model: inherited.modelId } : {}),
      ...(notice ? { initialNotice: notice } : {}),
      ...(io.composerSelectionPath ? { composerSelectionPath: io.composerSelectionPath } : {}),
      ...(io.historyPath ? { historyPath: io.historyPath } : {}),
      ...(io.commandsDir ? { commandsDir: io.commandsDir } : {}),
      ...(p.ignoreRules || p.safeMode ? { noCustomCommands: true } : {}),
      ...(p.safeMode ? { safeMode: true } : {}),
      ...(io.importSession ? { importSession: io.importSession } : {}),
      ...(io.exportSession ? { exportSession: io.exportSession } : {}),
      mouse: mouseFromEnv(io.env),
      onTimeline: (timeline, hasEarlier) => {
        // Only a windowed tick says whether older history is out of view; the others keep the last answer.
        if (hasEarlier !== undefined) earlier = hasEarlier
        facts = timelineFacts(timeline, earlier)
        headsUp.onTimeline(timeline)
      },
      ...(io.breadcrumb
        ? { onSessionSwitch: (sessionId: string) => io.breadcrumb?.write(sessionId, io.cwd) }
        : {}),
      ...(io.editorTmpDir ? { externalEditor: { env: io.env, tmpDir: io.editorTmpDir } } : {}),
      ...(io.composerSelectionPath
        ? {
            themePreferencePath: join(dirname(io.composerSelectionPath), 'tui-theme.json'),
            notifyPreferencePath: join(dirname(io.composerSelectionPath), 'tui-notify.json'),
          }
        : {}),
      welcome: {
        motion: io.stdout.isTTY === true,
        ...(io.agnesVersion ? { version: io.agnesVersion } : {}),
      },
      controlClient: booted.client,
      ...(io.resourceController ? { resourceController: io.resourceController } : {}),
      screenAlreadyEntered: true,
      ...(p.noAltScreen ? { noAltScreen: true } : {}),
      cwd: io.cwd,
    })
    app = tui
    if (io.worktree) {
      tui.worktrees.adopt(session.id, io.worktree)
      await tui.worktrees.switched(session.id)
    }
    let quit!: () => void
    const finished = new Promise<void>((resolve) => {
      quit = resolve
    })
    tui.onQuit = quit
    io.registerCancel(async () => {
      try {
        await tui.cancel()
      } finally {
        quit()
      }
    })
    // The first stdout write after this point is the first frame; the composer takes input once
    // start() has returned. Both marks cost nothing without AGH_TIMING.
    if (!opening) markFirstFrame(io)
    // Released and started in one turn: keys typed meanwhile are in the draft, none are lost between.
    const draft = opening ? opening.release() : io.draft
    if (draft) tui.setDraft(draft)
    await tui.start()
    if (p.addDir?.length)
      tui.noteLocal(
        '--add-dir',
        tt('adddir.started', resolveLocale(io.env), {
          count: p.addDir.length,
          dirs: p.addDir.map(escapeControl).join(', '),
        }),
      )
    if (io.worktree)
      tui.noteLocal('--worktree', startedNotices(io.worktree, resolveLocale(io.env)).join('\n'))
    if (!opening) timingMark('composer-ready', io.env)
    timingMark('session-ready', io.env)
    if (io.signal()) quit()
    const initialPrompt = p.command === 'resume' ? p.positional.slice(1) : p.positional
    if (!io.signal() && initialPrompt.length > 0) await tui.runInput(initialPrompt.join(' '))
    await finished
    const signal = io.signal()
    return signal ? SIGNAL_EXIT_CODES[signal] : ExitCode.OK
  } finally {
    if (app) {
      const session = app.session
      await app.stop()
      // The shell page comes back exactly as it was; the one line left on it says how to return.
      const background = backgroundSessions(app)
      const prompted = app.prompted.has(session.id)
      if (io.stdout.isTTY === true && (prompted || background.length > 0)) {
        const locale = resolveLocale(io.env)
        // Input waiting in the daemon behind a turn; a daemon that cannot say leaves the item out.
        const queued = await Promise.race([
          session
            .controls()
            .then((state) => waitingIn(state.pending).length)
            .catch(() => 0),
          new Promise<number>((resolve) => setTimeout(resolve, 500, 0).unref()),
        ])
        const lines = exitSummaryLines(
          { ...facts, elapsedMs: Date.now() - startedAt, queued, background },
          locale,
        )
        io.stdout.write(`${lines.join('\n')}\n`)
        if (prompted) io.stdout.write(`${tt('resume.hint', locale, { id: escapeControl(session.id) })}\n`)
      }
      await session.detach().catch(() => undefined)
      // After the detach, so the daemon no longer holds the directory; clean ones go, the rest are named.
      const locale = resolveLocale(io.env)
      for (const outcome of await app.worktrees.finish()) io.stdout.write(`${outcomeLine(outcome, locale)}\n`)
    } else {
      // Opening can fail before a TuiApp exists (e.g. a refused or unreachable session). Do not
      // strand the user's terminal in its alternate screen in that path.
      leaveScreen()
    }
  }
}
