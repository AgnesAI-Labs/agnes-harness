import { parseAgentRef, parseLoopSpecifier, SLOT_NAMES } from '@agnes/protocol/command-line'
import { UsageError } from './errors.js'
import type { Command, ModelSel, ParsedArgs } from './types.js'

export type { Command, ModelSel, ParsedArgs } from './types.js'

export const COMMANDS = new Set<string>([
  'app',
  'home',
  'app-server',
  'run',
  'batch',
  'runtime',
  'tools',
  'resume',
  'sessions',
  'approvals',
  'schedules',
  'triggers',
  'settings',
  'credentials',
  'agents',
  'queue',
  'api',
  'export',
  'import',
  'doctor',
  'diagnostics',
  'computer-use',
  'profile',
  'plugin',
  'plugins',
  'package',
  'packages',
  'dev',
  'install',
  'resources',
  'skills',
  'consent',
  'stats',
  'config',
  'conformance',
  'daemon',
  'ext',
  'mcp',
  'serve',
  'web',
  'start',
  'acp',
  'completion',
])

/** These hand their tail on to another program or another grammar; we do not read it. */
const FORWARDED = new Set<string>([
  'app',
  'home',
  'app-server',
  'run',
  'batch',
  'runtime',
  'plugin',
  'daemon',
  'ext',
  'mcp',
  'resources',
  'skills',
  'serve',
  'web',
  'start',
])

// Both tables are null-prototype maps read through Object.hasOwn. A plain object literal read with
// `in` answers true for toString, constructor, hasOwnProperty and __proto__, which would make an
// ordinary prompt word look like a flag: it would swallow the next argument as its value and then
// write it under an inherited name. Either half stops that on its own; the test pins the property,
// not either half, so removing just one of them stays green.
export const VALUE_FLAGS: Record<string, keyof ParsedArgs> = Object.assign(Object.create(null), {
  '--profile': 'profile',
  '--preset': 'preset',
  '--permission': 'permission',
  '--cwd': 'cwd',
  '--data-dir': 'dataDir',
  '--candidate-hash': 'candidateHash',
  '--review-hash': 'reviewHash',
  '--resume': 'resume',
  '--connect': 'connect',
  '--mode': 'mode',
  '--format': 'format',
  '-o': 'out',
  '--out': 'out',
  '--save': 'save',
  '--turn': 'turn',
  '--from': 'from',
  '--key': 'key',
  '--session': 'key',
  '--prompt': 'prompt',
  '--title': 'title',
  '--every': 'every',
  '--cron': 'cron',
  '--at': 'at',
  '--daily': 'daily',
  '--weekly': 'weekly',
  '--tz': 'tz',
  '--unattended': 'unattended',
  '--payload': 'payload',
  '--days': 'days',
  '--min-count': 'minCount',
  '--limit': 'limit',
  '--file': 'file',
  '--text': 'text',
  '--params': 'params',
  '--output-schema': 'outputSchema',
})

export const BOOL_FLAGS: Record<string, keyof ParsedArgs> = Object.assign(Object.create(null), {
  '-p': 'print',
  '--print': 'print',
  '--continue': 'continue',
  '--park': 'park',
  '--ephemeral': 'ephemeral',
  '--standalone': 'standalone',
  '--new': 'newSession',
  '--new-session': 'newSession',
  '--all': 'all',
  '--last': 'last',
  '--steer': 'steer',
  '--no-alt-screen': 'noAltScreen',
  '--json': 'json',
  '--repair': 'repair',
  '--upgrade': 'upgrade',
  '--html': 'html',
  '--raw': 'raw',
  '--resolved': 'resolved',
  '--archived': 'archived',
  '--force': 'force',
  '--probe': 'probe',
  '--yes': 'yes',
  '--help': 'help',
  '-h': 'help',
  '--version': 'version',
  '-v': 'version',
})

export const ENUMS: Record<string, string[]> = Object.assign(Object.create(null), {
  mode: ['text', 'json', 'stream-json', 'acp'],
  format: ['agnes', 'sharegpt', 'claude-code'],
  from: ['claude-code', 'codex', 'pi', 'auto'],
  permission: ['read-only', 'workspace-write', 'full-access', 'default'],
  unattended: ['notify', 'refuse'],
})

