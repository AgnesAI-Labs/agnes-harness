import { describe, expect, it } from 'vitest'
import { type ParsedArgs, parseArgs, resolveMode, usage } from '../src/args.js'
import { UsageError } from '../src/errors.js'

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

  it('-p with the one-shot flags', () => {
    const p = parseArgs(['-p', 'hi', '--mode', 'json', '--park', '--meta', '--ephemeral', '--standalone'])
    expect(p).toMatchObject({
      print: true,
      mode: 'json',
      park: true,
      meta: true,
      ephemeral: true,
      standalone: true,
      positional: ['hi'],
    })
  })

  it('--mode selects the one-shot form on its own, for both of its printing values', () => {
    expect(parseArgs(['--mode', 'json']).print).toBe(true)
    expect(parseArgs(['--mode', 'text']).print).toBe(true)
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
      meta: false,
      ephemeral: false,
      json: false,
      html: false,
      raw: false,
      repair: false,
      upgrade: false,
      resolved: false,
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
    [['--mode', 'rpc'], '--mode must be one of text|json|acp'],
    [['--format', 'yaml'], '--format must be one of agnes|sharegpt|claude-code'],
    [['--from', 'aider'], '--from must be one of claude-code|codex|pi|auto'],
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
    'package',
    'install',
    'consent',
    'stats',
    'config',
    'conformance',
    'daemon',
    'ext',
    'mcp serve',
    'serve model-api',
  ])('mentions %s', (c) => {
    expect(usage()).toContain(c)
  })

  it('mentions every accepted flag spelling, so the grammar and the help text cannot drift', () => {
    const text = usage()
    for (const flag of [
      '--profile',
      '--preset',
      '--cwd',
      '--continue',
      '--resume',
      '--connect',
      '--model',
      '--mode',
      '--park',
      '--meta',
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
