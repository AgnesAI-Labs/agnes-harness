import { dirname, join } from 'node:path'
import { ExitCode, SIGNAL_EXIT_CODES, type SignalName } from '../errors.js'
import { inheritFreshSession, TuiApp } from '../tui/app.js'
import { resolveLocale } from '../tui/locale.js'
import type { TuiResourceController } from '../tui/resource-controller.js'
import { freshTuiSessionKey } from '../tui/session-key.js'
import { type InputStream, NodeTerminal, type OutputStream } from '../tui/terminal.js'
import type { Booted, ParsedArgs } from '../types.js'
import { refuseWhatCannotBeHonoured, sessionToOpen } from './print.js'

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
  },
): Promise<number> {
  refuseWhatCannotBeHonoured(p)
  // Match Prime's process lifecycle: own the alternate screen *before* any session, branding, or
  // daemon await. This leaves the previous invocation in normal-screen scrollback on exit, while
  // every new invocation starts on an empty alternate screen even when opening is slow.
  const term = new NodeTerminal(io.stdin, io.stdout, io.env)
  term.write('\x1b[?1049h\x1b[H\x1b[2J')
  let app: TuiApp | undefined
  let left = false
  const leaveScreen = (): void => {
    if (left) return
    left = true
    term.write('\x1b[?1049l\x1b[?25h')
  }
  // Until a TuiApp exists there is nothing to stop, and the ladder's hard exits skip the finally below:
  // a signal while the session opens gives the shell back at once.
  io.registerCancel(async () => leaveScreen())
  try {
    const resumeId = await sessionToOpen(booted, p, io.cwd)
    if (resumeId === undefined) await booted.client.workspace.add(io.cwd)
    const session =
      resumeId !== undefined
        ? await booted.client.session.load(resumeId, { cwd: io.cwd })
        : await booted.client.session.new({
            cwd: io.cwd,
            sessionKey: freshTuiSessionKey(booted.profileName),
            ...(p.preset ? { preset: p.preset } : {}),
          })
    // A fresh session takes the last model and full-permission choice, unless -m names a model.
    // Resume keeps the historical session's own model and does not read the preference file.
    const inherited =
      resumeId === undefined
        ? await inheritFreshSession(session, io.composerSelectionPath, p.model)
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
    const tui = new TuiApp({
      session,
      term,
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
      ...(inherited?.notice ? { initialNotice: inherited.notice } : {}),
      ...(io.composerSelectionPath ? { composerSelectionPath: io.composerSelectionPath } : {}),
      ...(io.composerSelectionPath
        ? { themePreferencePath: join(dirname(io.composerSelectionPath), 'tui-theme.json') }
        : {}),
      controlClient: booted.client,
      ...(io.resourceController ? { resourceController: io.resourceController } : {}),
      screenAlreadyEntered: true,
      cwd: io.cwd,
    })
    app = tui
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
    await tui.start()
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
      await session.detach().catch(() => undefined)
    } else {
      // Opening can fail before a TuiApp exists (e.g. a refused or unreachable session). Do not
      // strand the user's terminal in its alternate screen in that path.
      leaveScreen()
    }
  }
}
