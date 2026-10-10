import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  JevConfigSaveInput,
  JevConfigSnapshot,
  JevConfigTestInput,
  JevConfigTestResult,
  JevSettings,
} from '@agnes/protocol'
import { jcs, validateAgainst } from '@agnes/protocol'
import {
  JevConfigSaveInput as SaveSchema,
  JevSettings as SettingsSchema,
  JevConfigTestInput as TestSchema,
} from '@agnes/protocol/gen/agnes-v1'
import { renameWriteThrough, windowsEnsurePrivateDirectorySync } from '@agnes/system-node'
import { createCredentialStore } from './adapters/credential-store.js'
import { createWin32Platform } from './adapters/platform.js'
import { withConfigurationLock } from './configuration-lock.js'
import { type JevEnvironmentConfiguration, jevFromEnvironment } from './runtime/catalog.js'
import type { JevDecisionTarget } from './runtime/jev-decision-pool.js'
import { createJevDecisionTransport } from './runtime/jev-transport.js'

export interface JevConfigurationService {
  get(): Promise<JevConfigSnapshot>
  test(input: JevConfigTestInput): Promise<JevConfigTestResult>
  save(input: JevConfigSaveInput): Promise<JevConfigSnapshot>
  capture(): Promise<JevConfigurationCapture>
}
/** Trusted boot metadata only; credentials are resolved in the worker, not put in its bootstrap. */
type Backend = 'jev' | 'laya'
type CapturedBackend = { settings: JevSettings; credentialRef: string | null }
export type JevConfigurationCapture = {
  version: 1 | 2
  revision: number
  settings: JevSettings | null
  credentialRef: string | null
  backends?: Partial<Record<Backend, CapturedBackend>>
}
function captureBackends(capture: JevConfigurationCapture): Partial<Record<Backend, CapturedBackend>> {
  if (capture.backends) return capture.backends
  return capture.settings
    ? {
        [capture.settings.backend ?? 'jev']: {
          settings: capture.settings,
          credentialRef: capture.credentialRef,
        },
      }
    : {}
}
const FILE = 'jev-configuration.json'
const MAX_BYTES = 64 * 1024
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const failure = (code: string): Error => Object.assign(new Error('Jev configuration failed.'), { code })

export function normalizeJevSettings(value: unknown): JevSettings {
  const checked = validateAgainst<JevSettings>(SettingsSchema, value)
  if (!checked.ok) throw failure('CONFIG_INVALID_INPUT')
  const settings = structuredClone(checked.value)
  settings.backend ??= 'jev'
  if (settings.backend === 'laya' && settings.transport !== 'native')
    throw failure('CONFIG_JEV_TRANSPORT_MISMATCH')
  let url: URL
  try {
    url = new URL(settings.endpoint)
  } catch {
    throw failure('CONFIG_INVALID_INPUT')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    settings.endpoint !== settings.endpoint.trim() ||
    /[\p{Cc}\s]/u.test(settings.model)
  )
    throw failure('CONFIG_INVALID_INPUT')
  if (settings.transport === 'cloudflare') {
    if (
      !settings.accountId ||
      settings.authentication !== 'bearer' ||
      settings.endpoint !== `https://api.cloudflare.com/client/v4/accounts/${settings.accountId}/ai/run`
    )
      throw failure('CONFIG_INVALID_INPUT')
  } else if (settings.accountId !== undefined) throw failure('CONFIG_INVALID_INPUT')
  else if (
    url.hostname === 'api.cloudflare.com' &&
    /^\/client\/v4\/accounts\/[^/]+\/ai\/run$/.test(url.pathname)
  )
    throw failure('CONFIG_JEV_TRANSPORT_MISMATCH')
  for (const credits of [settings.decisionRequestCredits, settings.languageRequestCredits])
    if (credits !== undefined && (!Number.isFinite(credits) || credits <= 0))
      throw failure('CONFIG_INVALID_INPUT')
  return settings
}

const windowsDirectories = createWin32Platform().matches()

async function privateDirectory(path: string): Promise<void> {
  if (windowsDirectories) {
    windowsEnsurePrivateDirectorySync(path)
    return
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw failure('CONFIG_PERSIST_FAILED')
    await handle.chmod(0o700)
  } finally {
    await handle.close()
  }
}

