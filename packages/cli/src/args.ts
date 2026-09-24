import { SLOT_NAMES } from '@agnes/protocol'
import { UsageError } from './errors.js'
import type { Command, ModelSel, ParsedArgs } from './types.js'

export type { Command, ModelSel, ParsedArgs } from './types.js'

const COMMANDS = new Set<string>([
  'resume',
  'sessions',
  'export',
  'import',
  'doctor',
  'computer-use',
  'profile',
  'package',
  'packages',
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
  'acp',
])

/** These four hand their tail on to another program or another grammar; we do not read it. */
const FORWARDED = new Set<string>(['daemon', 'ext', 'mcp', 'resources', 'skills', 'serve'])

// Both tables are null-prototype maps read through Object.hasOwn. A plain object literal read with
// `in` answers true for toString, constructor, hasOwnProperty and __proto__, which would make an
// ordinary prompt word look like a flag: it would swallow the next argument as its value and then
// write it under an inherited name. Either half stops that on its own; the test pins the property,
// not either half, so removing just one of them stays green.
const VALUE_FLAGS: Record<string, keyof ParsedArgs> = Object.assign(Object.create(null), {
  '--profile': 'profile',
  '--preset': 'preset',
  '--cwd': 'cwd',
  '--data-dir': 'dataDir',
  '--resume': 'resume',
  '--connect': 'connect',
  '--mode': 'mode',
  '--format': 'format',
  '-o': 'out',
  '--out': 'out',
  '--from': 'from',
  '--key': 'key',
})

const BOOL_FLAGS: Record<string, keyof ParsedArgs> = Object.assign(Object.create(null), {
  '-p': 'print',
  '--print': 'print',
  '--continue': 'continue',
  '--park': 'park',
  '--meta': 'meta',
  '--ephemeral': 'ephemeral',
  '--standalone': 'standalone',
  '--json': 'json',
  '--repair': 'repair',
  '--upgrade': 'upgrade',
  '--html': 'html',
  '--raw': 'raw',
  '--resolved': 'resolved',
  '--probe': 'probe',
  '--help': 'help',
  '-h': 'help',
  '--version': 'version',
  '-v': 'version',
})

const ENUMS: Record<string, string[]> = Object.assign(Object.create(null), {
  mode: ['text', 'json', 'acp'],
  format: ['agnes', 'sharegpt', 'claude-code'],
  from: ['claude-code', 'codex', 'pi', 'auto'],
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
    meta: false,
    ephemeral: false,
    json: false,
    repair: false,
    upgrade: false,
    html: false,
    raw: false,
    resolved: false,
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
      if (v === undefined || v.startsWith('-')) throw new UsageError(`${a} needs a value`)
      const allowed = Object.hasOwn(ENUMS, key) ? (ENUMS[key] as string[]) : null
      if (allowed && !allowed.includes(v)) throw new UsageError(`${a} must be one of ${allowed.join('|')}`)
      write(key, v)
      continue
    }
    if (Object.hasOwn(BOOL_FLAGS, a)) {
      write(BOOL_FLAGS[a] as keyof ParsedArgs, true)
      continue
    }
    if (a.startsWith('-')) {
      const name = a.split('=', 1)[0] ?? ''
      const safeName = /^(?:--[a-z][a-z0-9-]{0,63}|-[A-Za-z])$/.test(name) ? ` ${name}` : ''
      throw new UsageError(`unknown flag${safeName}`)
    }
    p.positional.push(a)
  }
  // Both printing modes select the one-shot form. Only acp does not, because it is a third form
  // rather than a way of printing, and resolveMode reads it as such.
  if (p.mode === 'json' || p.mode === 'text') p.print = true
  if (p.continue && p.resume !== undefined)
    throw new UsageError('--continue and --resume are mutually exclusive')
  if (p.dataDir !== undefined && !(p.command === 'computer-use' && p.positional[0] === 'rescue'))
    throw new UsageError('--data-dir is supported only by computer-use rescue')
  if (p.probe && !(p.command === 'doctor' && p.positional[0] === 'provider' && p.positional.length === 1))
    throw new UsageError('--probe is supported only by doctor provider')
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
  if (p.mode === 'text' || p.mode === 'json') return 'print'
  // Either end not being a terminal is enough: a piped stdin has nobody to type into the TUI, and a
  // redirected stdout would be filled with cursor movement instead of an answer.
  if (p.print || !tty.stdin || !tty.stdout) return 'print'
  return 'tui'
}

export function usage(): string {
  return [
    'agh [prompt] [--profile <p>] [--preset <n>] [--cwd <dir>] [--continue | --resume <id>]',
    '      [--connect <t>] [--model <slot>=<route>/<model>]',
    'agh -p [prompt] [--mode text|json] [--park] [--meta] [--ephemeral|--standalone]',
    'agh --mode acp [--profile <p> | --connect <t>] [--ephemeral]      agh acp ... (alias)',
    'agh resume <id> [-p [prompt]]',
    'agh sessions [list [--cwd <dir>] | show <id>]',
    'agh export <id> [--format agnes|sharegpt|claude-code] [--html] [--raw] [-o|--out <file>]',
    'agh import <file> [--from claude-code|codex|pi|auto] [--key <sessionKey>]',
    'agh doctor [platform|provider|storage|profile|extensions|daemon|binary|code-runtime] [--json]',
    'agh doctor provider --probe [--json]  # explicit minimal-inference diagnostic',
    'agh doctor computer-use [--json] [--include <check>] [--skip <check>]',
    'agh computer-use status [--json] | install [--upgrade] [--json] | restart [--json]',
    'agh computer-use rescue status|install|repair [--profile <p>] [--cwd <dir>] [--data-dir <dir>] [--json]',
    'agh computer-use operation [operationId] [--json] | cancel <operationId> [--json]',
    'agh computer-use permissions status|grant [--json]',
    'agh doctor subagents [--json] [--repair]',
    'agh profile list | inspect <p> [--resolved] | trust <deployDir>',
    'agh package [--profile <p>] status|catalog [query]|inspect <src>|add <src>|trust <id> <integrity> <capabilityHash>',
    '              enable|disable|rollback|remove <id> | operation|cancel <operationId>',
    'agh install <src> [--profile <p>]',
    'agh packages pins inspect | release <pinId...> [--profile <p>]',
    'agh resources list|get|operation|cancel|enable|disable ...   agh skills refresh|trust ...',
    'agh mcp list|get|add|update|remove|test|enable|disable|status|reconnect|tools ...',
    'agh consent DISABLED|LOCAL|ANON|FULL',
    'agh stats deviation [--json]        agh config [--connect <t>]        agh conformance gateway [--json]',
    'agh daemon start|stop|status [...]  agh ext <...>  agh mcp serve [...]  agh serve model-api [...]',
    'agh --version | --help',
  ].join('\n')
}
