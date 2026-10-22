import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMANDS, parseArgs } from '../src/args.js'
import { type MainIO, main } from '../src/bin.js'
import { commandHelp } from '../src/command-help.js'
import { completeSessions } from '../src/commands/complete.js'
import { completionScript } from '../src/commands/completion.js'
import { completionSpec, SHELLS } from '../src/completion-spec.js'

const spec = completionSpec()
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function run(argv: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agh-completion-'))
  dirs.push(dir)
  let out = ''
  let err = ''
  const stdout = new PassThrough().on('data', (b) => {
    out += String(b)
  })
  const stderr = new PassThrough().on('data', (b) => {
    err += String(b)
  })
  const io: MainIO = {
    env: { AGH_HOME: join(dir, 'home'), HOME: dir, ...env },
    stdin: new PassThrough(),
    stdout,
    stderr,
    cwd: dir,
    agnesVersion: '9.9.9',
  }
  return { dir, io, result: main(argv, io), out: () => out, err: () => err }
}

describe('completion table', () => {
  it('has an entry for every command and every flag the parser reads', () => {
    expect(spec.commands).toEqual(expect.arrayContaining([...COMMANDS]))
    for (const flag of spec.flags) {
      const given = spec.valueFlags.includes(flag) ? [flag, spec.enums[flag]?.[0] ?? 'x'] : [flag]
      // --include and --skip belong to doctor's grammar.
      const argv = flag === '--include' || flag === '--skip' ? ['doctor', ...given] : given
      try {
        parseArgs(argv)
      } catch (error) {
        expect((error as Error).message).not.toMatch(/unknown flag/)
      }
    }
  })

  it('lists only verbs that the command help names', () => {
    for (const [command, verbs] of Object.entries(spec.subcommands)) {
      const help = commandHelp(command as never)
      const present = new Set(help.split(/[^A-Za-z0-9-]+/))
      for (const verb of verbs) expect(present.has(verb), `${command} ${verb}`).toBe(true)
    }
  })
})

describe('agh completion', () => {
  it.each(SHELLS)('prints the %s script', (shell) => {
    expect(completionScript(shell)).toMatchSnapshot()
  })

  it('prints to stdout and refuses an unknown shell with exit 2', async () => {
    const ok = run(['completion', 'bash'])
    expect(await ok.result).toBe(0)
    expect(ok.out()).toBe(completionScript('bash'))
    const bad = run(['completion', 'powershell'])
    expect(await bad.result).toBe(2)
    expect(bad.out()).toBe('')
  })
})

describe('real shells load the script', () => {
  // `eval "$(...)"` rather than `source <(...)`: macOS ships bash 3.2, which cannot source a process substitution.
  const bash = (line: string, extra = '') =>
    spawnSync(
      'bash',
      [
        '-c',
        `${extra}\neval "$(cat)"\nCOMP_LINE='${line}'; COMP_POINT=\${#COMP_LINE}; _agh; printf '%s\\n' "\${COMPREPLY[@]}"`,
      ],
      { input: completionScript('bash'), encoding: 'utf8' },
    )
      .stdout.split('\n')
      .filter(Boolean)

  it('bash completes commands, verbs, enum values and flags', () => {
    expect(bash('agh sess')).toEqual(['sessions'])
    expect(bash('agh sessions ar')).toEqual(['archive'])
    expect(bash('agh --mode ')).toEqual(['text', 'json', 'stream-json', 'acp'])
    expect(bash('agh --no-al')).toEqual(['--no-alt-screen'])
    expect(bash('agh completion z')).toEqual(['zsh'])
  })

  it('bash completes session keys through the hidden command, dropping the colon-split prefix', () => {
    const fake = `agh() { printf 'agnes:local:p:1\\tfirst\\nagnes:local:p:2\\tsecond\\n'; }`
    expect(bash('agh --resume agnes:local:p:', fake)).toEqual(['1', '2'])
    expect(bash('agh resume ', fake)).toEqual(['agnes:local:p:1', 'agnes:local:p:2'])
  })

  it('zsh completes commands and session keys', () => {
    const zsh = (words: string, current: number, extra = '') =>
      spawnSync(
        'zsh',
        [
          '-f',
          '-c',
          `compadd() { if [[ $1 == -d ]]; then print -l -- "\${(P)4}"; else print -l -- "$@"; fi }; compdef() { }; ${extra}\neval "$(cat)"\nwords=(${words}); CURRENT=${current}; _agh`,
        ],
        { input: completionScript('zsh'), encoding: 'utf8' },
      )
        .stdout.split('\n')
        .filter((line) => line !== '' && line !== '--')
    expect(zsh('agh ""', 2)).toContain('sessions')
    expect(zsh('agh --mode ""', 3)).toEqual(['text', 'json', 'stream-json', 'acp'])
    expect(zsh('agh sessions ""', 3)).toContain('archive')
    const fake = `agh() { printf 'k1\\tfirst\\n'; }`
    expect(zsh('agh resume ""', 3, fake)).toEqual(expect.arrayContaining(['k1']))
  })
})

describe('agh __complete sessions', () => {
  const rows = [
    { sessionId: 'a:1', title: 'plain' },
    { sessionId: 'a:2', title: 'bad\x1b[31m\ttitle\u009b' },
    { sessionId: 'b:3', title: 'other' },
    { sessionId: 'a:4', title: 'gone', archived: true },
  ]

  it('filters by prefix, drops archived rows and strips control characters from titles', async () => {
    const lines = await completeSessions('a:', async () => rows)
    expect(lines).toEqual(['a:1\tplain', 'a:2\tbad [31m title '])
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none remain
    expect(lines.join('')).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
  })

  it('prints nothing on timeout or failure', async () => {
    const started = Date.now()
    expect(await completeSessions('', () => new Promise(() => undefined), 50)).toEqual([])
    expect(Date.now() - started).toBeLessThan(1000)
    expect(
      await completeSessions('', async () => {
        throw new Error('boom')
      }),
    ).toEqual([])
  })

  it('prints nothing and starts nothing when no daemon runs', async () => {
    const r = run(['__complete', 'sessions', ''])
    expect(await r.result).toBe(0)
    expect(r.out()).toBe('')
    expect(readdirSync(r.dir)).toEqual([])
  })
})