async function readCapture(path: string, prefix: string): Promise<JevConfigurationCapture> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { version: 1, revision: 0, settings: null, credentialRef: null }
    throw failure('CONFIG_INVALID_STATE')
  }
  try {
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      stat.size > MAX_BYTES ||
      (!windowsDirectories && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
    )
      throw failure('CONFIG_INVALID_STATE')
    const bytes = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const part = await handle.read(bytes, length, bytes.length - length)
      if (!part.bytesRead) break
      length += part.bytesRead
    }
    if (length > MAX_BYTES) throw failure('CONFIG_INVALID_STATE')
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)),
    )
    if (!object(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1)
      throw failure('CONFIG_INVALID_STATE')
    return decodeCapture(value, prefix)
  } catch {
    throw failure('CONFIG_INVALID_STATE')
  } finally {
    await handle.close()
  }
}

async function writeCapture(path: string, capture: JevConfigurationCapture): Promise<void> {
  const temporary = join(dirname(path), `.${FILE}.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.writeFile(`${JSON.stringify(capture)}\n`)
    await handle.sync()
    await handle.close()
    handle = undefined
    await renameWriteThrough(temporary, path, { noFollow: true })
  } catch {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw failure('CONFIG_PERSIST_FAILED')
  }
}

export function createJevConfigurationService(options: {
  home: string
  profile: string
  env?: NodeJS.ProcessEnv
  request?: typeof fetch
}): JevConfigurationService {
  if (!PROFILE.test(options.profile)) throw failure('CONFIG_INVALID_INPUT')
  const home = resolve(options.home)
  const profileDir = join(home, 'profiles', options.profile)
  const path = join(profileDir, FILE)
  const prefix = `secret://jev/profile-${createHash('sha256').update(options.profile).digest('hex').slice(0, 16)}-g`
  const store = createCredentialStore({ root: home })
  const env = options.env ?? process.env
  const request = options.request ?? fetch
  let bootRevision: number | undefined
  const capture = async () => {
    const state = await readCapture(path, prefix)
    bootRevision ??= state.revision
    return state
  }
  const keyFor = async (
    settings: JevSettings,
    apiKey: string | undefined,
    prior: JevConfigurationCapture,
  ): Promise<string | undefined> => {
    if (apiKey !== undefined && (!apiKey.trim() || apiKey.length > 65536 || /\p{Cc}/u.test(apiKey)))
      throw failure('CONFIG_INVALID_INPUT')
    // Pasting the whole curl header yields `Bearer Bearer <token>` on the wire and a 401 that the
    // upstream reports as an authentication failure, so refuse the prefix instead of forwarding it.
    if (apiKey !== undefined && /^\s*bearer\s+/i.test(apiKey)) throw failure('CONFIG_INVALID_INPUT')
    if (settings.authentication === 'none') {
      if (apiKey !== undefined) throw failure('CONFIG_INVALID_INPUT')
      return undefined
    }
    if (apiKey !== undefined) return apiKey.trim()
    const previousTarget = captureBackends(prior)[settings.backend ?? 'jev']
    const previous = previousTarget?.settings
    if (
      !previous ||
      (previous.backend ?? 'jev') !== settings.backend ||
      previous.endpoint !== settings.endpoint ||
      previous.transport !== settings.transport ||
      previous.authentication !== settings.authentication ||
      !previousTarget?.credentialRef
    )
      throw failure('CONFIG_CREDENTIAL_REQUIRED')
    try {
      const credential = await store.read(previousTarget.credentialRef)
      if (credential?.kind === 'api-key' && credential.provider === 'jev') return credential.value
    } catch {
      throw failure('CONFIG_CREDENTIAL_STORE')
    }
    throw failure('CONFIG_CREDENTIAL_REQUIRED')
  }
  const snapshot = async (state: JevConfigurationCapture): Promise<JevConfigSnapshot> => {
    bootRevision ??= state.revision
    const backends = await Promise.all(
      Object.entries(captureBackends(state)).map(async ([backend, target]) => {
        let credentialConfigured = target.settings.authentication === 'none'
        if (target.credentialRef) {
          try {
            const credential = await store.read(target.credentialRef)
            credentialConfigured = credential?.kind === 'api-key' && credential.provider === 'jev'
          } catch {
            throw failure('CONFIG_CREDENTIAL_STORE')
          }
        }
        return {
          backend: backend as Backend,
          settings: target.settings,
          configured: target.settings.enabled && credentialConfigured,
          credentialConfigured,
        }
      }),
    )
    const credentialConfigured =
      backends.find((target) => target.backend === (state.settings?.backend ?? 'jev'))
        ?.credentialConfigured ?? false
    const source = jevFromEnvironment(env) !== undefined ? 'environment' : state.settings ? 'profile' : 'none'
    return {
      profile: options.profile,
      revision: state.revision,
      settings: state.settings,
      backends,
      configured: !!state.settings?.enabled && credentialConfigured,
      credentialConfigured,
      source,
      effect: bootRevision === state.revision ? 'new-sessions' : 'restart-required',
    }
  }
  const test = async (input: JevConfigTestInput): Promise<JevConfigTestResult> => {
    if (!validateAgainst(TestSchema, input).ok) throw failure('CONFIG_INVALID_INPUT')
    const settings = normalizeJevSettings(input.settings)
    const token = await keyFor(settings, input.apiKey, await capture())
    const result = await createJevDecisionTransport({
      backend: settings.backend ?? 'jev',
      endpoint: settings.endpoint,
      transport: settings.transport,
      ...(token ? { token } : {}),
      fetcher: request,
    }).invoke(
      {
        model: settings.model,
        state: 'This is a synthetic connectivity test. No real customer data or actions are involved.',
        questions: {
          is_test: {
            type: 'noul',
            instructions: 'Does the state explicitly describe a synthetic connectivity test?',
            criteria: { true: 'Explicit synthetic test', false: 'No test mentioned' },
          },
        },
      },
      new AbortController().signal,
    )
    const output = result.output
    if (result.error) {
      const status = /HTTP (\d{3})/.exec(result.error.message)?.[1]
      // A rejected credential is an operator fix, not a transport fault worth retrying.
      throw failure(status === '401' || status === '403' ? 'CONFIG_TEST_UNAUTHORIZED' : 'CONFIG_TEST_FAILED')
    }
    if (
      !object(output) ||
      !object(output.answers) ||
      !object(output.answers.is_test) ||
      output.answers.is_test.type !== 'noul' ||
      typeof output.answers.is_test.noul !== 'number' ||
      !Number.isFinite(output.answers.is_test.noul) ||
      output.answers.is_test.noul < 0 ||
      output.answers.is_test.noul > 1
    )
      throw failure('CONFIG_TEST_FAILED')
    return { verified: true, ...(result.observedModel ? { model: result.observedModel } : {}) }
  }
  return {
    capture,
    get: async () => snapshot(await capture()),
    test,
    async save(input) {
      if (!validateAgainst(SaveSchema, input).ok) throw failure('CONFIG_INVALID_INPUT')
      const settings = normalizeJevSettings(input.settings)
      for (const directory of [home, join(home, 'profiles'), profileDir]) await privateDirectory(directory)
      try {
        return await withConfigurationLock(join(profileDir, 'jev-configuration-lock.sqlite'), async () => {
          const prior = await capture()
          bootRevision ??= prior.revision
          if (prior.revision !== input.expectedRevision) throw failure('CONFIG_REVISION_CONFLICT')
          const token = await keyFor(settings, input.apiKey, prior)
          const credentialRef = token ? `${prefix}${randomUUID().replaceAll('-', '')}` : null
          const next: JevConfigurationCapture = {
            version: 2,
            revision: prior.revision + 1,
            settings,
            credentialRef,
            backends: { ...captureBackends(prior), [settings.backend ?? 'jev']: { settings, credentialRef } },
          }
          try {
            if (credentialRef && token) {
              try {
                await store.putApiKey(credentialRef, token)
              } catch {
                throw failure('CONFIG_CREDENTIAL_STORE')
              }
            }
            await writeCapture(path, next)
          } catch (error) {
            if (credentialRef) await store.remove(credentialRef).catch(() => undefined)
            throw error
          }
          // Once published, the new credential belongs to this revision, even if reading
          // its public snapshot fails. Old references remain valid for running workers.
          return snapshot(next)
        })
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string' &&
          error.code.startsWith('CONFIG_')
        )
          throw error
        throw failure('CONFIG_PERSIST_FAILED')
      }
    },
  }
}

