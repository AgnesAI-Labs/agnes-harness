#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { bootDefault as BootDefault } from './boot/default.js'
import type { LocalBootDeps } from './boot/local.js'
import { installSignalLadder } from './boot/signals.js'
import { dispatchProfileCli, isProfileCommand, prepareCommandArgs, resolveMode } from './command-entry.js'
import { commandHelp } from './command-help.js'
import type { BranchContext } from './commands/bin-branches.js'
import { BootError, ExitCode, SIGNAL_EXIT_CODES, type SignalName, UsageError } from './errors.js'
import { timingMark } from './timing.js'
import type { Booted } from './types.js'
import { versionLine } from './version-line.js'

// Everything heavier than argument parsing and help text is imported where its command runs, so
// `agh --help` and a usage error never evaluate the Host, Daemon, SDK or protocol schemas.

/** The branches that live outside this file, loaded on first use. */
const branches = () => import('./commands/bin-branches.js')
const bootDefault: typeof BootDefault = async (...args) =>
  (await import('./boot/default.js')).bootDefault(...args)

export type MainIO = {
  env: NodeJS.ProcessEnv
  stdin: NodeJS.ReadableStream & { isTTY?: boolean }
  stdout: NodeJS.WritableStream & { isTTY?: boolean }
  stderr: NodeJS.WritableStream & { isTTY?: boolean }
  cwd: string
  agnesVersion: string
  /** Where the ladder sends the process. Injected so a test can watch it instead of dying. */
  exit?: (code: number) => void
  /** What the ladder listens on. Injected for the same reason: a test signals this, not the process. */
  signals?: NodeJS.EventEmitter
}

/** How long shutdown gets after a first signal before the process leaves anyway. */
const GRACE_MS = 5_000
/** And how long, after that, anything still queued on a pipe gets to reach it. */
const FLUSH_MS = 100

/**
 * Where the signal ladder sends the process.
 *
 * Not `process.exit` on the spot: that discards writes still queued on a pipe, and the two lines a
 * signalled run writes last -- the answer and the reason word beside its exit code -- are queued
 * immediately before this runs. Every signalled `agh -p` lost them, which is the whole of what the
 * reason word was added for.
 *
 * So the code is set, which is what a natural exit reports, and the hard exit is left to a timer
 * that cannot itself hold the process open. If nothing else is holding the loop either, the process
 * ends first and flushes on the way out; if something is, the timer fires and takes it down anyway,
 * which is the case this rung exists for.
 */
function hardExit(code: number): void {
  process.exitCode = code
  setTimeout(() => process.exit(code), FLUSH_MS).unref()
}

/**
 * `--ephemeral` promises the home goes with the run, but only main's finally removed it, and neither a
 * default signal termination nor process.exit -- the ladder's hard exits -- runs that finally. The exit
 * hook removes the home on any exit that runs JavaScript. Whenever the ladder is not installed (during
 * boot, and while the backend closes after a run) a signal leaves through process.exit instead of the
 * default termination, so the hook still runs. The default termination acts the instant a signal is
 * delivered, so the handlers exist before the home does and outlive its removal.
 */
function ephemeralHome(
  io: MainIO,
  ladderInstalled: () => boolean,
  makeEphemeralHome: () => { home: string; dispose(): void },
): { home: string; release(): void } {
  const signals = io.signals ?? process
  const exit = io.exit ?? ((code: number) => process.exit(code))
  const handlers = (Object.keys(SIGNAL_EXIT_CODES) as SignalName[]).map((sig) => {
    const handler = (): void => {
      if (!ladderInstalled()) exit(SIGNAL_EXIT_CODES[sig])
    }
    signals.on(sig, handler)
    return [sig, handler] as const
  })
  const eph = makeEphemeralHome()
  process.once('exit', eph.dispose)
  return {
    home: eph.home,
    release: () => {
      eph.dispose()
      process.off('exit', eph.dispose)
      for (const [sig, handler] of handlers) signals.off(sig, handler)
    },
  }
}

