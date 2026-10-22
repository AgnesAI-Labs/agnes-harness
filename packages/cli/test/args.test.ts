import { describe, expect, it } from 'vitest'
import { type ParsedArgs, parseArgs, resolveMode, usage } from '../src/args.js'
import { UsageError } from '../src/errors.js'
import { refuseTurnCapsOutsidePrint } from '../src/turn-caps.js'

const throws = (argv: string[]): UsageError => {
  try {
    parseArgs(argv)
  } catch (e) {
    if (e instanceof UsageError) return e
    throw e
  }
  throw new Error(`parseArgs(${JSON.stringify(argv)}) was expected to reject and did not`)
}

describe('parseArgs: the common forms', () => {
  it('a bare prompt with the session-shaping flags', () => {
    const p = parseArgs([
      'fix the bug',
      '--profile',
      'local-dev',
      '--preset',
      'standard',
      '--model',
      'primary=gateway/deepseek-v4',
    ])
    expect(p.positional).toEqual(['fix the bug'])
    expect(p.profile).toBe('local-dev')
    expect(p.preset).toBe('standard')
    expect(p.model).toEqual({ slot: 'primary', route: 'gateway', model: 'deepseek-v4' })
    expect(p.print).toBe(false)
    expect(p.command).toBeUndefined()
  })

  it('--no-alt-screen is a boolean flag of the interactive form, absent by default and listed in usage', () => {
    expect(parseArgs(['hello'])).not.toHaveProperty('noAltScreen')
    expect(parseArgs(['--no-alt-screen', 'hello'])).toMatchObject({
      noAltScreen: true,
      positional: ['hello'],
    })
    expect(usage()).toContain('--no-alt-screen')
  })

  it('--safe-mode and --ignore-rules are refused unless this client starts the host itself', () => {
    for (const flag of ['--safe-mode', '--ignore-rules']) {
      expect(parseArgs([flag, '--ephemeral'])).toMatchObject({ ephemeral: true })
      expect(parseArgs(['-p', 'x', flag, '--standalone'])).toMatchObject({ standalone: true })
      // The shared daemon, whether attached by default or named with --connect (even beside --standalone).
      expect(() => parseArgs([flag])).toThrow(/needs a private host/)
      expect(() => parseArgs([flag, '--connect', 'ws://h'])).toThrow(/needs a private host/)
      expect(() => parseArgs([flag, '--standalone', '--connect', 'ws://h'])).toThrow(/needs a private host/)
      expect(() => parseArgs(['sessions', flag, '--ephemeral'])).toThrow(/only to starting or resuming/)
    }
    expect(parseArgs(['--safe-mode', '--ephemeral'])).toMatchObject({ safeMode: true })
    expect(parseArgs(['--ignore-rules', '--ephemeral'])).toMatchObject({ ignoreRules: true })
  })

  it('-p with the one-shot flags', () => {
    const p = parseArgs(['-p', 'hi', '--mode', 'json', '--ephemeral', '--standalone'])
    expect(p).toMatchObject({
      print: true,
      mode: 'json',
      ephemeral: true,
      standalone: true,
      positional: ['hi'],
    })
  })

  it('--mode selects the one-shot form on its own, for both of its printing values', () => {
    expect(parseArgs(['--mode', 'json']).print).toBe(true)
    expect(parseArgs(['--mode', 'text']).print).toBe(true)
    expect(parseArgs(['--mode', 'stream-json']).print).toBe(true)
    // acp is a third form, not a printing one, so it does not set print.
    expect(parseArgs(['--mode', 'acp']).print).toBe(false)
  })

  it('--print is the long spelling of -p, and every boolean defaults to false', () => {
    expect(parseArgs(['--print']).print).toBe(true)
    const bare = parseArgs([])
    expect(bare).toEqual({
      positional: [],
      rest: [],
      print: false,
      help: false,
      version: false,
      continue: false,
      park: false,
      ephemeral: false,
      json: false,
      html: false,
      raw: false,
      repair: false,
      upgrade: false,
      resolved: false,
      archived: false,
      force: false,
      probe: false,
    })
  })

  it('accepts --probe only for the provider doctor without changing ordinary argument parsing', () => {
    expect(parseArgs(['doctor', 'provider', '--probe'])).toMatchObject({
      command: 'doctor',
      positional: ['provider'],
      probe: true,
    })
    expect(parseArgs(['doctor', 'provider', '--json'])).toMatchObject({ probe: false, json: true })
  })

  it('every long value flag records its value under its own key', () => {
    const p = parseArgs(['--profile', 'a', '--preset', 'b', '--cwd', '/c', '--connect', 'unix:///s'])
    expect(p).toMatchObject({ profile: 'a', preset: 'b', cwd: '/c', connect: 'unix:///s' })
    expect(p.permission).toBeUndefined()
    for (const level of ['read-only', 'workspace-write', 'full-access', 'default'])
      expect(parseArgs(['--preset', 'b', '--permission', level])).toMatchObject({
        preset: 'b',
        permission: level,
      })
    expect(parseArgs(['--resume', 'sid']).resume).toBe('sid')
  })

  it('-h/-v are the short spellings of --help/--version', () => {
    expect(parseArgs(['-h']).help).toBe(true)
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-v']).version).toBe(true)
    expect(parseArgs(['--version']).version).toBe(true)
  })
})