function decodeCapture(value: unknown, prefix: string): JevConfigurationCapture {
  if (
    !object(value) ||
    (value.version !== 1 && value.version !== 2) ||
    Object.keys(value).length !== (value.version === 2 ? 5 : 4) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  )
    throw failure('CONFIG_INVALID_STATE')
  if (value.version === 1 && value.settings === null && value.revision === 0 && value.credentialRef === null)
    return { version: 1, revision: 0, settings: null, credentialRef: null }
  const target = (settingsValue: unknown, ref: unknown): CapturedBackend => {
    const settings = normalizeJevSettings(settingsValue)
    if (
      ref !== null &&
      (typeof ref !== 'string' || !ref.startsWith(prefix) || !/^[a-f0-9]{32}$/.test(ref.slice(prefix.length)))
    )
      throw failure('CONFIG_INVALID_STATE')
    if ((settings.authentication === 'bearer') !== (ref !== null)) throw failure('CONFIG_INVALID_STATE')
    return { settings, credentialRef: ref as string | null }
  }
  if ((value.revision as number) < 1) throw failure('CONFIG_INVALID_STATE')
  const current = target(value.settings, value.credentialRef)
  const capture: JevConfigurationCapture = {
    version: value.version,
    revision: value.revision as number,
    ...current,
  }
  if (value.version === 2) {
    if (!object(value.backends) || Object.keys(value.backends).some((key) => key !== 'jev' && key !== 'laya'))
      throw failure('CONFIG_INVALID_STATE')
    const backends: Partial<Record<Backend, CapturedBackend>> = {}
    for (const [backend, raw] of Object.entries(value.backends)) {
      if (!object(raw) || Object.keys(raw).length !== 2) throw failure('CONFIG_INVALID_STATE')
      const entry = target(raw.settings, raw.credentialRef)
      if (entry.settings.backend !== backend) throw failure('CONFIG_INVALID_STATE')
      backends[backend as Backend] = entry
    }
    if (jcs(backends[current.settings.backend ?? 'jev']) !== jcs(current))
      throw failure('CONFIG_INVALID_STATE')
    if (backends.jev?.credentialRef && backends.jev.credentialRef === backends.laya?.credentialRef)
      throw failure('CONFIG_INVALID_STATE')
    capture.backends = backends
  }
  return capture
}
export function decodeJevConfigurationCapture(value: unknown, profile: string): JevConfigurationCapture {
  if (!PROFILE.test(profile)) throw failure('CONFIG_INVALID_STATE')
  return decodeCapture(
    value,
    `secret://jev/profile-${createHash('sha256').update(profile).digest('hex').slice(0, 16)}-g`,
  )
}

