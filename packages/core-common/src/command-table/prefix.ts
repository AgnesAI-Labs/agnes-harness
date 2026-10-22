import { hardBlockedCommand } from './hard-block.js'
import { splitShellCommand } from './split.js'

/**
 * Command-prefix approvals: the one place that decides which prefix a shell command may offer, and
 * whether a command is covered by granted prefixes. The daemon offers with it, the matcher checks
 * with it, and `agh approvals suggest` aggregates with it, so all three always agree.
 *
 * Matching compares whole tokens, never string prefixes (`git status` does not cover `git statusx`),
 * and only a command the conservative splitter fully understands can be covered at all.
 */
export const PREFIX_SCOPE_HEAD = 'shell:prefix:'
/** A grant scope is bounded; a longer prefix is simply not offered. */
export const MAX_PREFIX_SCOPE_LENGTH = 256
const MAX_PREFIX_TOKENS = 2

export type PrefixOffer = { tokens: string[]; scope: string }

export const prefixScope = (tokens: readonly string[]): string =>
  `${PREFIX_SCOPE_HEAD}${JSON.stringify(tokens)}`

/** The tokens of a well-formed prefix scope, or undefined for anything else. */
export function parsePrefixScope(scope: string): string[] | undefined {
  if (!scope.startsWith(PREFIX_SCOPE_HEAD) || scope.length > MAX_PREFIX_SCOPE_LENGTH) return undefined
  let tokens: unknown
  try {
    tokens = JSON.parse(scope.slice(PREFIX_SCOPE_HEAD.length))
  } catch {
    return undefined
  }
  if (
    !Array.isArray(tokens) ||
    tokens.length === 0 ||
    tokens.length > MAX_PREFIX_TOKENS ||
    !tokens.every((token) => typeof token === 'string' && token.length > 0 && !/[\n\r\0]/.test(token))
  )
    return undefined
  // A banned prefix is never a valid grant, so one stored earlier is never honoured either.
  if (isBannedPrefix(tokens as string[])) return undefined
  return scope === prefixScope(tokens as string[]) ? (tokens as string[]) : undefined
}

/**
 * Prefix grants are allow-listed: a denylist of "programs that can run code" kept leaking (`rg --pre`,
 * `sort --compress-program`, `cargo run`, `uv run`). A program alone is granted only when no argument
 * can make it run or write anything; a program with a subcommand only for the pairs below.
 */
const ALONE_OK = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'pwd',
  'echo',
  'which',
  'stat',
  'du',
  'df',
  'date',
])
/**
 * The program and subcommand pairs that may be granted, each with the options a covered command may
 * carry. Options are allow-listed per pair: a denylist missed abbreviations (`git --ext` is
 * `--ext-diff`), short aliases (`bun -r`) and new flags. Every word after the pair is checked, `--`
 * included, because some of these programs hand the rest to another flag parser. What a granted
 * command runs from the project itself (test scripts, git hooks) is the grant's purpose.
 */
