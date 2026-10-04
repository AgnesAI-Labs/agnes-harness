import { execFile } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export const capture = (file, args) => execute(file, args, { timeout: 5000, maxBuffer: 1024 * 1024 })

/** ps does not preserve shell quoting. Accept only the closed AGH launcher grammar. */
export function parseServeCommand(command, port) {
  const match = /^(.+?) (\/.+\/agnes\.mjs) serve(?: (.*))?$/u.exec(command.trim())
  if (!match || !['node', 'nodejs'].includes(basename(match[1]))) return
  const [, node, entry, tail = ''] = match
  if (!isAbsolute(node) || /[\r\n]/u.test(entry)) return
  const flags = new Map()
  const parts = [...` ${tail}`.matchAll(/ (--[a-z-]+)(?: |$)/gu)]
  if (parts[0]?.index !== 0) return
  for (const [index, part] of parts.entries()) {
    const name = part[1]
    if (!['--port', '--home', '--data-dir', '--cwd', '--profile'].includes(name) || flags.has(name)) return
    const value = ` ${tail}`.slice(part.index + part[0].length, parts[index + 1]?.index).trim()
    if (!value || /[\r\n]/u.test(value)) return
    flags.set(name, value)
  }
  if (flags.get('--port') !== String(port)) return
  for (const name of ['--home', '--data-dir', '--cwd']) if (!isAbsolute(flags.get(name) ?? '')) return
  const profile = flags.get('--profile')
  if (profile !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(profile)) return
  return {
    node,
    entry,
    port,
    home: flags.get('--home'),
    dataDir: flags.get('--data-dir'),
    cwd: flags.get('--cwd'),
    profile,
  }
}

export async function listenerPids(port) {
  let stdout
  try {
    ;({ stdout } = await capture('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']))
  } catch (error) {
    if (error.code === 1 && error.stdout === '' && error.stderr === '') return []
    throw new Error('Cannot inspect the Web listener; install/allow lsof before make dev.', { cause: error })
  }
  const ids = [...new Set(stdout.trim().split(/\s+/u).map(Number))]
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid listener PID output')
  return ids
}

export async function processCommand(pid) {
  return (await capture('ps', ['-ww', '-p', String(pid), '-o', 'command='])).stdout.trim()
}

/** Start identities, not kill(pid, 0), protect signals from stale/reused PIDs. */
export async function processStart(pid, runtime) {
  const darwin = process.platform === 'darwin' // guards-allow-platform: native process identity.
  if (darwin) {
    try {
      const { stdout } = await capture(join(runtime, 'native', 'macos-process-identity'), [String(pid)])
      if (!/^alive [0-9a-f-]{36} [0-9]{1,20}\.[0-9]{6}\n$/u.test(stdout))
        throw new Error('Unknown process identity')
      return stdout.trim()
    } catch (error) {
      if (error.code === 1 && error.stdout === 'dead\n') return null
      throw new Error(`Cannot verify process ${pid}; refusing to signal it.`, { cause: error })
    }
  }
  const linux = process.platform === 'linux' // guards-allow-platform: proc process identity.
  if (linux) {
    try {
      const [boot, record] = await Promise.all([
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        readFile(`/proc/${pid}/stat`, 'utf8'),
      ])
      const fields = record
        .slice(record.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/u)
      if (!record.startsWith(`${pid} (`) || !/^\d+$/u.test(fields[19] ?? ''))
        throw new Error('Unknown proc identity')
      return `${boot.trim()}:${fields[19]}`
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
  }
  throw new Error('make dev currently supports macOS/Linux; on Windows use start-local-windows.ps1.')
}

export async function inspectListener(port) {
  const pids = await listenerPids(port)
  if (pids.length === 0) return null
  if (pids.length !== 1) throw new Error(`Port ${port} has multiple listeners; nothing was stopped.`)
  const pid = pids[0]
  const command = await processCommand(pid)
  const parsed = parseServeCommand(command, port)
  if (!parsed)
    throw new Error(`Port ${port} is not an explicitly scoped AGH serve process; nothing was stopped.`)
  for (const file of [parsed.node, parsed.entry, join(dirname(parsed.entry), 'daemon.mjs')])
    if (!(await stat(file)).isFile())
      throw new Error('Existing AGH runtime is incomplete; nothing was stopped.')
  // Profile may have arrived through the old process environment. Read the daemon's public descriptor,
  // never the old process environment or its private Web credential.
  const discovery = JSON.parse(await readFile(join(parsed.dataDir, 'daemon', 'discovery.json'), 'utf8'))
  if (
    typeof discovery.profile !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(discovery.profile) ||
    (await realpath(discovery.dataDir)) !== (await realpath(parsed.dataDir)) ||
    (parsed.profile !== undefined && parsed.profile !== discovery.profile)
  )
    throw new Error('Existing Web scope disagrees with daemon discovery; nothing was stopped.')
  const start = await processStart(pid, dirname(parsed.entry))
  if (!start || command !== (await processCommand(pid)))
    throw new Error('Web process changed during inspection')
  return { ...parsed, profile: discovery.profile, pid, command, start }
}

/** Only one TERM; timeout is a refusal, not permission to kill an unverified process tree. */
export async function stopWeb(existing, ports = {}) {
  const identity = ports.identity ?? processStart
  const command = ports.command ?? processCommand
  const kill = ports.kill ?? process.kill
  const wait = ports.wait ?? delay
  const runtime = dirname(existing.entry)
  const start = await identity(existing.pid, runtime)
  if (start === null) return
  if (start !== existing.start || (await command(existing.pid)) !== existing.command)
    throw new Error('Web process identity changed before shutdown; nothing was signalled.')
  try {
    kill(existing.pid, 'SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await identity(existing.pid, runtime)
    if (current === null || current !== existing.start) return
    await wait(100)
  }
  throw new Error('Web shutdown timed out; no new service was started.')
}
