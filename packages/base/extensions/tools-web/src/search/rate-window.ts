import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SearchProviderError, type SearchProviderId } from './contract.js'

const WINDOW_MS = 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pause(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      // Atomics.wait is unavailable; a short spin is enough for a contended lock.
    }
  }
}

function withLock<T>(lockDir: string, body: () => T): T {
  const started = Date.now()
  try {
    mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 })
  } catch {
    throw new SearchProviderError('SEARCH_FAILED', 'The search provider request failed.')
  }
  for (;;) {
    try {
      mkdirSync(lockDir)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new SearchProviderError('SEARCH_FAILED', 'The search provider request failed.')
      let stale = false
      try {
        stale = Date.now() - statSync(lockDir).mtimeMs > 2_000
      } catch {
        stale = true
      }
      if (stale) {
        rmSync(lockDir, { recursive: true, force: true })
        continue
      }
      if (Date.now() - started > 2_000)
        throw new SearchProviderError('SEARCH_FAILED', 'The search provider request failed.')
      pause(5)
    }
  }
  try {
    return body()
  } catch (error) {
    if (error instanceof SearchProviderError) throw error
    throw new SearchProviderError('SEARCH_FAILED', 'The search provider request failed.')
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
}

function readStamps(path: string): number[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.stamps)) return []
    return parsed.stamps.filter(
      (stamp): stamp is number => typeof stamp === 'number' && Number.isFinite(stamp),
    )
  } catch {
    return []
  }
}

function writeStamps(path: string, stamps: number[]): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify({ version: 1, stamps })}\n`, { mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file was already renamed, or the write never created it.
    }
    throw error
  }
}

/**
 * One sliding window per provider, stored under the profile data directory.
 * Settings tests run in the launcher process and `web_search` runs in the session worker,
 * so an in-memory map would not be the same limit.
 */
export function takeRateWindow(
  dataDir: string,
  id: SearchProviderId,
  limit: number,
  count: number,
  now: number,
): boolean {
  const path = join(dataDir, 'search', 'rate', `${id}.json`)
  return withLock(join(dataDir, 'search', 'rate', `${id}.lock`), () => {
    const stamps = readStamps(path).filter((at) => now - at < WINDOW_MS)
    if (stamps.length + count > limit) {
      writeStamps(path, stamps)
      return false
    }
    for (let index = 0; index < count; index += 1) stamps.push(now)
    writeStamps(path, stamps)
    return true
  })
}