/**
 * The testable core of the executable. It returns an exit code rather than calling `process.exit`,
 * so every path through the grammar, the boot and the modes can be driven from a test with the
 * process it runs in surviving.
 *
 * `boot` is how a caller supplies the pieces host does not yet build for itself -- today that is the
 * package loader. It is not a general escape hatch: nothing else about the run is injectable here.
 */
export async function main(argv: string[], io: MainIO, boot: Partial<LocalBootDeps> = {}): Promise<number> {
  // Hidden callback for shell completion scripts. It runs before any home, profile or daemon work so
  // that a TAB never pays for (or causes) a startup.
  if (argv[0] === '__complete') {
    if (argv[1] === 'sessions') {
      const { completeSessions, daemonSessionReader } = await import('./commands/complete.js')
      // The 300 ms deadline bounds the daemon exchange; loading its modules comes first and is not counted.
      const read = await daemonSessionReader(io.env, io.cwd).catch(() => async () => [])
      const lines = await completeSessions(argv[2] ?? '', () => read(250))
      if (lines.length > 0) io.stdout.write(`${lines.join('\n')}\n`)
    }
    return ExitCode.OK
  }
  let p: ReturnType<typeof prepareCommandArgs>
  try {
    p = prepareCommandArgs(argv, io.cwd)
  } catch (e) {
    io.stderr.write(`${(e as Error).message}; run agh --help for usage\n`)
    return ExitCode.USAGE
  }
  if (p.version) {
    io.stdout.write(versionLine(io.agnesVersion))
    return ExitCode.OK
  }
  if (p.help) {
    const help =
      p.command === 'api'
        ? (await import('./commands/api.js')).apiHelp()
        : commandHelp(p.command, io.env.AGNES_LOCALE)
    io.stdout.write(`${help}\n`)
    return ExitCode.OK
  }

  if (p.safeMode || p.ignoreRules)
    // Said every time and on stderr: a flag that sounds like a guarantee must not hide what this build cannot skip.
    io.stderr.write(
      p.safeMode
        ? 'agh: --safe-mode skips custom slash commands and non-built-in plugins; instruction files, hooks and MCP servers are still loaded by this build\n'
        : 'agh: --ignore-rules skips custom slash commands; instruction files (AGENTS.md, CLAUDE.md) are still loaded by this build\n',
    )
  if (p.command === 'completion')
    return (await import('./commands/completion.js')).completionCommand(p.positional, io)

  if (p.command === 'plugin') {
    try {
      const { runPluginTests } = await import('./commands/plugin-test.js')
      return await runPluginTests(p.rest, io)
    } catch (error) {
      io.stderr.write(`${error instanceof Error ? error.message : 'Plugin tests failed'}\n`)
      return error instanceof UsageError ? ExitCode.USAGE : ExitCode.ERROR
    }
  }

  const { makeEphemeralHome, resolveHome } = await import('./boot/inputs.js')
  let ladderInstalled = false
  const eph = p.ephemeral ? ephemeralHome(io, () => ladderInstalled, makeEphemeralHome) : undefined
  const home = eph?.home ?? resolveHome(io.env)
  const { recoveryCommand } = await import('./commands/app.js')
  const recovery = await recoveryCommand(p, io, home)
  if (recovery !== undefined) return recovery
  const production = Object.keys(boot).length === 0
  let diagnosticHome = home
  if (production && p.command !== 'doctor') {
    const { initializeHomeLocked } = await import('@agnes/host')
    const { startupFailure } = await import('./commands/first-run-locales.js')
    try {
      let profile = p.profile ?? 'local-dev'
      if (p.command === 'serve' || p.command === 'web' || p.command === 'start') {
        const { parseWebCommand } = await import('../launch/web-command.js')
        const web = parseWebCommand(p.rest, io.env)
        diagnosticHome = web.home ?? home
        profile = web.profile ?? profile
      }
      // Publish the layout before the diagnostic journal becomes the first home writer.
      await initializeHomeLocked(diagnosticHome, profile)
    } catch (error) {
      const message = startupFailure(error, io.env)
      if (!message) throw error
      io.stderr.write(`${message}\n`)
      return ExitCode.ERROR
    }
  }
  const stopDiagnostics =
    production && p.command !== 'doctor'
      ? (await import('@agnes/observability')).installDiagnosticJournal(diagnosticHome)
      : undefined
  // Progress goes to a terminal or nowhere. A redirected stderr belongs to whatever the operator
  // pointed it at, and filling it with spinner text is how a log becomes unreadable.
  const log = (s: string): void => {
    if (io.stderr.isTTY) io.stderr.write(`${s}\n`)
  }
  const deps: LocalBootDeps = {
    env: io.env,
    home,
    cwd: io.cwd,
    agnesVersion: io.agnesVersion,
    log,
    ...boot,
  }
  const branchContext: BranchContext = { io, deps, home, useEmbedded: Object.keys(boot).length > 0 }
  try {
    if (isProfileCommand(p.command)) return await dispatchProfileCli(p, io, deps, !production)
    if (p.command === 'run') {
      const { runCommand } = await import('./commands/run.js')
      const { bootHeadless } = await import('./boot/headless.js')
      return await runCommand(p.rest, {
        cwd: io.cwd,
        stdin: io.stdin,
        stdout: io.stdout,
        ...(io.signals ? { signals: io.signals } : {}),
        ...(io.exit ? { exit: io.exit } : {}),
        boot: (input) => bootHeadless(input, deps),
      })
    }
    if ((p.command === 'acp' || p.mode === 'acp') && Object.keys(boot).length === 0) {
      if (p.standalone || p.ephemeral)
        throw new UsageError('ACP uses the shared App Server; omit standalone/ephemeral')
      if (!p.connect) {
        const { runAppServer } = await import('./commands/app-server.js')
        return await runAppServer(
          [
            '--stdio',
            '--home',
            deps.home,
            '--cwd',
            p.cwd ?? io.cwd,
            ...(p.profile ? ['--profile', p.profile] : []),
          ],
          io,
        )
      }
    }
    if (p.command === 'app-server') {
      const { runAppServer } = await import('./commands/app-server.js')
      return await runAppServer(p.rest, io)
    }
    if (p.command === 'serve' || p.command === 'web' || p.command === 'start') {
      const { runWebCommand } = await import('../launch/web-command.js')
      const { startupFailure } = await import('./commands/first-run-locales.js')
      try {
        await runWebCommand(p.rest, {
          env: io.env,
          cwd: io.cwd,
          write: (text) => io.stdout.write(text),
          ...(io.signals ? { signals: io.signals } : {}),
        })
      } catch (error) {
        const message = startupFailure(error, io.env)
        if (!message) throw error
        io.stderr.write(message + '\n')
        return ExitCode.ERROR
      }
      return ExitCode.OK
    }
    if (p.command === 'daemon') return await (await branches()).runDaemonBranch(p, branchContext)
    if (p.command === 'consent') {
      const { consentCommand } = await import('./commands/consent.js')
      io.stdout.write(`${consentCommand(p, deps)}\n`)
      return ExitCode.OK
    }
    if (p.command === 'stats') {
      const { statsDeviation } = await import('./commands/stats.js')
      io.stdout.write(`${await statsDeviation(p, deps)}\n`)
      return ExitCode.OK
    }
    if (p.command === 'config') return await (await branches()).runConfigBranch(p, branchContext)
    if (p.command === 'doctor') return await (await branches()).runDoctorBranch(p, branchContext)
    if (p.command === 'computer-use') return await (await branches()).runComputerUseBranch(p, branchContext)
    if (p.command === 'conformance') {
      const { conformanceGateway } = await import('./commands/conformance.js')
      const result = await conformanceGateway(p, deps)
      io.stdout.write(`${result.text}\n`)
      return result.exitCode
    }
    if (p.command === 'export') {
      const { exportSession, validateExportRequest } = await import('./commands/export.js')
      if (p.connect !== undefined) throw new UsageError('export only runs in one-shot form (no --connect)')
      // Refuse a currently unsupported privacy/format request before profile resolution or host
      // startup. A typo in an export flag must not execute packages merely to discover it later.
      validateExportRequest(p)
      const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
      try {
        return await exportSession(p, { cwd: io.cwd, io }, booted.client)
      } finally {
        await booted.close().catch(() => undefined)
      }
    }
    if (p.command === 'import') {
      const { importFile } = await import('./commands/import.js')
      if (p.connect !== undefined || io.env.AGNES_CONNECT !== undefined)
        throw new UsageError('import only runs in one-shot form (no --connect)')
      const { bootLocal } = await import('./boot/local.js')
      const booted = await bootLocal(p, deps)
      try {
        if (booted.host === undefined) throw new BootError('local import requires a Host')
        if (booted.sessionAdmission === undefined)
          throw new BootError('local import requires session admission')
        return await importFile(p, {
          env: io.env,
          cwd: p.cwd ?? io.cwd,
          host: booted.host,
          admission: booted.sessionAdmission,
          io: { stdout: io.stdout, stderr: io.stderr },
        })
      } finally {
        await booted.close().catch(() => undefined)
      }
    }
    if (p.command === 'diagnostics') {
      if (p.positional[0] !== 'export' || !p.out)
        throw new UsageError('usage: agh diagnostics export [--session <id>] --out <file>')
      const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
      try {
        const { diagnosticsCommand } = await import('./commands/diagnostics.js')
        await diagnosticsCommand(p, booted.client, io.cwd)
        return ExitCode.OK
      } finally {
        await booted.close().catch(() => undefined)
      }
    }
    // approvals, schedules, triggers, settings, credentials, agents, queue and api share sessions' boot and entry point.
    if (
      /^(sessions|approvals|schedules|triggers|settings|credentials|agents|queue|api)$/.test(p.command ?? '')
    ) {
      const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
      try {
        const { sessionsCommand } = await import('./commands/sessions.js')
        return await sessionsCommand({ ...p, profile: booted.profileName }, booted.client, {
          stdout: io.stdout,
          stderr: io.stderr,
        })
      } finally {
        await booted.close().catch(() => undefined)
      }
    }
    if (p.command === 'plugins' && p.positional[0] === 'pack')
      return await (await branches()).runPluginsPackBranch(p, branchContext)
    if (
      (p.command === 'plugins' &&
        !/^(reload|publication-status|provenance|candidates|config|tree|generations)$/.test(
          p.positional[0] ?? '',
        )) ||
      p.command === 'package' ||
      p.command === 'install'
    ) {
      const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
      try {
        const { runPackageCommand } = await import('./commands/package.js')
        // The daemon scope serves only the profile it was booted for, which AGNES_PROFILE can choose.
        await runPackageCommand({ ...p, profile: booted.profileName }, booted.client, {
          write: (text) => io.stdout.write(text),
          confirm: (preview, action) =>
            confirmPackageInstall(
              io,
              preview.id,
              preview.version,
              preview.integrity,
              p.command === 'plugins' && (action === undefined || action === 'install')
                ? 'install, trust and enable'
                : action,
            ),
          confirmEnable: (item, action) =>
            confirmPackageInstall(io, item.id, item.version, item.integrity, action ?? 'enable'),
        })
        return ExitCode.OK
      } finally {
        await booted.close().catch(() => undefined)
      }
    }
    if (p.command === 'plugins' || p.command === 'dev' || p.command === 'app') {
      const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
      try {
        const { runPluginDevelopmentCommand: run } = await import('./commands/plugins.js')
        const w = (t: string) => io.stdout.write(t)
        return (await run({ ...p, profile: booted.profileName }, booted.client, w)) ?? ExitCode.OK
      } finally {
        await booted.close().catch(() => undefined)
      }
    }
    if (p.command === 'packages') return await (await branches()).runPackagesBranch(p, branchContext)
    if (
      (p.command === 'resources' || p.command === 'skills' || p.command === 'mcp') &&
      !(p.command === 'mcp' && p.rest[0] === 'serve')
    ) {
      const { confirmResourceOperation, runResourceCliCommand } = await import('@agnes/resource-control-cli')
      await runResourceCliCommand({
        kind: p.command,
        rest: p.rest,
        workspacePath: p.cwd ?? io.cwd,
        boot: (profile) =>
          bootDefault({ ...p, ...(profile ? { profile } : {}) }, deps, {
            useEmbedded: Object.keys(boot).length > 0,
          }),
        write: (text) => io.stdout.write(text),
        confirm: (summary) => confirmResourceOperation(io, summary),
        unavailable: () => {
          throw new UsageError('resource control is not supported by this Daemon')
        },
      })
      return ExitCode.OK
    }
    if (p.command === 'tools') {
      const { toolsCommand } = await import('./commands/tools.js')
      const booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
      try {
        io.stdout.write((await toolsCommand(booted, p, p.cwd ?? deps.cwd)) + '\n')
        return ExitCode.OK
      } finally {
        await booted.close().catch(() => undefined)
      }
    }
    if (p.command === 'profile') return await (await branches()).runProfileBranch(p, branchContext)
    // Commands still require their own runners. ACP is a mode as well as a command alias.
    if (p.command && p.command !== 'resume' && p.command !== 'acp')
      throw new UsageError(`agh ${p.command} is not available in this build`)
    const mode = resolveMode(p, { stdin: io.stdin.isTTY === true, stdout: io.stdout.isTTY === true })
    if (mode !== 'print' && mode !== 'tui' && mode !== 'acp')
      throw new UsageError(`agh ${mode} is not available in this build; use -p`)
    if (p.outputSchema !== undefined && mode !== 'print')
      throw new UsageError('--output-schema is supported only with -p')
    // Resolve the selected mode before installing its signal ladder, so loading cannot race cancel.
    const tuiMode = mode === 'tui' ? await import('./modes/tui.js') : undefined
    const acpMode = mode === 'acp' ? await import('./modes/acp.js') : undefined
    const printMode = mode === 'print' ? await import('./modes/print.js') : undefined
    const { resolveLocale } = await import('./tui/locale.js')
    // The composer goes up before the daemon is reached; it keeps what is typed while that happens.
    // The opening composer draws on the alternate screen, which --no-alt-screen never enters.
    const openingMode = p.noAltScreen ? undefined : tuiMode
    let opening = openingMode
      ? new openingMode.TuiOpening(p, {
          stdin: io.stdin,
          stdout: io.stdout,
          stderr: io.stderr,
          env: io.env,
          cwd: p.cwd ?? io.cwd,
          signals: io.signals ?? process,
          giveUp: (code) => (io.exit ?? hardExit)(code),
          composerSelectionPath: join(resolveHome(io.env), 'composer-selection.json'),
        })
      : undefined
    // Remembering a pane's session only makes sense for this machine's own home: not over --connect,
    // and not for --ephemeral, whose home is gone when the run ends.
    const breadcrumb =
      p.connect === undefined && !p.ephemeral
        ? (await import('./terminal-breadcrumb.js')).terminalBreadcrumb(resolveHome(io.env), io.env)
        : undefined
    let booted: Booted
    try {
      booted = await bootDefault(p, deps, { useEmbedded: Object.keys(boot).length > 0 })
    } catch (error) {
      opening?.abandon()
      throw error
    }
    let stashed: string | undefined
    let leave!: (code: number) => void
    const exited = new Promise<number>((resolve) => {
      leave = resolve
    })
    try {
      if (opening?.gaveUp !== undefined) return opening.gaveUp
      // The config wizard is deliberately after boot: it uses the same authenticated SDK endpoint as
      // Web and never opens Host credential stores itself. A daemon without the optional config
      // capability remains usable for ordinary sessions; an actual config failure is surfaced.
      if (
        mode === 'tui' &&
        io.stdin.isTTY === true &&
        io.stdout.isTTY === true &&
        // An injected boot is the embedding/test contract: its endpoint may not expose Host config,
        // and consuming the stream here would steal bytes from the embedder's own TUI.
        Object.keys(boot).length === 0
      ) {
        const snapshot = await (await branches()).readConfigurationSnapshot(booted)
        if (snapshot && !snapshot.configured) {
          // Rendered with the TUI's own selectors. `agh config` keeps the line-oriented wizard so
          // a piped or non-TTY caller still has a scriptable path to the same config endpoint.
          const { NodeTerminal, runOnboardingTui } = await import('./onboarding/tui.js')
          // The wizard needs the normal screen; the draft waits and is put back afterwards.
          stashed = opening?.stash()
          opening = undefined
          const term = new NodeTerminal(io.stdin, io.stdout, io.env)
          const saved = await runOnboardingTui(booted.client, snapshot, term, resolveLocale(io.env))
          // Cancellation leaves setup; Demo continues through the already selected local backend.
          if (saved === undefined || (saved !== 'demo' && saved.effect === 'restart-required'))
            return ExitCode.OK
        }
      }
      let cancel: () => Promise<void> = async () => undefined
      // Remembered rather than acted on here: the turn the signal cancels ends as `aborted`, and which
      // code that becomes -- 130, 143 or 129 -- is only knowable from the signal that caused it. The
      // ladder exits with the same number by its own route, so the two cannot disagree.
      let signal: SignalName | undefined
      // The ladder closes only once the run it cancelled has finished. Closing straight away tears the
      // transport out from under the request that is still in flight, so the turn comes back as a
      // transport failure instead of as `aborted` and the exit code is 1 rather than the signal's. The
      // grace timer is what bounds the wait if the run never ends at all.
      let settled: Promise<unknown> = Promise.resolve()
      // Resolved before the ladder is armed. Awaiting it inside the `run` expression below would
      // hold `settled` on its initial resolved promise for the whole module load, so a signal
      // arriving in that window would close the backend out from under a run yet to start --
      // the turn then fails as a dropped transport and reports that instead of the signal.
      const resourceController =
        mode === 'tui'
          ? (await import('./commands/resources.js')).createResourceController(booted.client)
          : undefined
      ladderInstalled = true
      const off = installSignalLadder(
        {
          cancel: () => cancel(),
          close: async () => {
            await settled.catch(() => undefined)
            await booted.close()
          },
        },
        {
          graceMs: GRACE_MS,
          exit: (code) => {
            // A forced exit must also settle the embedding contract and release its temporary home.
            leave(code)
            ;(io.exit ?? hardExit)(code)
          },
          log,
          onSignal: (s) => {
            signal = s
          },
          ...(io.signals ? { proc: io.signals } : {}),
        },
      )
      try {
        const run = acpMode
          ? acpMode.runAcp(booted, p, {
              stdin: io.stdin,
              stdout: io.stdout,
              stderr: io.stderr,
              registerCancel: (fn) => {
                cancel = fn
              },
              signal: () => signal,
            })
          : tuiMode
            ? tuiMode.runTui(booted, p, {
                ...(opening ? { opening } : {}),
                ...(stashed ? { draft: stashed } : {}),
                env: io.env,
                stdin: io.stdin,
                stdout: io.stdout,
                cwd: p.cwd ?? io.cwd,
                registerCancel: (fn) => {
                  cancel = fn
                },
                signal: () => signal,
                ...(resourceController ? { resourceController } : {}),
                composerSelectionPath: join(resolveHome(io.env), 'composer-selection.json'),
                historyPath: join(resolveHome(io.env), 'tui-history.jsonl'),
                commandsDir: join(home, 'commands'),
                ...(breadcrumb ? { breadcrumb } : {}),
                editorTmpDir: join(resolveHome(io.env), 'tmp'),
                agnesVersion: io.agnesVersion,
              })
            : printMode!.runPrint(booted, p, {
                ...(breadcrumb ? { breadcrumb } : {}),
                locale: resolveLocale(io.env),
                stdout: io.stdout,
                stderr: io.stderr,
                stdin: io.stdin,
                cwd: p.cwd ?? io.cwd,
                registerCancel: (fn) => {
                  cancel = fn
                },
                signal: () => signal,
              })
        // Assigned before the first await, so a signal arriving in the same tick already has something
        // to wait for rather than closing on an empty promise.
        settled = run
        return await Promise.race([run, exited])
      } finally {
        off()
        ladderInstalled = false
      }
    } finally {
      opening?.abandon()
      await Promise.race([booted.close().catch(() => undefined), exited])
    }
  } catch (e) {
    return (await import('./command-failure.js')).reportCommandFailure(e, p.command, io)
  } finally {
    stopDiagnostics?.()
    eph?.release()
  }
}

