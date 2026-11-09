import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type PackageCatalogPage, validatePackageAdminData } from '@agnes/protocol'
import { replaceFileAtomicSync } from '@agnes/system-node'
import { deploymentFetch } from '@agnes/system-node/deployment-network'
import { COMMUNITY_INDEX_URL, listedCommunityRepositories } from './community-index.js'

export type CommunitySnapshot = NonNullable<PackageCatalogPage['community']>
type Repository = CommunitySnapshot['items'][number]
const PERIOD = 6 * 60 * 60 * 1000
const MAX_BYTES = 2 * 1024 * 1024
const TOPICS = ['agh-plugin'] as const
type Failure = NonNullable<CommunitySnapshot['error']>

class SyncFailure extends Error {
  constructor(
    readonly code: Failure,
    readonly retryAt = 0,
  ) {
    super(code)
  }
}

async function boundedFile(path: string): Promise<unknown> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('invalid cache')
  const data = await readFile(path)
  if (data.byteLength > MAX_BYTES) throw new Error('invalid cache')
  return JSON.parse(data.toString('utf8'))
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new SyncFailure('invalid-data')
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_BYTES) throw new SyncFailure('invalid-data')
      parts.push(part.value)
    }
    try {
      return JSON.parse(Buffer.concat(parts).toString('utf8'))
    } catch {
      throw new SyncFailure('invalid-data')
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '')
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
const timestamp = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null

function repository(value: unknown, topic: string): Repository {
  if (!value || typeof value !== 'object') throw new SyncFailure('invalid-data')
  const row = value as Record<string, unknown>
  if (
    !Number.isSafeInteger(row.id) ||
    Number(row.id) < 1 ||
    typeof row.full_name !== 'string' ||
    row.full_name.length > 256 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.full_name) ||
    row.private !== false
  )
    throw new SyncFailure('invalid-data')
  const topics = Array.isArray(row.topics)
    ? row.topics.filter((v): v is string => typeof v === 'string' && /^[a-z0-9-]{1,64}$/.test(v)).slice(0, 20)
    : []
  const license = row.license as Record<string, unknown> | null
  return {
    id: Number(row.id),
    fullName: row.full_name,
    description: text(row.description, 2048),
    topics,
    ecosystem: topic === 'agh-plugin' || topics.includes('agh-plugin') ? 'agh' : 'dsh',
    stars: count(row.stargazers_count),
    forks: count(row.forks_count),
    issues: count(row.open_issues_count),
    language: text(row.language, 100),
    license: text(license?.spdx_id, 100),
    pushedAt: timestamp(row.pushed_at),
  }
}

