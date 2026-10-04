#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { loadDevEnvironment, saveDevEnvironment } from './dev-environment.mjs'
import {
  acquireCleanupLock,
  acquireLock,
  assertDaemonSelection,
  jsonOrMissing,
  readOwner,
  sameOwner,
} from './dev-lifecycle.mjs'
import { capture, inspectListener, listenerPids, stopWeb } from './dev-process.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HELP = `make dev [ARGS='--port 4189 --home /path --data-dir /path/data --cwd /workspace --profile local-dev']
Rebuild both backend and Web, then gracefully replace the selected AGH instance.
Defaults: port 4189; reuse the verified listener's scope, then this checkout's saved scope,
otherwise AGH_HOME (or ~/.agh), local-dev, and this checkout as workspace.
--node /path/to/node overrides the runtime Node (requires >=24.10).
--env-file /path loads environment for the new runtime; existing shell variables win.
The selected home's private dev.env is loaded automatically (shell variables win).
--save-env saves this shell's Jev settings to a new home/dev.env (0600; never overwrites).
--check reports the selected scope without building, saving settings or stopping services.
Ctrl+C stops this invocation's Web and backend. Re-run make dev to rebuild source changes.
Other port owners, scope conflicts and unverifiable process identities are refused.
`

export function parseOptions(args) {
  const options = {}
  const names = new Map([
    ['--port', 'port'],
    ['--home', 'home'],
    ['--data-dir', 'dataDir'],
    ['--cwd', 'cwd'],
    ['--profile', 'profile'],
    ['--node', 'node'],
    ['--env-file', 'envFile'],
  ])
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === '--help' || flag === '--check' || flag === '--save-env') {
      if (Object.hasOwn(options, flag.slice(2))) throw new Error(`Repeated option: ${flag}`)
      options[flag.slice(2)] = true
      continue
    }
    const key = names.get(flag)
    const value = args[++index]
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key))
      throw new Error(`Invalid or repeated option: ${flag}`)
    options[key] = value
  }
  options.port = Number(options.port ?? 4189)
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
    throw new Error('Invalid port')
  if (options.check && options['save-env']) throw new Error('--check cannot save environment')
  return options
}

export function selectSettings(options, env, saved, existing, repo = root) {
  const prior = existing ?? saved ?? {}
  const home = resolve(
    options.home ?? env.AGH_HOME ?? env.AGNES_HOME ?? prior.home ?? join(homedir(), '.agh'),
  )
  const explicitHome =
    options.home !== undefined || env.AGH_HOME !== undefined || env.AGNES_HOME !== undefined
  const settings = {
    port: options.port,
    home,
    profile: options.profile ?? env.AGNES_PROFILE ?? prior.profile ?? 'local-dev',
    dataDir: resolve(
      options.dataDir ?? (explicitHome ? join(home, 'data') : (prior.dataDir ?? join(home, 'data'))),
    ),
    cwd: resolve(options.cwd ?? prior.cwd ?? repo),
    node: options.node ?? env.AGH_DEV_NODE ?? prior.node ?? process.execPath,
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(settings.profile)) throw new Error('Invalid profile name')
  if (!isAbsolute(settings.node)) throw new Error('--node / AGH_DEV_NODE must be an absolute path')
  // Explicit selections must not turn a port collision into permission to stop another scope.
  if (existing && ['home', 'profile', 'dataDir', 'cwd'].some((key) => settings[key] !== existing[key]))
    throw new Error(
      `Port ${options.port} belongs to another AGH scope; select its exact paths or another port.`,
    )
  return settings
}

const scopeArgs = (settings) => [
  '--home',
  settings.home,
  '--profile',
  settings.profile,
  '--data-dir',
  settings.dataDir,
]

/** Build failure leaves the old service untouched; revalidate after the potentially long build. */
export async function replaceRuntime(settings, existing, ports) {
  const runtime = await ports.build(settings)
  const current = await ports.inspect(settings.port)
  if (
    (existing === null) !== (current === null) ||
    (existing &&
      (current.pid !== existing.pid ||
        current.start !== existing.start ||
        current.command !== existing.command))
  )
    throw new Error('Web listener changed during build; no service was stopped. Retry make dev.')
  // The existing CLI owns scope/discovery validation, PID generation and graceful daemon shutdown.
  await ports.stopDaemon(existing ? dirname(existing.entry) : runtime, settings)
  if (existing) await ports.stopWeb(existing)
  if ((await ports.listeners(settings.port)).length)
    throw new Error('Web port is still occupied; no new service was started.')
  return { runtime, child: await ports.start(runtime, settings) }
}

async function saveSettings(path, settings) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}

function launch(node, args, env) {
  const child = spawn(node, args, { cwd: root, env, stdio: 'inherit', detached: true })
  const exited = new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  return { child, exited }
}

async function runCommand(node, args, env, signal) {
  signal?.throwIfAborted()
  const command = launch(node, args, env)
  let timeout
  // These groups were created by this launcher, never discovered by process name or port.
  const abort = () => {
    if (command.child.exitCode === null && command.child.signalCode === null && command.child.pid)
      try {
        process.kill(-command.child.pid, 'SIGTERM')
        timeout = setTimeout(() => {
          // Only this invocation's still-live build group; never discovered services.
          if (command.child.exitCode === null && command.child.signalCode === null)
            try {
              process.kill(-command.child.pid, 'SIGKILL')
            } catch (error) {
              if (error.code !== 'ESRCH') process.stderr.write('Could not stop the owned build group.\n')
            }
        }, 10_000)
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const result = await command.exited
    if (result.code !== 0) throw new Error(`Command failed (${result.signal ?? result.code}): ${args[0]}`)
    signal?.throwIfAborted()
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

async function ready(command, port, signal) {
  let ended = false
  void command.exited.then(
    () => {
      ended = true
    },
    () => {
      ended = true
    },
  )
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    if (ended) throw new Error('New Web service exited before readiness')
    if ((await listenerPids(port)).includes(command.child.pid)) return
    await delay(200, undefined, { signal })
  }
  throw new Error('New Web service did not become ready within 60 seconds')
}

async function waitForExit(command) {
  const timer = new AbortController()
  try {
    await Promise.race([
      command.exited.catch(() => undefined),
      delay(40_000, undefined, { signal: timer.signal }).then(() => {
        throw new Error('Owned Web did not stop; inspect it before retrying.')
      }),
    ])
  } finally {
    timer.abort()
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args)
  if (options.help) {
    process.stdout.write(HELP)
    return
  }
  if (options.envFile) process.loadEnvFile(resolve(options.envFile))
  const stateDir = join(root, '.agnes-tmp', 'dev')
  const settingsFile = join(stateDir, `${options.port}.json`)
  const existing = await inspectListener(options.port)
  const settings = selectSettings(options, process.env, await jsonOrMissing(settingsFile), existing)
  const version = (await capture(settings.node, ['--version'])).stdout.trim()
  const [major, minor] = version.replace(/^v/u, '').split('.').map(Number)
  if (!(major > 24 || (major === 24 && minor >= 10)))
    throw new Error(`Node >=24.10 is required; found ${version}. Use make dev ARGS='--node /path/to/node'.`)
  if (options['save-env']) {
    const path = await saveDevEnvironment(settings.home, process.env)
    process.stdout.write(`Saved private Jev environment: ${path}\n`)
  }
  const env = {
    ...(await loadDevEnvironment(settings.home, process.env)),
    PATH: `${dirname(settings.node)}:${process.env.PATH ?? ''}`,
    AGH_HOME: settings.home,
    AGNES_PROFILE: settings.profile,
  }
  const stopDaemon = (runtime, chosen) =>
    runCommand(chosen.node, [join(runtime, 'agnes.mjs'), 'daemon', 'stop', ...scopeArgs(chosen)], env)
  process.stdout.write(
    `AGH dev: http://127.0.0.1:${settings.port}\nHome: ${settings.home}\nWorkspace: ${settings.cwd}\nNode: ${version}\n`,
  )
  if (options.check) {
    process.stdout.write(
      existing
        ? 'Verified existing AGH Web instance; would replace it.\n'
        : 'No Web listener; would build and start.\n',
    )
    return
  }
  await mkdir(stateDir, { recursive: true })
  await mkdir(join(settings.dataDir, 'daemon'), { recursive: true })
  const lockPath = join(settings.dataDir, 'daemon', 'dev-launch.lock')
  let release = await acquireLock(lockPath)
  let locked = true
  let owned
  let runtime
  let generation
  const controller = new AbortController()
  const interrupted = () => controller.abort(new Error('Development launcher interrupted'))
  process.on('SIGINT', interrupted)
  process.on('SIGTERM', interrupted)
  try {
    const previousOwner = await readOwner(settings)
    await assertDaemonSelection(settings, previousOwner)
    const result = await replaceRuntime(settings, existing, {
      async build() {
        process.stdout.write('Building backend and Web before stopping the current instance…\n')
        const outputRoot = join(root, 'packages', 'cli', 'dist')
        await mkdir(outputRoot, { recursive: true })
        const output = join(await mkdtemp(join(outputRoot, 'dev-')), 'runtime')
        await runCommand(
          settings.node,
          ['--import', 'tsx', join(root, 'packages/cli/tools/build-local.ts'), '--output-dir', output],
          env,
          controller.signal,
        )
        return output
      },
      inspect: (port) => {
        controller.signal.throwIfAborted()
        return inspectListener(port)
      },
      async stopDaemon(output, chosen) {
        await assertDaemonSelection(chosen, previousOwner)
        await stopDaemon(output, chosen)
      },
      stopWeb,
      listeners: listenerPids,
      start(output) {
        controller.signal.throwIfAborted()
        runtime = output
        owned = launch(
          settings.node,
          [
            join(output, 'agnes.mjs'),
            'serve',
            '--port',
            String(settings.port),
            ...scopeArgs(settings),
            '--cwd',
            settings.cwd,
          ],
          env,
        )
        return owned
      },
    })
    runtime = result.runtime
    await ready(owned, settings.port, controller.signal)
    generation = await readOwner(settings)
    if (!generation) throw new Error('Ready Web has no daemon owner')
    await assertDaemonSelection(settings, generation)
    await saveSettings(settingsFile, settings)
    await release()
    locked = false
    process.stdout.write(
      'Frontend and backend ready. Re-run make dev to rebuild/restart; Ctrl+C stops both.\n',
    )
    const exit = await Promise.race([
      owned.exited,
      new Promise((resolveAbort) => {
        if (controller.signal.aborted) resolveAbort()
        else controller.signal.addEventListener('abort', resolveAbort, { once: true })
      }),
    ])
    if (!controller.signal.aborted) {
      if (exit?.code !== 0) throw new Error(`Web exited unexpectedly (${exit?.signal ?? exit?.code})`)
      return
    }
  } finally {
    try {
      if (owned) {
        if (owned.child.exitCode === null && owned.child.signalCode === null) owned.child.kill('SIGTERM')
        await waitForExit(owned)
        if (!locked) {
          const cleanupRelease = await acquireCleanupLock(lockPath)
          if (cleanupRelease) {
            release = cleanupRelease
            locked = true
          } else {
            process.stdout.write('Another launcher owns the daemon transition; leaving its backend alone.\n')
          }
        }
        if (locked && runtime) {
          const current = await readOwner(settings)
          // Before readiness, early cancellation in serve drains its own bootstrap child.
          // After readiness, clean up only the generation this invocation actually started.
          if (current && generation && sameOwner(generation, current)) {
            await assertDaemonSelection(settings, current)
            await stopDaemon(runtime, settings)
          }
        }
      }
    } finally {
      if (locked) await release()
      process.removeListener('SIGINT', interrupted)
      process.removeListener('SIGTERM', interrupted)
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