/** A non-interactive command never guesses consent: it previews then exits without an install. */
function confirmPackageInstall(
  io: MainIO,
  id: string,
  version: string,
  integrity: string,
  action: 'install' | 'trust' | 'enable' | 'install, trust and enable' = 'install',
): Promise<boolean> {
  if (io.stdin.isTTY !== true || io.stdout.isTTY !== true)
    return Promise.reject(
      new UsageError('confirmation requires a TTY; review the preview and rerun with --yes'),
    )
  return new Promise((resolve) => {
    const prompt = createInterface({ input: io.stdin, output: io.stdout, terminal: true })
    // EOF and Ctrl-C close the interface without ever calling the question callback. Settling as
    // "not confirmed" keeps INV-33: an unanswered prompt is never read as consent. Resolve before
    // close() below, which emits 'close' synchronously and would otherwise bury the answer.
    prompt.once('close', () => resolve(false))
    prompt.question(`${action} ${id}@${version} (${integrity})? [y/N] `, (answer) => {
      resolve(/^y(?:es)?$/i.test(answer.trim()))
      prompt.close()
    })
  })
}

/** The version this build reports. Read from the manifest so there is one place it is written. */
export function agnesVersion(): string {
  if (typeof AGNES_VERSION !== 'undefined') return AGNES_VERSION
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  return String((JSON.parse(raw) as { version?: unknown }).version ?? '0.0.0')
}

/** Replaced with the package version by build:sea; absent in the source/test runtime. */
declare const AGNES_VERSION: string | undefined

export async function runExecutable(): Promise<void> {
  const code = await main(process.argv.slice(2), {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
    agnesVersion: agnesVersion(),
  })
  process.exitCode = code
  // main has completed all owned cleanup. Flush redirected output before ending the executable;
  // unrelated library timers must not keep a successful one-shot command alive.
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) => new Promise<void>((resolve) => stream.write('', () => resolve())),
    ),
  )
  process.exit(code)
}

const entry = process.argv[1]
function isMainModule(moduleUrl: string): boolean {
  if (entry === undefined) return false
  try {
    // `process.argv[1]` can be a symlink or an alias such as macOS `/var` versus `/private/var`.
    // Compare canonical filesystem paths so relocated/package invocations actually dispatch.
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return moduleUrl === pathToFileURL(entry).href
  }
}

if (!process.getBuiltinModule('node:sea').isSea() && isMainModule(import.meta.url)) {
  timingMark('main-loaded')
  // The executable flushes both output streams after main completes its owned cleanup.
  void runExecutable()
}
