import { BOOL_FLAGS, COMMANDS, ENUMS, VALUE_FLAGS } from './args.js'

export const SHELLS = ['bash', 'zsh', 'fish'] as const
export type Shell = (typeof SHELLS)[number]

/**
 * Words that may follow a command. Each one has to appear in that command's help text (a guard test
 * checks it), so this table cannot name a verb the command does not have. Forwarded commands own their
 * grammar elsewhere; only their verbs are listed.
 */
export const SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  app: ['clear', 'show', 'preview', 'adopt'],
  approvals: ['grants', 'revoke', 'suggest'],
  completion: [...SHELLS],
  'computer-use': ['status', 'install', 'restart', 'rescue', 'operation', 'cancel', 'permissions'],
  credentials: ['list', 'rename', 'delete'],
  daemon: ['start', 'stop', 'status'],
  doctor: [
    'platform',
    'network',
    'provider',
    'storage',
    'credentials',
    'profile',
    'extensions',
    'daemon',
    'binary',
    'code-runtime',
    'computer-use',
    'subagents',
  ],
  home: ['info'],
  mcp: [
    'list',
    'get',
    'status',
    'tools',
    'add',
    'update',
    'trust',
    'enable',
    'disable',
    'test',
    'reconnect',
    'remove',
  ],
  package: [
    'inspect',
    'add',
    'trust',
    'enable',
    'disable',
    'rollback',
    'remove',
    'status',
    'list',
    'catalog',
    'operation',
    'cancel',
    'source-policy',
  ],
  plugins: [
    'add',
    'pack',
    'trust',
    'enable',
    'reload',
    'candidates',
    'provenance',
    'publication-status',
    'config',
    'tree',
    'generations',
  ],
  profile: ['list', 'inspect', 'trust'],
  resources: ['list', 'get', 'operation', 'cancel', 'enable', 'disable'],
  schedules: ['list', 'show', 'pause', 'resume', 'run', 'archive', 'add', 'edit'],
  sessions: [
    'list',
    'show',
    'verify',
    'pin',
    'unpin',
    'archive',
    'unarchive',
    'rename',
    'search',
    'groups',
    'deliverables',
    'undo',
    'migrate',
  ],
  skills: ['list', 'refresh', 'trust'],
  triggers: ['list', 'add', 'edit', 'remove', 'test', 'configure'],
}

/** `sessions` verbs whose next word is an existing session key. */
export const SESSION_KEY_VERBS = [
  'show',
  'verify',
  'pin',
  'unpin',
  'archive',
  'unarchive',
  'rename',
  'deliverables',
  'undo',
  'migrate',
] as const
/** Flags whose value is an existing session key, completed from the daemon. */
export const SESSION_FLAGS = ['--resume', '--session'] as const
/** Flags the parser reads before its flag tables, so the tables do not list them. */
const SPECIAL_VALUE_FLAGS = [
  '--agent',
  '--loop',
  '--model',
  '--include',
  '--skip',
  '--tools',
  '--disallowed-tools',
]

export type CompletionSpec = {
  commands: string[]
  subcommands: Record<string, string[]>
  /** Long flags only; short ones are not worth a TAB. */
  flags: string[]
  /** Flags that take a value, whatever it is. */
  valueFlags: string[]
  /** Flags whose value is one of a fixed set. */
  enums: Record<string, string[]>
}

export function completionSpec(): CompletionSpec {
  const long = (names: string[]): string[] => names.filter((n) => n.startsWith('--'))
  const valueFlags = long([...Object.keys(VALUE_FLAGS), ...SPECIAL_VALUE_FLAGS]).sort()
  const flags = [...new Set([...valueFlags, ...long(Object.keys(BOOL_FLAGS))])].sort()
  const enums: Record<string, string[]> = {}
  for (const [flag, key] of Object.entries(VALUE_FLAGS))
    if (flag.startsWith('--') && Object.hasOwn(ENUMS, key)) enums[flag] = [...(ENUMS[key] as string[])]
  return {
    commands: [...COMMANDS].sort(),
    subcommands: Object.fromEntries(Object.entries(SUBCOMMANDS).map(([k, v]) => [k, [...v]])),
    flags,
    valueFlags,
    enums,
  }
}
