import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { emptySearchConfig, parseStoredConfig, type StoredSearchConfig } from './contract.js'

export function searchConfigPath(dataDir: string): string {
  return join(dataDir, 'search', 'providers.json')
}

export function readSearchConfig(dataDir: string): { config: StoredSearchConfig; invalid: boolean } {
  let raw: string
  try {
    raw = readFileSync(searchConfigPath(dataDir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { config: emptySearchConfig(), invalid: false }
    return { config: emptySearchConfig(), invalid: true }
  }
  try {
    return { config: parseStoredConfig(JSON.parse(raw) as unknown), invalid: false }
  } catch {
    return { config: emptySearchConfig(), invalid: true }
  }
}

export function writeSearchConfig(dataDir: string, config: StoredSearchConfig): void {
  const path = searchConfigPath(dataDir)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify(parseStoredConfig(config), null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}