describe('parseArgs: subcommands', () => {
  it('resume takes an id and still accepts the one-shot flags', () => {
    expect(parseArgs(['resume', 'abc', '-p', 'go on'])).toMatchObject({
      command: 'resume',
      positional: ['abc', 'go on'],
      print: true,
    })
  })

  it('export and import carry their own flags', () => {
    expect(
      parseArgs(['export', 'abc', '--format', 'sharegpt', '--html', '--raw', '-o', 'x.json']),
    ).toMatchObject({
      command: 'export',
      positional: ['abc'],
      format: 'sharegpt',
      html: true,
      raw: true,
      out: 'x.json',
    })
    expect(parseArgs(['export', 'abc', '--out', 'y.json']).out).toBe('y.json')
    expect(parseArgs(['import', 'f.jsonl', '--from', 'codex', '--key', 'agnes:t:a:cli:dm:x'])).toMatchObject({
      command: 'import',
      positional: ['f.jsonl'],
      from: 'codex',
      key: 'agnes:t:a:cli:dm:x',
    })
  })

  it('profile inspect keeps its words as positionals', () => {
    expect(parseArgs(['profile', 'inspect', 'local-dev', '--resolved'])).toMatchObject({
      command: 'profile',
      positional: ['inspect', 'local-dev'],
      resolved: true,
    })
  })

  it('recognizes computer-use status as an owned command grammar', () => {
    expect(parseArgs(['computer-use', 'status', '--json'])).toMatchObject({
      command: 'computer-use',
      positional: ['status'],
      json: true,
      rest: [],
    })
    expect(usage()).toContain('agh computer-use status [--json]')
  })

  it('collects repeated Computer Use doctor include and skip selectors without swallowing them', () => {
    expect(
      parseArgs([
        'doctor',
        'computer-use',
        '--include',
        'binary',
        '--include',
        'display',
        '--skip',
        'display',
      ]),
    ).toMatchObject({ include: ['binary', 'display'], skip: ['display'] })
    expect(throws(['doctor', 'computer-use', '--include', '--json']).message).toBe('--include needs a value')
    expect(throws(['computer-use', 'status', '--include', 'binary']).message).toBe('unknown flag --include')
    expect(throws(['-p', 'hi', '--meta']).message).toBe('unknown flag --meta')
    expect(throws(['doctor', 'computer-use', '--token=S3CR3T_MARKER']).message).toBe('unknown flag --token')
    expect(throws(['doctor', 'computer-use', '-S3CR3T_MARKER']).message).toBe('unknown flag')
    expect(usage()).toContain('permissions status|grant [--json]')
  })

  it('acp is an alias that presets the mode', () => {
    expect(parseArgs(['acp', '--ephemeral'])).toMatchObject({ command: 'acp', mode: 'acp', ephemeral: true })
  })

  it.each([
    [
      ['ext', 'init', 'xinwei/foo', '--weird'],
      ['init', 'xinwei/foo', '--weird'],
    ],
    [
      ['daemon', 'start', '--profile', 'enterprise'],
      ['start', '--profile', 'enterprise'],
    ],
    [
      ['mcp', 'serve', '--stdio'],
      ['serve', '--stdio'],
    ],
    [
      ['serve', 'model-api', '--port', '8080'],
      ['model-api', '--port', '8080'],
    ],
    [
      ['web', '--port', '4180', '--home', '/tmp/agh-home'],
      ['--port', '4180', '--home', '/tmp/agh-home'],
    ],
    [
      ['start', '--port', '4180'],
      ['--port', '4180'],
    ],
    [['daemon'], []],
  ])('%j forwards everything after the command verbatim', (argv, rest) => {
    const p = parseArgs(argv as string[])
    expect(p.rest).toEqual(rest)
    expect(p.positional).toEqual([])
  })

  // The forwarded commands own their own grammar. A flag this grammar would reject, and a value
  // flag whose value would otherwise be eaten, both have to survive untouched.
  it('a forwarded command is not parsed at all, so its unknown flags do not reject', () => {
    expect(parseArgs(['ext', '--bogus', '--mode', 'rpc', '--']).rest).toEqual([
      '--bogus',
      '--mode',
      'rpc',
      '--',
    ])
  })

  it('a word that is not a command is a prompt, not an error', () => {
    const unknown = parseArgs(['doctorr'])
    expect(unknown.command).toBeUndefined()
    expect(unknown.positional).toEqual(['doctorr'])
    // Only in first position: a command word later on is an ordinary positional.
    const late = parseArgs(['hello', 'daemon'])
    expect(late.command).toBeUndefined()
    expect(late.positional).toEqual(['hello', 'daemon'])
    expect(late.rest).toEqual([])
  })

  it('a lone dash is stdin data: a value for --file and --params, a positional otherwise', () => {
    expect(parseArgs(['triggers', 'add', '--file', '-']).file).toBe('-')
    expect(parseArgs(['api', 'session.list', '--params', '-']).params).toBe('-')
    expect(parseArgs(['queue', 'k', '-']).positional).toEqual(['k', '-'])
  })

  it('-- stops parsing and passes the remainder through as positionals', () => {
    expect(parseArgs(['-p', '--', '--not-a-flag', '-x']).positional).toEqual(['--not-a-flag', '-x'])
  })
})