const GIT_LOG = [
  '--oneline',
  '-n',
  '--graph',
  '--decorate',
  '--all',
  '--stat',
  '-p',
  '--patch',
  '--name-only',
]
const PAIRS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  git: {
    status: ['-s', '--short', '-b', '--branch', '--porcelain'],
    diff: ['--stat', '--name-only', '--name-status', '--cached', '--staged'],
    log: GIT_LOG,
    show: ['--stat', '--name-only', '--oneline'],
    branch: ['-a', '--all', '-v', '--verbose', '--show-current'],
    fetch: ['--prune', '--all', '--tags', '-q', '--quiet'],
    add: ['-p', '--patch', '-u', '--update', '-A', '--all'],
    commit: ['-m', '--message', '--amend', '--no-edit', '-a', '--all', '-q', '--quiet'],
    push: ['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose'],
    pull: ['--rebase', '--ff-only', '-q', '--quiet'],
    switch: ['-c', '--create'],
    checkout: ['-b'],
    restore: ['--staged', '--worktree'],
    blame: ['-L'],
    tag: ['-l', '--list'],
    remote: ['-v', '--verbose'],
    'rev-parse': ['--abbrev-ref', '--short', '--show-toplevel'],
    'ls-files': ['--others', '--exclude-standard', '--modified'],
  },
  npm: { test: [], ls: ['--json', '--all', '--long'], outdated: ['--json', '--long'] },
  pnpm: { test: [], ls: ['--json', '--long', '-r', '--recursive'], outdated: ['--json', '--long'] },
  yarn: { test: [] },
  bun: { test: ['--coverage', '--bail'] },
  cargo: {
    build: ['--release', '-p', '--package', '--workspace', '--lib', '--bins', '-q', '-v'],
    test: ['--release', '-p', '--package', '--workspace', '--lib', '--no-run', '-q', '-v'],
    check: ['-p', '--package', '--workspace', '--all-targets', '-q'],
    clippy: ['-p', '--package', '--workspace', '--all-targets', '-q'],
    fmt: ['--check', '--all'],
    doc: ['--no-deps', '-p', '--package', '--workspace'],
    tree: ['-p', '--package', '--depth'],
  },
  go: {
    build: ['-v', '-race'],
    test: ['-v', '-race', '-run', '-count', '-short', '-cover', '-json', '-timeout', '-bench', '-benchmem'],
    vet: [],
    fmt: [],
    list: ['-m', '-json'],
  },
  uv: { sync: ['--frozen', '--locked', '--all-extras', '--dev', '--no-dev'], lock: ['--locked', '--check'] },
  pip: { list: ['--outdated', '--format', '--local', '--user'], show: [], freeze: ['--local', '--user'] },
  pip3: { list: ['--outdated', '--format', '--local', '--user'], show: [], freeze: ['--local', '--user'] },
}

const programName = (word: string): string =>
  (word.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '')

/** A prefix that must never be offered or granted, whatever the user would like. */
export function isBannedPrefix(tokens: readonly string[]): boolean {
  const program = tokens[0] ?? ''
  // A path (`./ls`) or another spelling names some other program than the one on the list.
  if (!program || programName(program) !== program) return true
  if (tokens.length === 1 ? !ALONE_OK.has(program) : !Object.hasOwn(PAIRS[program] ?? {}, tokens[1] ?? ''))
    return true
  return tokens.some((token) => looksLikeSecret(token))
}

/** True when a part after an allowed pair carries an option or word that pair does not allow. */
const deniedArgument = (words: readonly string[]): boolean => {
  const [program = '', sub = ''] = words
  if (words.length < 3 || !Object.hasOwn(PAIRS[program] ?? {}, sub)) return false
  const allowed = PAIRS[program]?.[sub] ?? []
  return words.slice(2).some(
    (word) =>
      (word.startsWith('-') && word !== '--' && !allowed.includes(word.split('=')[0] as string)) ||
      // A forced (`+main`) or deleting (`:main`) refspec rewrites or removes remote history.
      (program === 'git' && sub === 'push' && /[+:]/.test(word)),
  )
}

/** Tokens that look like a credential: never shown in a suggestion and never part of a prefix. */
export function looksLikeSecret(token: string): boolean {
  if (/^(?:sk-|ghp_|gh[osur]_|github_pat_|xox[abprs]-|AKIA[0-9A-Z]{8,})/.test(token)) return true
  if (/^bearer$/i.test(token)) return true
  if (/^[A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|credential)[A-Za-z0-9_.-]*=./i.test(token))
    return true
  return /^[A-Za-z0-9+/_=-]{24,}$/.test(token) && /\d/.test(token) && /[A-Za-z]/.test(token)
}

