import { describe, expect, it } from 'vitest'
import {
  acceptedOptions,
  coveredByPrefixes,
  isBannedPrefix,
  looksLikeSecret,
  maskSecrets,
  offerPrefix,
  parsePrefixScope,
  prefixScope,
} from '../src/command-table/prefix.js'

describe('offerPrefix', () => {
  it.each<[string, string[] | undefined]>([
    ['git push origin main', ['git', 'push']],
    ['cargo test -p x', ['cargo', 'test']],
    ['git status', ['git', 'status']],
    ['ls', ['ls']],
    ['pnpm test', ['pnpm', 'test']],
    ['cd sub && git status', undefined],
    ['git status && git diff', undefined],
    ['git status && git status -s', ['git', 'status']],
    ['ls -la', undefined],
    ['git -c core.pager=x log', undefined],
    ['git', undefined],
    ['rm', undefined],
    ['rm -f x', undefined],
    ['npm --version', undefined],
    ['npm run build', undefined],
    ['pnpm dlx create-x', undefined],
    ['yarn exec x', undefined],
    ['bash -c ls', undefined],
    ['python3 -c "print(1)"', undefined],
    ['python3.12 script.py', undefined],
    ['node app.js', undefined],
    ['env FOO=1 ls', undefined],
    ['sudo ls', undefined],
    ['xargs ls', undefined],
    ['find . -name x', undefined],
    ['curl example.com', undefined],
    ['eval ls', undefined],
    ['git status; rm -rf /', undefined],
    ['git status > out', undefined],
    ['git status $(id)', undefined],
    ['git status\nls', undefined],
    ['npx foo', undefined],
    ['echo sk-abcdefghijklmnopqrstuvwx', undefined],
    ['tool sk-abcdefghijklmnopqrstuvwx', undefined],
    ['tool API_KEY=abc', undefined],
  ])('%j -> %j', (command, tokens) => {
    expect(offerPrefix(command)?.tokens).toEqual(tokens)
  })

  it('offers only what covers every uncovered part, counting existing prefixes', () => {
    expect(offerPrefix('git status && git diff', [['git', 'status']])?.tokens).toEqual(['git', 'diff'])
    expect(offerPrefix('git status', [['git', 'status']])).toBeUndefined()
  })

  it('does not offer a scope longer than 256 characters', () => {
    expect(offerPrefix(`tool ${'a'.repeat(300)}`)).toBeUndefined()
  })

  it('scope round-trips and rejects anything else', () => {
    const scope = prefixScope(['git', 'push'])
    expect(scope).toBe('shell:prefix:["git","push"]')
    expect(parsePrefixScope(scope)).toEqual(['git', 'push'])
    for (const bad of [
      'shell:prefix:[]',
      'shell:prefix:["a","b","c"]',
      'shell:prefix:[1]',
      'tool:shell:execute',
      'shell:prefix:["a\\nb"]',
      'shell:prefix: ["a"]',
    ])
      expect(parsePrefixScope(bad), bad).toBeUndefined()
  })
})

describe('coveredByPrefixes', () => {
  const git = [['git', 'status']]
  it.each<[string, boolean]>([
    ['git status', true],
    ['git status -s', true],
    ['git status && git status -s', true],
    ['git statusx', false],
    ['git status; rm -rf /', false],
    ['git status && ls', false],
    ['git status | cat', false],
    ['git status > f', false],
    ['git status $(id)', false],
    ['git status `id`', false],
    ['git status\nrm x', false],
    ['git stat', false],
    ['git', false],
    ['FOO=1 git status', false],
    ['exec git status', false],
  ])('%j -> %j', (command, expected) => {
    expect(coveredByPrefixes(command, git)).toBe(expected)
  })

  it('never covers a hard-blocked command', () => {
    expect(coveredByPrefixes('rm -rf /', [['rm']])).toBe(false)
  })
})

