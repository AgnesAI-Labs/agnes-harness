import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCredentialStore } from '@agnes/host'
import { afterEach, expect, it } from 'vitest'
import type { StartSupervisorOptions } from '../src/supervisor/assembly-options.js'
import {
  secretEnvValues,
  storedSecretValues,
  telemetryCredentials,
} from '../src/supervisor/telemetry/production.js'
import { traceRedaction } from '../src/supervisor/telemetry/redaction.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const scrub = traceRedaction({
  installId: 'fixture-install',
  accounts: [],
  privatePaths: [],
  workspacePaths: [],
  sessionKeys: [],
  credentialValues: [],
}).scrub

const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
// Assembled at run time so the repository secret scan does not read the fixture as a real key.
const PEM = (edge: string) => `-----${edge} OPENSSH ${['PRIVATE', 'KEY'].join(' ')}-----`

it.each([
  ['DB_PASSWORD=hunter2', 'hunter2', 'DB_PASSWORD='],
  ['SMTP_PASS=mail-pass-99', 'mail-pass-99', 'SMTP_PASS='],
  ['export MYSQL_PWD="root pw"', 'root pw', 'MYSQL_PWD='],
  [`AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`, 'K7MDENG', 'AWS_SECRET_ACCESS_KEY='],
  ['STRIPE_WEBHOOK_SECRET: whsec_fixture', 'whsec_fixture', 'STRIPE_WEBHOOK_SECRET:'],
  ['github_token = ghx-fixture-value', 'ghx-fixture-value', 'github_token'],
  ['{"password": "hunter2", "user": "alice"}', 'hunter2', '"user": "alice"'],
  ["{'clientSecret': 'abc-def-123'}", 'abc-def-123', 'clientSecret'],
  ['apiKey: fixture-api-value', 'fixture-api-value', 'apiKey:'],
  ['x-api-key: fixture-header-value', 'fixture-header-value', 'x-api-key:'],
  ['ACCESS-KEY=AKfixturevalue', 'AKfixturevalue', 'ACCESS-KEY='],
  ['private_key: "fixture pk"', 'fixture pk', 'private_key:'],
  ['credentials=fixture-cred', 'fixture-cred', 'credentials='],
  ['AUTH=fixture-auth', 'fixture-auth', 'AUTH='],
  ['dbpassword=hunter2', 'hunter2', 'dbpassword='],
  ['Authorization: Token abc123def', 'abc123def', 'Authorization:'],
  ['authorization: Digest username="u", response="6629fae4"', '6629fae4', 'authorization:'],
  ['curl -H "Authorization: Bearer opaque.token.value" https://api.invalid', 'opaque.token.value', 'curl -H'],
  ['see postgres://admin:hunter2@db.internal:5432/app for details', 'hunter2', 'db.internal:5432/app'],
  ['redis://:s3cret@localhost:6379/0', 's3cret', 'localhost:6379/0'],
  [`${PEM('BEGIN')}\nb3BlbnNzaC1rZXktdjEAAAAA\n${PEM('END')}\nafter`, 'b3BlbnNzaC1rZXktdjEAAAAA', 'after'],
  [`the key is ${AWS_SECRET} today`, 'K7MDENG', 'the key is'],
  ['aws secret wJalrXUtnFEMI+K7MDENG+bPxRfiCYEXAMPLEKEY in a sentence', 'K7MDENG', 'in a sentence'],
])('redacts %j without dropping its context', (text, secret, kept) => {
  const clean = scrub(text)
  expect(clean).not.toContain(secret)
  expect(clean).toContain('<redacted>')
  expect(clean).toContain(kept)
})

it.each([
  'Implement the password reset flow before the token refresh work.',
  'The passport office opens at 9; bypass: none needed.',
  'Author: Jane Doe',
  'max_tokens: 4096 and input_tokens: 40',
  'Tests: 12 passed, 0 failed',
  'Set the secret santa budget in the spreadsheet.',
  'tokenizer: cl100k_base',
  'See https://docs.example.invalid/auth/login for the login page.',
  'const authorName = user.name',
  'Use PASSWORD_MIN_LENGTH to configure the policy.',
])('keeps ordinary text %j', (text) => {
  expect(scrub(text)).toBe(text)
})

it('collects every stored generic secret and secret-named environment values', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agh-telemetry-secrets-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const store = createCredentialStore({ root: home })
  const metadata = { label: 'fixture', createdAt: '2026-01-01T00:00:00.000Z' }
  await store.putGeneric(
    'secret://generic/0b6f3f0e-7c55-4d4b-9a2c-111111111111',
    'llm-sg-fixture-key',
    metadata,
  )
  await store.putGeneric(
    'secret://generic/0b6f3f0e-7c55-4d4b-9a2c-222222222222',
    'mcp-fixture-token',
    metadata,
  )
  expect([...(await storedSecretValues(home))].sort()).toEqual(['llm-sg-fixture-key', 'mcp-fixture-token'])
  const profile = {} as StartSupervisorOptions['profile']
  expect(
    [
      ...(await telemetryCredentials({ profile }, home, undefined, { RSI_TOKEN: 'fixture-env-token-1' })),
    ].sort(),
  ).toEqual(['fixture-env-token-1', 'llm-sg-fixture-key', 'mcp-fixture-token'])
  expect(await storedSecretValues(join(home, 'missing'))).toEqual([])

  expect(
    secretEnvValues({
      DB_PASSWORD: 'hunter22',
      SMTP_PASS: 'mailpass99',
      GITHUB_TOKEN: 'ghx-fixture-token',
      STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
      DEPLOY_KEY: 'deploy-fixture-key',
      OPENAI_API_KEY: 'openai-fixture-key',
      AGNES_SECRET_RSI: 'agnes-fixture-secret',
      SHORT_TOKEN: 'abc',
      PATH: '/usr/bin:/bin',
      HOME: '/srv/fixture',
      NODE_ENV: 'production',
      KEYBOARD_LAYOUT: 'us-international',
      TOKENIZERS_PARALLELISM: 'false-ish-value',
    }).sort(),
  ).toEqual([
    'agnes-fixture-secret',
    'deploy-fixture-key',
    'ghx-fixture-token',
    'hunter22',
    'mailpass99',
    'openai-fixture-key',
    'whsec_fixture',
  ])
})
