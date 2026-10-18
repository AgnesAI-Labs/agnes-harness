import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeHome } from '@agnes/host'
import { type DoctorProbe, runDoctor } from '@agnes/host-infrastructure/doctor'
import { validateMethod } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'

const homes: string[] = []
const home = () => {
  const path = mkdtempSync(join(tmpdir(), 'agh-runtime-doctor-'))
  homes.push(path)
  initializeHome(path)
  return path
}
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true })
})
const account = {
  accountId: 'fixture',
  providerId: 'deepseek',
  route: 'fixture',
  label: 'PRIVATE LABEL',
  baseUrl: 'https://private.invalid',
  model: 'fixture-model',
  models: [],
  enabled: true,
  credentialConfigured: true,
}
const configuration = (test: () => Promise<unknown>) =>
  ({ get: async () => ({ accounts: [account] }), test }) as never
const good: DoctorProbe = async () => ({ status: 'ok' })
const probes = {
  node: good,
  native: good,
  home: good,
  permissions: good,
  credentials: good,
  sandbox: good,
  connection: good,
  disk: good,
  plugins: good,
  mcp: good,
}

it('does not contact model services without explicit consent and emits only safe schema evidence', async () => {
  let contacted = false
  const config = configuration(async () => {
    contacted = true
    return { verified: true }
  })
  const report = await runDoctor({ home: home(), profile: 'local-dev', configuration: config, probes })
  expect(contacted).toBe(false)
  expect(report.checks.find((check) => check.id === 'accounts')).toMatchObject({
    status: 'ok',
    count: 1,
    probed: false,
  })
  expect(validateMethod('_agnes/v1/doctor.run', 'result', report).ok).toBe(true)
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE LABEL|private.invalid|fixture-model/)
  const tested = await runDoctor({
    home: home(),
    profile: 'local-dev',
    configuration: config,
    probes,
    probeAccounts: true,
  })
  expect(contacted).toBe(true)
  expect(tested.checks.find((check) => check.id === 'accounts')).toMatchObject({ status: 'ok', probed: true })
})
it('keeps independent failures, redacts exception bodies and continues after a failed native probe', async () => {
  const report = await runDoctor({
    home: home(),
    profile: 'local-dev',
    configuration: configuration(async () => {
      throw new Error('SENSITIVE UPSTREAM BODY')
    }),
    probeAccounts: true,
    probes: {
      ...probes,
      native: async () => {
        throw new Error('PRIVATE PATH')
      },
    },
  })
  expect(report.status).toBe('fail')
  expect(report.checks.filter((check) => check.status === 'fail').map((check) => check.id)).toEqual([
    'native',
    'accounts',
  ])
  expect(report.checks.find((check) => check.id === 'mcp')).toMatchObject({ status: 'ok' })
  expect(JSON.stringify(report)).not.toMatch(/SENSITIVE|UPSTREAM|PRIVATE|PATH/)
})
it.skipIf(process.platform === 'win32')(
  'reports unsafe credential metadata without opening its contents',
  async () => {
    const root = home()
    writeFileSync(join(root, 'secrets', 'synthetic.txt'), 'PRIVATE KEY', { mode: 0o644 })
    chmodSync(join(root, 'secrets', 'synthetic.txt'), 0o644)
    const { permissions: _permissions, ...safeProbes } = probes
    const report = await runDoctor({
      home: root,
      profile: 'local-dev',
      configuration: configuration(async () => ({ verified: true })),
      probes: safeProbes,
    })
    expect(report.checks.find((check) => check.id === 'permissions')).toMatchObject({ status: 'fail' })
    expect(JSON.stringify(report)).not.toContain('PRIVATE KEY')
  },
)

it('propagates cancellation to an explicitly requested account probe', async () => {
  const cancel = new AbortController()
  let probeSignal: AbortSignal | undefined
  const config = {
    get: async () => ({ accounts: [account] }),
    test: async (_input: unknown, signal?: AbortSignal) => {
      probeSignal = signal
      cancel.abort()
      signal?.throwIfAborted()
      return { verified: true }
    },
  } as never
  await expect(
    runDoctor({
      home: home(),
      profile: 'local-dev',
      configuration: config,
      probes,
      probeAccounts: true,
      signal: cancel.signal,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(probeSignal?.aborted).toBe(true)
})

it('warns for unavailable account credentials without probing or disclosing secrets', async () => {
  const { credentials: _credentials, ...safeProbes } = probes
  const config = {
    get: async () => ({
      accounts: [{ ...account, credentialConfigured: false, credentialIssue: 'CONFIG_CREDENTIAL_REQUIRED' }],
    }),
    test: async () => {
      throw new Error('must not probe an unavailable account')
    },
  } as never
  const report = await runDoctor({
    home: home(),
    profile: 'local-dev',
    configuration: config,
    probes: safeProbes,
    probeAccounts: true,
  })
  expect(report.status).toBe('warn')
  expect(report.checks.filter((check) => check.status === 'warn').map((check) => check.id)).toEqual([
    'credentials',
    'accounts',
  ])
  expect(report.checks.find((check) => check.id === 'accounts')).toMatchObject({ probed: false })
  expect(JSON.stringify(report)).not.toMatch(/PRIVATE LABEL|private.invalid|fixture-model/)
  const partial = await runDoctor({
    home: home(),
    profile: 'local-dev',
    probes: safeProbes,
    probeAccounts: true,
    configuration: {
      get: async () => ({
        accounts: [account, { ...account, accountId: 'lost', credentialConfigured: false }],
      }),
      test: async () => ({ verified: false }),
    } as never,
  })
  // A missing key never masks a real failure on a different, usable account.
  expect(partial.checks.find((check) => check.id === 'accounts')).toMatchObject({
    status: 'fail',
    probed: true,
  })
})