export async function jevFromCapture(
  capture: JevConfigurationCapture,
  home: string,
  fetcher: typeof fetch,
  environment?: JevEnvironmentConfiguration,
): Promise<JevEnvironmentConfiguration | undefined> {
  if (environment && 'unavailableReason' in environment && !environment.backend) return environment
  const defaultDecisionBackend = environment
    ? 'decision' in environment
      ? environment.decision.backend
      : (environment.backend ?? 'jev')
    : (capture.settings?.backend ?? 'jev')
  const backends: Partial<Record<Backend, JevDecisionTarget>> = {}
  const unavailableBackends: Partial<Record<Backend, string>> = {}
  const targets = captureBackends(capture)
  for (const backend of ['jev', 'laya'] as const) {
    if (
      environment &&
      ('decision' in environment ? environment.decision.backend : environment.backend) === backend
    ) {
      if ('decision' in environment) backends[backend] = environment
      else unavailableBackends[backend] = environment.unavailableReason
      continue
    }
    const target = targets[backend]
    if (!target?.settings.enabled) continue
    try {
      const settings = normalizeJevSettings(target.settings)
      const credential =
        settings.authentication === 'bearer' && target.credentialRef
          ? await createCredentialStore({ root: home }).read(target.credentialRef)
          : null
      if (
        settings.authentication === 'bearer' &&
        (credential?.kind !== 'api-key' || credential.provider !== 'jev')
      )
        throw failure('CONFIG_CREDENTIAL_REQUIRED')
      backends[backend] = {
        requestCredits: {
          ...(settings.decisionRequestCredits === undefined
            ? {}
            : { decision: settings.decisionRequestCredits }),
          ...(settings.languageRequestCredits === undefined
            ? {}
            : { language: settings.languageRequestCredits }),
        },
        decision: {
          backend,
          endpoint: settings.endpoint,
          model: settings.model,
          transport: createJevDecisionTransport({
            backend,
            endpoint: settings.endpoint,
            transport: settings.transport,
            fetcher,
            ...(credential?.kind === 'api-key' ? { token: credential.value } : {}),
          }),
        },
      }
    } catch {
      unavailableBackends[backend] =
        `${backend === 'laya' ? 'Laya' : 'Jev'} 持久配置或凭据不可用，请检查设置后重启。`
    }
  }
  const selected = backends[defaultDecisionBackend] ?? Object.values(backends)[0]
  if (!selected) {
    if (!environment && !Object.values(targets).some((target) => target.settings.enabled)) return undefined
    return {
      unavailableReason: unavailableBackends[defaultDecisionBackend] ?? '决策后端未配置或未启用。',
      backend: defaultDecisionBackend,
    }
  }
  // An unavailable configured default resolves once at boot to the assembled primary; the
  // descriptor publishes what unspecified turns will actually use, never a silent per-turn switch.
  const effectiveDefault = backends[defaultDecisionBackend]
    ? defaultDecisionBackend
    : selected.decision.backend
  return { ...selected, defaultDecisionBackend: effectiveDefault, backends, unavailableBackends }
}