describe('parseArgs: every rejection says which check fired', () => {
  it.each([
    [['--bogus'], 'unknown flag --bogus'],
    [['-x'], 'unknown flag -x'],
    [['--profile'], '--profile needs a value'],
    [['--profile', '--preset', 'b'], '--profile needs a value'],
    [['--mode'], '--mode needs a value'],
    [['--mode', 'rpc'], '--mode must be one of text|json|stream-json|acp'],
    [['--format', 'yaml'], '--format must be one of agnes|sharegpt|claude-code'],
    [['--from', 'aider'], '--from must be one of claude-code|codex|pi|auto'],
    [['--permission', 'root'], '--permission must be one of read-only|workspace-write|full-access|default'],
    [['--model'], '--model expects <slot>=<route>/<model>'],
    [['--model', 'noequals'], '--model expects <slot>=<route>/<model>'],
    [['--model', 'primary=gateway'], '--model expects <slot>=<route>/<model>'],
    [['--model', '=gateway/x'], '--model expects <slot>=<route>/<model>'],
    [['--model', 'primary=/x'], '--model expects <slot>=<route>/<model>'],
    [['--model', 'primary=gateway/'], '--model expects <slot>=<route>/<model>'],
    [['--continue', '--resume', 'x'], '--continue and --resume are mutually exclusive'],
    // The empty string is the case a truthiness check would let through: `--continue --resume ''`
    // would then run the continue path while `resume` was set, and neither flag would mean what it
    // says. The exclusion is written against `!== undefined` for that reason, so it is pinned here.
    [['--continue', '--resume', ''], '--continue and --resume are mutually exclusive'],
    // The slot is a bare name, and the character class is what says so. Widened to anything at all,
    // `pri mary=r/m` and `a=b=c/d` both parse, and the wrong half of the argument ends up as the
    // slot a session's model is set on.
    [['--model', 'pri-mary=gateway/x'], '--model expects <slot>=<route>/<model>'],
    [['--model', 'pri mary=gateway/x'], '--model expects <slot>=<route>/<model>'],
    [['--model', 'primary.fast=gateway/x'], '--model expects <slot>=<route>/<model>'],
    [['--model', '1=gateway/x'], '--model expects <slot>=<route>/<model>'],
  ])('%j is rejected with %s', (argv, message) => {
    expect(throws(argv as string[]).message).toBe(message)
  })

  it.each([['tui'], ['acp']])('--max-budget is refused outside -p (%s)', (mode) => {
    expect(() => refuseTurnCapsOutsidePrint(parseArgs(['--max-budget', '1']), mode)).toThrow(
      '--max-budget is supported only with -p',
    )
    expect(() => refuseTurnCapsOutsidePrint(parseArgs(['-p', '--max-budget', '1']), 'print')).not.toThrow()
  })

  it('a rejection is a UsageError and carries exit code 2', () => {
    const e = throws(['--bogus'])
    expect(e).toBeInstanceOf(UsageError)
    expect(e.code).toBe(2)
  })

  // Inherited Object properties are not flags. `in` would say otherwise for all four of these, and
  // an inherited hit would either eat the next argument or write a function into the result.
  it.each([['toString'], ['constructor'], ['__proto__'], ['hasOwnProperty']])(
    '%s is a prompt word, not a flag lookup hit',
    (word) => {
      const p = parseArgs([word])
      expect(p.positional).toEqual([word])
      expect(p.rest).toEqual([])
      expect(Object.getPrototypeOf(p)).toBe(Object.prototype)
    },
  )

  it('--__proto__ is an unknown flag rather than a prototype write', () => {
    expect(throws(['--__proto__', '{}']).message).toBe('unknown flag')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

// resolveMode is a total function of four inputs. Every combination is listed with its expected
// answer written out, rather than a rule that could be the implementation restated.
const args = (o: Partial<ParsedArgs> = {}): ParsedArgs => ({ ...parseArgs([]), ...o })

describe('resolveMode', () => {
  it.each([
    [undefined, false, true, true, 'tui'],
    [undefined, false, true, false, 'print'],
    [undefined, false, false, true, 'print'],
    [undefined, false, false, false, 'print'],
    [undefined, true, true, true, 'print'],
    [undefined, true, true, false, 'print'],
    [undefined, true, false, true, 'print'],
    [undefined, true, false, false, 'print'],
    ['text', false, true, true, 'print'],
    ['text', true, true, true, 'print'],
    ['json', false, true, true, 'print'],
    ['json', true, true, true, 'print'],
    ['json', true, false, false, 'print'],
    ['acp', false, true, true, 'acp'],
    ['acp', true, true, true, 'acp'],
    ['acp', false, false, false, 'acp'],
    ['acp', true, false, false, 'acp'],
  ] as const)('mode=%s print=%s stdin=%s stdout=%s gives %s', (mode, print, stdin, stdout, expected) => {
    const p = args({ print, ...(mode ? { mode } : {}) })
    expect(resolveMode(p, { stdin, stdout })).toBe(expected)
  })

  it('the same answers hold when the flags come from a real argv', () => {
    expect(resolveMode(parseArgs([]), { stdin: true, stdout: true })).toBe('tui')
    expect(resolveMode(parseArgs([]), { stdin: false, stdout: true })).toBe('print')
    expect(resolveMode(parseArgs(['-p', 'x']), { stdin: true, stdout: true })).toBe('print')
    expect(resolveMode(parseArgs(['--mode', 'acp']), { stdin: true, stdout: true })).toBe('acp')
    expect(resolveMode(parseArgs(['acp']), { stdin: true, stdout: true })).toBe('acp')
  })
})

describe('usage', () => {
  it.each([
    'resume',
    'sessions',
    'export',
    'import',
    'doctor',
    'profile',
    'plugins',
    'dev',
    'package',
    'install',
    'consent',
    'stats',
    'config',
    'conformance',
    'daemon',
    'agh web',
    'agh start',
  ])('mentions %s', (c) => {
    expect(usage()).toContain(c)
  })

  it('does not list commands this build refuses, nor the removed --meta and --park', () => {
    expect(usage()).not.toMatch(/agh ext|mcp serve|serve model-api|--meta|--park/)
  })

  it('mentions every accepted flag spelling, so the grammar and the help text cannot drift', () => {
    const text = usage()
    expect(text.split('Advanced:')[0]).toContain('--agent <package#agent>')
    expect(text.split('Advanced:')[0]).not.toMatch(/--bundle|--preset|FDE/)
    expect(usage('zh-CN')).toContain('智能体')
    expect(usage('zh-CN')).toContain('应用恢复：agh app clear')
    for (const flag of [
      '--profile',
      '--preset',
      '--cwd',
      '--continue',
      '--resume',
      '--connect',
      '--model',
      '--mode',
      '--ephemeral',
      '--standalone',
      '--json',
      '--format',
      '--html',
      '--raw',
      '--from',
      '--key',
      '--resolved',
      '--version',
      '--help',
    ])
      expect(text, flag).toContain(flag)
  })
})

it('selects a versioned loop, including a scoped id, and refuses missing versions or resume overrides', () => {
  expect(parseArgs(['-p', 'hello', '--loop', '@example/dag@1.0.0']).loop).toEqual({
    id: '@example/dag',
    version: '1.0.0',
  })
  for (const argv of [
    ['--loop'],
    ['--loop', 'dag'],
    ['--loop', 'dag@'],
    ['--continue', '--loop', 'dag@1'],
    ['resume', 'id', '--loop', 'dag@1'],
  ])
    expect(() => parseArgs(argv)).toThrow(UsageError)
})

it('recognizes help before forwarding commands and leaves stdio arguments as data', () => {
  for (const command of [
    'serve',
    'web',
    'start',
    'mcp',
    'skills',
    'resources',
    'daemon',
    'ext',
    'plugins',
    'package',
    'install',
    'doctor',
    'config',
  ]) {
    expect(parseArgs([command, '--help']).help, command).toBe(true)
    expect(parseArgs([command, 'test', '--help']).help, command).toBe(true)
  }
  expect(parseArgs(['mcp', 'add', 'example', '--arg', '--help']).help).toBe(false)
  expect(parseArgs(['mcp', 'serve', '--', '--help']).help).toBe(false)
  expect(parseArgs(['install', 'file:./example', '--yes']).yes).toBe(true)
})

it('keeps candidate review digests supplied by the human instead of selecting the latest draft', () => {
  const candidateHash = 'sha256-' + 'a'.repeat(64),
    reviewHash = 'sha256-' + 'b'.repeat(64)
  expect(
    parseArgs([
      'plugins',
      'candidates',
      'approve',
      'candidate-' + 'c'.repeat(32),
      '--candidate-hash',
      candidateHash,
      '--review-hash',
      reviewHash,
    ]),
  ).toMatchObject({ command: 'plugins', candidateHash, reviewHash })
  for (const flag of ['--candidate-hash', '--review-hash'])
    expect(() => parseArgs(['plugins', 'candidates', 'approve', flag])).toThrow(UsageError)
})

it('selects an explicit agent without exposing bundle knowledge and refuses conflicting or resumed targets', () => {
  expect(parseArgs(['-p', 'hello', '--agent', '@acme/kit#review']).agent).toBe('@acme/kit#review')
  for (const argv of [
    ['--agent'],
    ['--agent', 'missing-ref'],
    ['--agent', '@acme/kit#review', '--loop', 'dag@1'],
    ['--agent', '@acme/kit#review', '--preset', 'safe'],
    ['--agent', '@acme/kit#review', '--permission', 'read-only'],
    ['--continue', '--agent', '@acme/kit#review'],
    ['tools', '--session', 'existing', '--agent', '@acme/kit#review'],
  ])
    expect(() => parseArgs(argv)).toThrow()
})