describe('secrets', () => {
  it.each([
    'sk-abc123',
    'ghp_abcdef',
    'AKIAABCDEFGH1234',
    'Bearer',
    'API_KEY=zzz',
    'aB3dE5gH7jK9mN1pQ3sT5vW7yZ',
  ])('flags %j', (token) => expect(looksLikeSecret(token)).toBe(true))
  it.each(['status', 'origin', 'build', 'abcdefghijklmnopqrstuvwxyz', '--flag'])('keeps %j', (token) =>
    expect(looksLikeSecret(token)).toBe(false),
  )
  it('masks a command', () => {
    expect(maskSecrets('curl -H Bearer sk-abc123 API_KEY=zzz ok')).toEqual({
      text: 'curl -H *** *** API_KEY=*** ok',
      masked: true,
    })
    expect(maskSecrets('git status').masked).toBe(false)
  })
  it('bans prefixes carrying secrets', () => {
    expect(isBannedPrefix(['tool', 'sk-abc'])).toBe(true)
  })
})

describe('banned runners and subcommand programs', () => {
  it.each(
    'ssh scp rsync docker podman kubectl nerdctl chroot unshare nsenter flock stdbuf ionice chrt taskset script parallel busybox toybox gh'.split(
      ' ',
    ),
  )('never offers %s', (program) => {
    expect(offerPrefix(`${program} run x`)).toBeUndefined()
    expect(isBannedPrefix([program, 'run'])).toBe(true)
  })

  it.each([
    'git',
    'npm',
    'pnpm',
    'yarn',
    'bun',
    'cargo',
    'go',
    'pip',
    'pip3',
    'uv',
    'make',
    'poetry',
    'bundle',
    'mvn',
  ])('needs a subcommand for %s', (program) => {
    expect(offerPrefix(program)).toBeUndefined()
    expect(offerPrefix(`${program} --version`)).toBeUndefined()
    expect(isBannedPrefix([program])).toBe(true)
  })

  it.each(['ls', 'cat', 'grep', 'wc', 'echo'])('lets read-only %s stand alone', (program) => {
    expect(offerPrefix(program)?.tokens).toEqual([program])
  })

  it.each([
    'uv run',
    'cargo run',
    'go run',
    'poetry run',
    'pipenv run',
    'bundle exec',
    'git foreach',
    'deno eval',
    'dotnet tool',
    'gradle run',
    'hatch shell',
    'npm run-script',
  ])('never offers the run-style subcommand %s', (prefix) => {
    expect(offerPrefix(`${prefix} payload`)).toBeUndefined()
    expect(isBannedPrefix(prefix.split(' '))).toBe(true)
  })

  it.each(
    'tsx ts-node java Rscript tclsh expect sqlite3 psql vim nvim emacs sed less man uvx pipx'.split(' '),
  )('never offers the code runner %s', (program) => {
    expect(offerPrefix(`${program} build x`)).toBeUndefined()
    expect(isBannedPrefix([program, 'build'])).toBe(true)
  })

  it('offers program plus subcommand for the ordinary subcommand programs', () => {
    expect(offerPrefix('cargo test')?.tokens).toEqual(['cargo', 'test'])
    expect(offerPrefix('go vet ./...')?.tokens).toEqual(['go', 'vet'])
    expect(offerPrefix('uv sync')?.tokens).toEqual(['uv', 'sync'])
  })

  it('never honours a banned scope that was stored earlier', () => {
    for (const tokens of [['ssh', 'host'], ['git'], ['bash'], ['npm', 'run'], ['gh', 'api']]) {
      const scope = prefixScope(tokens)
      expect(parsePrefixScope(scope), scope).toBeUndefined()
      expect(
        acceptedOptions({
          purpose: 'tool.permission',
          options: ['allowed-once'],
          subject: { prefixGrant: { tokens, scope } },
        }),
      ).toEqual(['allowed-once'])
    }
    expect(coveredByPrefixes('ssh host', [['ssh', 'host']])).toBe(false)
    expect(coveredByPrefixes('git status', [['git']])).toBe(false)
  })
})