function defaults(): ParsedArgs {
  return {
    positional: [],
    rest: [],
    print: false,
    help: false,
    version: false,
    continue: false,
    park: false,
    ephemeral: false,
    json: false,
    repair: false,
    upgrade: false,
    html: false,
    raw: false,
    resolved: false,
    archived: false,
    force: false,
    probe: false,
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const p = defaults()
  let i = 0
  const head = argv[0]
  if (head !== undefined && COMMANDS.has(head)) {
    p.command = head as Command
    i = 1
    if (FORWARDED.has(head)) {
      p.rest = argv.slice(1)
      // Handle help before a forwarded grammar can start a daemon or bind a listener.
      // Stdio arguments and everything after -- remain data for the other program.
      for (let at = 0; at < p.rest.length; at++) {
        const arg = p.rest[at]
        if (arg === '--') break
        if (arg === '--arg') {
          at++
          continue
        }
        if (arg === '--help' || arg === '-h') p.help = true
      }
      return p
    }
    if (head === 'acp') p.mode = 'acp'
  }
  const write = (key: keyof ParsedArgs, value: unknown): void => {
    ;(p as Record<string, unknown>)[key] = value
  }
  for (; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--') {
      p.positional.push(...argv.slice(i + 1))
      break
    }
    if (a === '--agent') {
      try {
        p.agent = parseAgentRef(argv[++i])
      } catch {
        throw new UsageError('--agent expects package#agent')
      }
      continue
    }
    if (a === '--loop') {
      const value = argv[++i]
      try {
        if (value === undefined) throw new Error()
        p.loop = parseLoopSpecifier(value)
      } catch {
        throw new UsageError('--loop expects id@version')
      }
      continue
    }
    if (a === '--model') {
      i += 1
      p.model = parseModel(argv[i])
      continue
    }
    if ((a === '--include' || a === '--skip') && p.command === 'doctor') {
      i += 1
      const v = argv[i]
      if (v === undefined || v.length === 0 || v.startsWith('-')) throw new UsageError(`${a} needs a value`)
      const key = a === '--include' ? 'include' : 'skip'
      const values = p[key] ?? []
      values.push(v)
      p[key] = values
      continue
    }
    if (Object.hasOwn(VALUE_FLAGS, a)) {
      const key = VALUE_FLAGS[a] as keyof ParsedArgs
      i += 1
      const v = argv[i]
      // A value that looks like a flag is treated as a missing value rather than consumed: every
      // value this grammar takes is a name, a path or a session key, none of which start with a dash.
      if (v === undefined || (v.startsWith('-') && v !== '-')) throw new UsageError(`${a} needs a value`)
      const allowed = Object.hasOwn(ENUMS, key) ? (ENUMS[key] as string[]) : null
      if (allowed && !allowed.includes(v)) throw new UsageError(`${a} must be one of ${allowed.join('|')}`)
      write(key, v)
      continue
    }
    if (Object.hasOwn(BOOL_FLAGS, a)) {
      write(BOOL_FLAGS[a] as keyof ParsedArgs, true)
      continue
    }
    // A lone dash is data (stdin for queue), not a flag.
    if (a.startsWith('-') && a !== '-') {
      const name = a.split('=', 1)[0] ?? ''
      const safeName = /^(?:--[a-z][a-z0-9-]{0,63}|-[A-Za-z])$/.test(name) ? ` ${name}` : ''
      throw new UsageError(`unknown flag${safeName}`)
    }
    p.positional.push(a)
  }
  // Both printing modes select the one-shot form. Only acp does not, because it is a third form
  // rather than a way of printing, and resolveMode reads it as such.
  if (p.mode === 'json' || p.mode === 'stream-json' || p.mode === 'text') p.print = true
  if (p.agent && (p.loop || p.preset || p.permission))
    throw new UsageError('--agent cannot be combined with --loop, --preset or --permission')
  if (p.agent && (p.continue || p.resume !== undefined || p.command === 'resume' || p.key !== undefined))
    throw new UsageError('--agent selects a new session')
  if (p.loop && (p.continue || p.resume !== undefined || p.command === 'resume'))
    throw new UsageError('--loop selects a new session; resumed sessions keep their pinned loop')
  if (p.newSession && (p.continue || p.resume !== undefined || p.command === 'resume'))
    throw new UsageError('--new cannot be combined with --continue or --resume')
  if (
    p.key !== undefined &&
    p.command !== 'tools' &&
    p.command !== 'diagnostics' &&
    p.command !== 'schedules' &&
    argv.includes('--session')
  )
    throw new UsageError('--session is supported only by tools, diagnostics and schedules')
  if (p.steer && p.command !== 'queue') throw new UsageError('--steer is supported only by queue')
  if (p.continue && p.resume !== undefined)
    throw new UsageError('--continue and --resume are mutually exclusive')
  if (p.dataDir !== undefined && !(p.command === 'computer-use' && p.positional[0] === 'rescue'))
    throw new UsageError('--data-dir is supported only by computer-use rescue')
  if (
    p.probe &&
    !(
      p.command === 'doctor' &&
      (p.positional.length === 0 || (p.positional[0] === 'provider' && p.positional.length === 1))
    )
  )
    throw new UsageError('--probe is supported only by doctor or doctor provider')
  return p
}

function parseModel(v: string | undefined): ModelSel {
  const m = v === undefined ? null : /^([A-Za-z_]+)=([^/]+)\/(.+)$/.exec(v)
  if (!m) throw new UsageError('--model expects <slot>=<route>/<model>')
  const slot = m[1] as string
  if (!(SLOT_NAMES as readonly string[]).includes(slot))
    throw new UsageError(`--model slot must be one of ${SLOT_NAMES.join(', ')}, got ${slot}`)
  return { slot: slot as ModelSel['slot'], route: m[2] as string, model: m[3] as string }
}

export function resolveMode(
  p: ParsedArgs,
  tty: { stdin: boolean; stdout: boolean },
): 'tui' | 'print' | 'acp' {
  if (p.mode === 'acp') return 'acp'
  // Read off `mode` here as well as off `print`, rather than trusting parseArgs to have set print
  // for the two printing modes. A caller that builds a ParsedArgs by hand -- a test, a later
  // command that reuses the type -- would otherwise get a TUI out of `--mode json`.
  if (p.mode === 'text' || p.mode === 'json' || p.mode === 'stream-json') return 'print'
  // Either end not being a terminal is enough: a piped stdin has nobody to type into the TUI, and a
  // redirected stdout would be filled with cursor movement instead of an answer.
  if (p.print || !tty.stdin || !tty.stdout) return 'print'
  return 'tui'
}

export { usage } from './usage.js'