/** Replace credential-looking words in free command text; returns whether anything was masked. */
export function maskSecrets(text: string): { text: string; masked: boolean } {
  let masked = false
  const out = text.replace(/\S+/g, (word) => {
    const bare = word.replace(/^["']|["']$/g, '')
    if (!looksLikeSecret(bare)) return word
    masked = true
    return bare.includes('=') ? `${bare.slice(0, bare.indexOf('=') + 1)}***` : '***'
  })
  return { text: out, masked }
}

const SUBCOMMAND_WORD = /^[A-Za-z][A-Za-z0-9_.:-]*$/

/** The prefix of one command: its program plus a subcommand word when it has one. */
export function commandPrefix(words: readonly string[]): string[] | undefined {
  const program = words[0]
  if (!program) return undefined
  if (words.length === 1) return [program]
  const second = words[1] as string
  // `ls -la` would offer a bare `ls`, and `git -c x=y push` a bare `git`: no subcommand, no offer.
  if (!SUBCOMMAND_WORD.test(second)) return undefined
  return [program, second]
}

const startsWithPrefix = (words: readonly string[], prefix: readonly string[]): boolean =>
  words.length >= prefix.length && prefix.every((token, i) => words[i] === token)

/** True only when the splitter understands the whole command and every part starts with a granted prefix. */
export function coveredByPrefixes(command: string, prefixes: readonly (readonly string[])[]): boolean {
  if (prefixes.length === 0 || hardBlockedCommand(command)) return false
  const parts = splitShellCommand(command)
  const usable = prefixes.filter((prefix) => !isBannedPrefix(prefix))
  if (!parts) return false
  return parts.every(
    (words) => !deniedArgument(words) && usable.some((prefix) => startsWithPrefix(words, prefix)),
  )
}

/**
 * The prefix a command may offer: the one for the first part not already covered, offered only when
 * it is allowed, fits a grant scope, and, once granted, would cover every other uncovered part.
 */
export function offerPrefix(
  command: string,
  existing: readonly (readonly string[])[] = [],
): PrefixOffer | undefined {
  if (/[\n\r\0]/.test(command) || hardBlockedCommand(command)) return undefined
  const parts = splitShellCommand(command)
  if (!parts) return undefined
  const uncovered = parts.filter((words) => !existing.some((prefix) => startsWithPrefix(words, prefix)))
  const first = uncovered[0]
  if (!first) return undefined
  const tokens = commandPrefix(first)
  if (!tokens || isBannedPrefix(tokens) || uncovered.some(deniedArgument)) return undefined
  if (!uncovered.every((words) => startsWithPrefix(words, tokens))) return undefined
  const scope = prefixScope(tokens)
  if (scope.length > MAX_PREFIX_SCOPE_LENGTH) return undefined
  return { tokens, scope }
}

/** The answer that accepts Core's prefix offer. It is never listed in `spec.options`. */
export const PREFIX_OPTION = 'allow_prefix_session'

/** Answers that leave a session-wide allowance behind, which can be revoked after consumption. */
export const SESSION_GRANT_OPTIONS: readonly string[] = ['allowed-session', PREFIX_OPTION]

/**
 * The options a decision accepts: its listed options, plus the prefix answer when, and only when, the
 * recorded (digest-covered) subject carries a well-formed prefix offer for a tool permission. Keeping
 * the prefix answer out of the listed options means a client that predates it sees the same options
 * as ever and cannot be confused by a value it does not know.
 */
export function acceptedOptions(spec: {
  purpose: string
  subject: unknown
  options: readonly string[]
}): readonly string[] {
  const offered = (spec.subject as { prefixGrant?: { tokens?: unknown; scope?: unknown } } | null)
    ?.prefixGrant
  const tokens = typeof offered?.scope === 'string' ? parsePrefixScope(offered.scope) : undefined
  return spec.purpose === 'tool.permission' &&
    tokens &&
    JSON.stringify(tokens) === JSON.stringify(offered?.tokens)
    ? [...spec.options, PREFIX_OPTION]
    : spec.options
}
