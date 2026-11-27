import { randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AdminTelemetryParams, TelemetrySettings } from '@agnes/protocol/gen/app-server'
import { windowsReadPrivateFileSync, windowsWritePrivateFile } from '@agnes/system-node'

export const DEFAULT_TELEMETRY_ENDPOINT = 'https://agh-telemetry.agnes-ai.cn'

const DEFAULTS: TelemetrySettings = { analyticsEnabled: true, traceUploadEnabled: true }
const OFF: TelemetrySettings = { analyticsEnabled: false, traceUploadEnabled: false }
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const TRUE_ENV_VALUE = /^(1|true)$/i
const FALSE_ENV_VALUE = /^(0|false)$/i
const AUTOMATION_ENV_KEYS = ['GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'TF_BUILD', 'CNB', 'CONTAINER']

function defaultIsLinuxContainer(): boolean {
  const linux = process.platform === 'linux' // guards-allow-platform: Linux container marker files disable default telemetry in ephemeral containers.
  return linux && (existsSync('/.dockerenv') || existsSync('/run/.containerenv'))
}

function isAutomationEnvironment(env: NodeJS.ProcessEnv): boolean {
  return (
    TRUE_ENV_VALUE.test(env.CI?.trim() ?? '') ||
    TRUE_ENV_VALUE.test(env.VITEST?.trim() ?? '') ||
    AUTOMATION_ENV_KEYS.some((key) => {
      const value = env[key]?.trim()
      return !!value && !FALSE_ENV_VALUE.test(value)
    })
  )
}

export function telemetryEnvironment(
  env: NodeJS.ProcessEnv,
  allowInTest = false,
  isContainer: () => boolean = defaultIsLinuxContainer,
) {
  let endpoint: URL | undefined
  const candidate = (env.AGH_TELEMETRY_ENDPOINT ?? DEFAULT_TELEMETRY_ENDPOINT).trim()
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const url = new URL(candidate)
      if (!url.username && !url.password && !url.search && !url.hash) endpoint = url
    } catch {
      // An invalid destination disables both network paths.
    }
  }
  const override = env.AGH_TELEMETRY_DISABLED?.trim() ?? ''
  const disabledByEnv =
    env.DO_NOT_TRACK === '1' ||
    TRUE_ENV_VALUE.test(override) ||
    (!FALSE_ENV_VALUE.test(override) && !allowInTest && (isAutomationEnvironment(env) || isContainer()))
  return { endpoint, disabledByEnv, endpointConfigured: endpoint !== undefined }
}

const windows = process.platform === 'win32' // guards-allow-platform: Private telemetry files use the native Windows ACL adapter.

async function readPrivate(path: string): Promise<string | undefined> {
  try {
    if (windows) return windowsReadPrivateFileSync(path, 4096).toString('utf8')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > 4096 || info.mode & 0o077)
        throw new Error('Unsafe telemetry state')
      return await file.readFile('utf8')
    } finally {
      await file.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function writePrivate(path: string, contents: string): Promise<void> {
  if (windows) return windowsWritePrivateFile(path, Buffer.from(contents))
  const temporary = `${path}.${randomUUID()}.tmp`
  const file = await open(temporary, 'wx', 0o600)
  try {
    try {
      await file.writeFile(contents)
      await file.chmod(0o600)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** The production supervisor calls this while holding the installation's owner lock. */
export async function telemetryInstallId(home: string): Promise<string> {
  const path = join(home, 'telemetry-id')
  const previous = (await readPrivate(path))?.trim()
  if (previous !== undefined) {
    if (!UUID_V4.test(previous)) throw new Error('Invalid telemetry installation ID')
    return previous
  }
  const id = randomUUID()
  await writePrivate(path, `${id}\n`)
  return id
}

export async function openTelemetrySettings(home: string) {
  const path = join(home, 'telemetry.json')
  let current = DEFAULTS
  try {
    const raw = await readPrivate(path)
    if (raw !== undefined) {
      const value = JSON.parse(raw) as Partial<TelemetrySettings> | null
      if (typeof value?.analyticsEnabled !== 'boolean' || typeof value.traceUploadEnabled !== 'boolean')
        throw new Error('Invalid telemetry settings')
      current = { analyticsEnabled: value.analyticsEnabled, traceUploadEnabled: value.traceUploadEnabled }
    }
  } catch {
    current = OFF
  }

  let tail = Promise.resolve()
  return {
    read: () => ({ ...current }),
    update(patch: NonNullable<AdminTelemetryParams['settings']>, apply: (value: TelemetrySettings) => void) {
      const update = tail.then(async () => {
        const next = { ...current, ...patch }
        await writePrivate(path, `${JSON.stringify(next)}\n`)
        current = next
        apply(next)
      })
      tail = update.catch(() => undefined)
      return update
    },
  }
}
