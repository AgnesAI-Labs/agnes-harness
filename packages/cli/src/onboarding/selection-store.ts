import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CredentialStore } from '@agnes/host'
import { ONBOARDING_PROVIDERS } from './provider-registry.js'
import type { OnboardingResult } from './state.js'

/**
 * Non-secret record of the provider/model chosen during first-run onboarding.
 *
 * Credentials deliberately remain in Host's credential store.  This file only lets a later
 * invocation select the same route/model before it opens the TUI.
 */
type StoredSelectionV1 = Readonly<{
  version: 1
  profile: string
  route: string
  model: string
  thinking: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  credentialRef: string
}>

const PROFILE = /^[a-z][a-z0-9-]{0,63}$/
const ROUTE = /^[a-z][a-z0-9-]{0,63}$/
const MODEL = /^[^\p{Cc}\p{Z}\s]{1,256}$/u
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const FILE = 'onboarding-selection.json'

function selectionPath(home: string, profile: string): string {
  return join(home, 'profiles', profile, FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort()
  const expected = ['credentialRef', 'model', 'profile', 'route', 'thinking', 'version']
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function asSelection(value: unknown): StoredSelectionV1 | undefined {
  if (!isRecord(value) || !exactKeys(value)) return undefined
  if (
    value.version !== 1 ||
    typeof value.profile !== 'string' ||
    !PROFILE.test(value.profile) ||
    typeof value.route !== 'string' ||
    !ROUTE.test(value.route) ||
    typeof value.model !== 'string' ||
    !MODEL.test(value.model) ||
    typeof value.thinking !== 'string' ||
    !THINKING.has(value.thinking) ||
    typeof value.credentialRef !== 'string'
  )
    return undefined
  const provider = ONBOARDING_PROVIDERS.find(
    (candidate) => candidate.aiRegistryId === value.route && candidate.credentialRef === value.credentialRef,
  )
  if (!provider) return undefined
  return {
    version: 1,
    profile: value.profile,
    route: value.route,
    model: value.model,
    thinking: value.thinking as StoredSelectionV1['thinking'],
    credentialRef: value.credentialRef,
  }
}

function toStored(result: OnboardingResult): StoredSelectionV1 {
  const selection = asSelection({ version: 1, ...result })
  if (!selection) throw new Error('Invalid onboarding selection metadata.')
  return selection
}

/** Atomically persists only selected route/model metadata under its profile directory. */
export async function saveOnboardingSelection(home: string, result: OnboardingResult): Promise<void> {
  const selection = toStored(result)
  const directory = join(home, 'profiles', selection.profile)
  const file = selectionPath(home, selection.profile)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, `${JSON.stringify(selection)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/**
 * Reads a persisted selection only when it is structurally valid, belongs to the requested
 * profile, names a reviewed provider/ref pair, and that exact API-key credential still exists.
 * Any corrupt, stale, or mismatched record takes the safe "no remembered model" path.
 */
export async function loadOnboardingSelection(
  home: string,
  profile: string,
  credentials: Pick<CredentialStore, 'read'>,
): Promise<OnboardingResult | undefined> {
  if (!PROFILE.test(profile)) return undefined
  let raw: string
  try {
    raw = await readFile(selectionPath(home, profile), 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return undefined
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return undefined
  }
  const selection = asSelection(decoded)
  if (!selection || selection.profile !== profile) return undefined
  const provider = ONBOARDING_PROVIDERS.find(
    (candidate) =>
      candidate.aiRegistryId === selection.route && candidate.credentialRef === selection.credentialRef,
  )
  if (!provider) return undefined
  try {
    const credential = await credentials.read(selection.credentialRef)
    if (
      credential?.kind !== 'api-key' ||
      credential.provider !== provider.aiRegistryId ||
      credential.value.length === 0
    )
      return undefined
  } catch {
    return undefined
  }
  return {
    profile: selection.profile,
    route: selection.route,
    model: selection.model,
    thinking: selection.thinking,
    credentialRef: selection.credentialRef,
  }
}
