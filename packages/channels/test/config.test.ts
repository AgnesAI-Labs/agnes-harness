import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelManifest } from '@agnes/protocol'
import { createPrivateFileSync } from '@agnes/system-node'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, loadSecrets, redact } from '../src/runner/config.js'
import { FAKE_MANIFEST } from '../testkit/index.js'

const temporaryDirectories: string[] = []

function write(name: string, text: string, mode = 0o600): string {
  const directory = mkdtempSync(join(tmpdir(), 'agnes-channel-config-'))
  temporaryDirectories.push(directory)
  const path = join(directory, name)
  const file = createPrivateFileSync(path)
  try {
    writeFileSync(file, text)
  } finally {
    closeSync(file)
  }
  chmodSync(path, mode)
  return path
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('loadConfig', () => {
  it('loads explicit Windows daemon scope without interpreting tenant or agent as profile', async () => {
    const path = write(
      'windows.yaml',
      [
        'channel: fake',
        "connect: 'unix:\\\\.\\pipe\\agnes-test'",
        'tenant: tenant-1',
        'agent: sales',
        'credentialsFile: fake.env',
        'localDaemon:',
        "  home: 'D:\\中文 空格'",
        '  profile: local-dev',
        "  dataDir: 'D:\\data'",
      ].join('\n'),
    )
    await expect(loadConfig(path)).resolves.toMatchObject({
      connect: { kind: 'unix', path: '\\\\.\\pipe\\agnes-test' },
      localDaemon: { home: 'D:\\中文 空格', profile: 'local-dev', dataDir: 'D:\\data' },
      tenant: 'tenant-1',
      agent: 'sales',
    })
  })
  it.each([
    'null',
    '[]',
    'false',
    '{ profile: 42 }',
    '{ home: "" }',
    '{ dataDir: " " }',
    '{ profille: wrong }',
  ])('rejects invalid localDaemon %s', async (value) => {
    const path = write(
      'invalid-local.yaml',
      `channel: fake\nconnect: 'unix:\\\\.\\pipe\\agnes-test'\ntenant: t\nagent: a\ncredentialsFile: x\nlocalDaemon: ${value}\n`,
    )
    await expect(loadConfig(path)).rejects.toMatchObject({ code: 'E_CONFIG_INVALID' })
  })
  it.each(['unix:/tmp/a', 'wss://host/ws'])('rejects localDaemon on %s', async (connect) => {
    const path = write(
      'wrong-target.yaml',
      `channel: fake\nconnect: ${connect}\ntenant: t\nagent: a\ncredentialsFile: x\nlocalDaemon: {}\n`,
    )
    await expect(loadConfig(path)).rejects.toMatchObject({
      code: 'E_CONFIG_INVALID',
      detail: { key: 'localDaemon' },
    })
  })
  it('loads YAML, parses a unix connection and applies every default', async () => {
    const path = write(
      'runner.yaml',
      [
        'channel: fake',
        'connect: unix:/tmp/agnesd.sock',
        'tenant: tenant-1',
        'agent: sales',
        'credentialsFile: /etc/agnes/channels/fake.env',
      ].join('\n'),
    )

    await expect(loadConfig(path)).resolves.toEqual({
      channel: 'fake',
      connect: { kind: 'unix', path: '/tmp/agnesd.sock' },
      tenant: 'tenant-1',
      agent: 'sales',
      credentialsFile: '/etc/agnes/channels/fake.env',
      allowFrom: [],
      requireMention: true,
      ackReaction: 'group-mentions',
      workspace: process.cwd(),
      outbound: { costLine: true },
      directory: { sync: 'every 15m' },
      healthz: { enabled: true, port: 9877 },
    })
  })

  it('parses wss and preserves explicit false values and nested YAML', async () => {
    const path = write(
      'runner.yaml',
      [
        'channel: fake',
        'connect: wss://daemon.example/agnes',
        'tenant: tenant-1',
        'agent: sales',
        'credentialsFile: ./fake.env',
        'allowFrom:',
        '  - u1',
        '  - u2',
        'requireMention: false',
        'ackReaction: off',
        'workspace: /srv/agnes',
        'outbound:',
        '  costLine: false',
        'directory:',
        '  sync: false',
        'healthz:',
        '  enabled: false',
        '  port: 8080',
      ].join('\n'),
    )

    await expect(loadConfig(path)).resolves.toMatchObject({
      connect: { kind: 'ws', url: 'wss://daemon.example/agnes' },
      allowFrom: ['u1', 'u2'],
      requireMention: false,
      ackReaction: 'off',
      workspace: '/srv/agnes',
      outbound: { costLine: false },
      directory: { sync: false },
      healthz: { enabled: false, port: 8080 },
    })
  })

  it('accepts port zero for an ephemeral loopback health listener', async () => {
    const path = write(
      'ephemeral-health.yaml',
      [
        'channel: fake',
        'connect: unix:/tmp/agnesd.sock',
        'tenant: tenant-1',
        'agent: sales',
        'credentialsFile: ./fake.env',
        'healthz: { enabled: true, port: 0 }',
      ].join('\n'),
    )

    await expect(loadConfig(path)).resolves.toMatchObject({
      healthz: { enabled: true, port: 0 },
    })
  })

  it.each([
    ['connect', 'channel: fake\ntenant: t\nagent: a\ncredentialsFile: x\n'],
    ['tenant', 'channel: fake\nconnect: unix:/tmp/a\nagent: a\ncredentialsFile: x\n'],
    ['agent', 'channel: fake\nconnect: unix:/tmp/a\ntenant: t\ncredentialsFile: x\n'],
    ['credentialsFile', 'channel: fake\nconnect: unix:/tmp/a\ntenant: t\nagent: a\n'],
  ])('rejects a missing %s', async (key, yaml) => {
    await expect(loadConfig(write('missing.yaml', yaml))).rejects.toMatchObject({
      code: 'E_CONFIG_INVALID',
      detail: { key },
    })
  })

  it.each([
    ['an unsupported connection', 'connect: http://daemon.example'],
    ['an empty unix path', 'connect: "unix:"'],
    ['a coercible boolean', 'requireMention: "false"'],
    ['an invalid ack policy', 'ackReaction: mentions'],
    ['a scalar allow-list', 'allowFrom: u1'],
    ['an invalid health port', 'healthz: { enabled: true, port: 70000 }'],
    ['an invalid nested value', 'outbound: { costLine: no }'],
  ])('rejects %s instead of coercing it', async (_name, override) => {
    const yaml = [
      'channel: fake',
      'connect: unix:/tmp/agnesd.sock',
      'tenant: t',
      'agent: a',
      'credentialsFile: x',
      override,
    ].join('\n')
    await expect(loadConfig(write('invalid.yaml', yaml))).rejects.toMatchObject({
      code: 'E_CONFIG_INVALID',
    })
  })

  it('normalizes unreadable and malformed YAML as E_CONFIG_INVALID', async () => {
    await expect(loadConfig(join(tmpdir(), 'agnes-channel-does-not-exist.yaml'))).rejects.toMatchObject({
      code: 'E_CONFIG_INVALID',
    })
    await expect(loadConfig(write('malformed.yaml', 'channel: [unterminated'))).rejects.toMatchObject({
      code: 'E_CONFIG_INVALID',
    })
    await expect(loadConfig(write('sequence.yaml', '- channel\n- fake\n'))).rejects.toMatchObject({
      code: 'E_CONFIG_INVALID',
    })
  })
})

describe('loadSecrets', () => {
  const manifest: ChannelManifest = {
    ...FAKE_MANIFEST,
    credentials: {
      required: ['clientId', 'clientSecret'],
      optional: ['robotCode'],
      exposes: [],
    },
  }

  it('loads KEY=VALUE without treating comments or equals in values as syntax', async () => {
    const path = write('credentials.env', 'clientId=app-id\nclientSecret=a=b=c\n# ignored\nrobotCode=robot\n')
    await expect(loadSecrets(path, manifest)).resolves.toEqual({
      clientId: 'app-id',
      clientSecret: 'a=b=c',
      robotCode: 'robot',
    })
  })

  it('loads a JSON object whose values are strings', async () => {
    const path = write('credentials.json', '{"clientId":"app-id","clientSecret":"secret"}')
    await expect(loadSecrets(path, manifest)).resolves.toEqual({
      clientId: 'app-id',
      clientSecret: 'secret',
    })
  })

  it.runIf(typeof process.getuid === 'function')(
    'rejects group/world-readable modes but not an owner-only mode',
    async () => {
      for (const mode of [0o644, 0o620, 0o602]) {
        await expect(
          loadSecrets(write(`loose-${mode.toString(8)}.env`, 'clientId=a\nclientSecret=b\n', mode), manifest),
        ).rejects.toMatchObject({ code: 'E_SECRETS_UNREADABLE' })
      }
      await expect(
        loadSecrets(write('private.env', 'clientId=a\nclientSecret=b\n', 0o600), manifest),
      ).resolves.toMatchObject({ clientId: 'a' })
    },
  )

  it.each([
    ['missing a required key', 'clientId=app-id\n'],
    ['having an empty required value', 'clientId=app-id\nclientSecret=\n'],
    ['having a malformed env line', 'clientId=app-id\nclientSecret=secret\nnot-an-assignment\n'],
    ['having a duplicate env key', 'clientId=first\nclientId=second\nclientSecret=secret\n'],
    ['having a non-string JSON value', '{"clientId":"app-id","clientSecret":42}'],
    ['being a JSON array', '["clientId","clientSecret"]'],
  ])('fails closed when %s', async (_name, contents) => {
    await expect(loadSecrets(write('invalid.secret', contents), manifest)).rejects.toMatchObject({
      code: 'E_SECRETS_UNREADABLE',
    })
  })

  it('normalizes a missing file as E_SECRETS_UNREADABLE', async () => {
    await expect(
      loadSecrets(join(tmpdir(), 'agnes-channel-secrets-do-not-exist'), manifest),
    ).rejects.toMatchObject({ code: 'E_SECRETS_UNREADABLE' })
  })

  it.runIf(process.platform === 'win32')('rejects a broadly readable Windows credential file', async () => {
    const path = write('loose.env', 'clientId=a\nclientSecret=private-value\n')
    const systemRoot = process.env.SystemRoot
    if (!systemRoot) throw new Error('SystemRoot missing')
    execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [path, '/grant', '*S-1-1-0:R'], {
      windowsHide: true,
    })
    await expect(loadSecrets(path, manifest)).rejects.toMatchObject({ code: 'E_SECRETS_UNREADABLE' })
  })

  it('does not include credential text in malformed JSON diagnostics', async () => {
    const secret = 'private-marker-that-must-not-be-logged'
    const path = write('invalid.json', `{${secret}}`)
    try {
      await loadSecrets(path, manifest)
      throw new Error('expected malformed JSON rejection')
    } catch (error) {
      expect(error).toMatchObject({ code: 'E_SECRETS_UNREADABLE' })
      expect(String(error)).toContain('invalid JSON')
      expect(String(error)).not.toContain(secret)
    }
  })

  it('redacts every secret of at least four characters, longest first', () => {
    const secrets = { short: 'abc', token: 'secret', larger: 'secret-value' }
    expect(redact(secrets, 'abc secret-value secret')).toBe('abc *** ***')
  })
})