/** One daemon/profile-owned synchronizer. read() never fetches, schedules, or writes. */
export async function openCommunityDiscovery(options: {
  directory: string
  fetch?: typeof fetch
  now?: () => number
  random?: () => number
}) {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const fetcher = options.fetch ?? deploymentFetch
  let topics: readonly string[] = TOPICS
  let enabled = true
  let configError = false
  try {
    const raw = (await boundedFile(join(options.directory, 'community-discovery.json'))) as Record<
      string,
      unknown
    >
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => !['enabled', 'topics'].includes(key)) ||
      (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') ||
      (raw.topics !== undefined &&
        (!Array.isArray(raw.topics) ||
          !raw.topics.length ||
          raw.topics.length > 1 ||
          raw.topics.some((topic) => !TOPICS.includes(topic as (typeof TOPICS)[number]))))
    )
      throw new Error('configuration')
    enabled = raw.enabled !== false
    if (Array.isArray(raw.topics)) topics = [...new Set(raw.topics as string[])]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      enabled = false
      configError = true
    }
  }
  const fingerprint = `${topics.join(',')}|${COMMUNITY_INDEX_URL}`
  const path = join(options.directory, 'community-discovery-cache.json')
  let snapshot: CommunitySnapshot = {
    state: enabled ? 'pending' : 'disabled',
    lastSuccessAt: null,
    nextAttemptAt: null,
    error: configError ? 'configuration' : null,
    totalReported: 0,
    items: [],
  }
  if (enabled) {
    try {
      const raw = (await boundedFile(path)) as {
        version?: number
        fingerprint?: string
        snapshot?: CommunitySnapshot
      }
      if (
        raw.version === 2 &&
        raw.fingerprint === fingerprint &&
        raw.snapshot &&
        validatePackageAdminData('PackageCatalogPage', {
          items: [],
          nextCursor: null,
          community: raw.snapshot,
        }).ok &&
        (!raw.snapshot.lastSuccessAt || Date.parse(raw.snapshot.lastSuccessAt) <= now()) &&
        (!raw.snapshot.nextAttemptAt || Number.isFinite(Date.parse(raw.snapshot.nextAttemptAt)))
      ) {
        snapshot = {
          ...raw.snapshot,
          state: raw.snapshot.state === 'syncing' ? 'pending' : raw.snapshot.state,
        }
      }
    } catch {
      /* Missing or damaged discovery is not a startup failure. */
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: Promise<void> | undefined
  let stopped = false
  let started = false
  let failures = 0
  const controller = new AbortController()
  const persist = async (value: CommunitySnapshot) => {
    const data = JSON.stringify({ version: 2, fingerprint, snapshot: value })
    if (Buffer.byteLength(data) > MAX_BYTES) throw new SyncFailure('storage')
    // The profile directory is already private; cache loss on power failure is recoverable.
    replaceFileAtomicSync(path, data)
  }
  function schedule(delay: number) {
    if (stopped || !enabled) return
    timer = setTimeout(
      () => {
        const remaining = Date.parse(snapshot.nextAttemptAt ?? '') - now()
        if (remaining > 0) schedule(remaining)
        else void sync()
      },
      Math.min(2_147_000_000, Math.max(1000, delay)),
    )
    timer.unref()
  }
  async function request(url: URL | string): Promise<unknown> {
    const response = await fetcher(url, {
      redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      headers: { Accept: 'application/json', 'User-Agent': 'Agnes-Harness-Community' },
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 403 || response.status === 429) {
        const retryHeader = response.headers.get('retry-after')
        const retry = Number(retryHeader)
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
        const retryAt =
          Number.isFinite(retry) && retry > 0 ? now() + retry * 1000 : Date.parse(retryHeader ?? '')
        const validTime = (value: number) =>
          Number.isFinite(value) && value >= 0 && value < 8.64e15 ? value : 0
        throw new SyncFailure('rate-limit', Math.max(now() + 60_000, validTime(retryAt), validTime(reset)))
      }
      throw new SyncFailure('network')
    }
    return boundedJson(response)
  }
  async function collect(): Promise<{ items: Repository[]; totalReported: number }> {
    const rows = new Map<number, Repository>()
    for (const topic of topics) {
      for (let page = 1; page <= 2; page++) {
        controller.signal.throwIfAborted()
        const url = new URL('https://api.github.com/search/repositories')
        url.search = new URLSearchParams({
          q: `topic:${topic} archived:false fork:false is:public`,
          sort: 'stars',
          order: 'desc',
          per_page: '100',
          page: String(page),
        }).toString()
        const raw = (await request(url)) as {
          items?: unknown[]
          total_count?: number
          incomplete_results?: boolean
        }
        if (
          !raw ||
          !Array.isArray(raw.items) ||
          raw.items.length > 100 ||
          !Number.isSafeInteger(raw.total_count) ||
          Number(raw.total_count) < 0 ||
          raw.incomplete_results
        )
          throw new SyncFailure('invalid-data')
        for (const value of raw.items) {
          const row = repository(value, topic)
          if (row.topics.includes('agh-plugin')) rows.set(row.id, row)
        }
        if (raw.items.length < 100) break
      }
    }
    let listed: ReadonlySet<string>
    const index = await request(COMMUNITY_INDEX_URL)
    try {
      listed = listedCommunityRepositories(index)
    } catch {
      throw new SyncFailure('invalid-data')
    }
    const matches = [...rows.values()].filter((row) => listed.has(row.fullName.toLowerCase()))
    const items: Repository[] = []
    let bytes = 0
    for (const row of matches.sort((a, b) => b.stars - a.stars)) {
      const size = Buffer.byteLength(JSON.stringify(row)) + 1
      if (bytes + size > 256 * 1024) break
      bytes += size
      items.push(row)
    }
    return { items, totalReported: matches.length }
  }
  function sync(): Promise<void> {
    if (active) return active
    if (stopped || !enabled) return Promise.resolve()
    clearTimeout(timer)
    snapshot = { ...snapshot, state: 'syncing' }
    active = (async () => {
      try {
        const data = await collect()
        if (stopped) return
        const next: CommunitySnapshot = {
          ...data,
          state: 'ready',
          error: null,
          lastSuccessAt: new Date(now()).toISOString(),
          nextAttemptAt: new Date(now() + PERIOD + random() * 300_000).toISOString(),
        }
        try {
          await persist(next)
        } catch {
          throw new SyncFailure('storage')
        }
        snapshot = next
        failures = 0
      } catch (error) {
        if (stopped) return
        const delays = [60_000, 300_000, 900_000, 3_600_000]
        const delay = delays[Math.min(failures++, delays.length - 1)] ?? 3_600_000
        const failure = error instanceof SyncFailure ? error : new SyncFailure('network')
        snapshot = {
          ...snapshot,
          state: 'failed',
          error: failure.code,
          nextAttemptAt: new Date(Math.max(now() + delay, failure.retryAt)).toISOString(),
        }
        await persist(snapshot).catch(() => undefined)
      } finally {
        active = undefined
        if (!stopped) schedule(Math.max(1000, Date.parse(snapshot.nextAttemptAt ?? '') - now() || PERIOD))
      }
    })()
    return active
  }
  return {
    read: (): CommunitySnapshot => structuredClone(snapshot),
    start() {
      if (started || stopped || !enabled) return
      started = true
      const due = snapshot.nextAttemptAt
        ? Date.parse(snapshot.nextAttemptAt) - now()
        : 10_000 + random() * 20_000
      snapshot = { ...snapshot, nextAttemptAt: new Date(now() + Math.max(1000, due)).toISOString() }
      schedule(due)
    },
    async close() {
      stopped = true
      clearTimeout(timer)
      controller.abort()
      await active
    },
  }
}
