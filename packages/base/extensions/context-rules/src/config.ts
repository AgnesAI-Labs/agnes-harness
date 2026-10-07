import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'

export type ContextConfig = {
  rulesEnabled: boolean
  instructionFiles: string[]
  localInstructionFiles: string[]
  maxBytes: number
  maxSourceBytes: number
  timeEnabled: boolean
  timeZone: string
  refreshIntervalMs: number
  customSkillRoots: string[]
}
export function contextHome(): string {
  const explicit = process.env.AGH_HOME?.trim() || process.env.AGNES_HOME?.trim()
  if (explicit && !isAbsolute(explicit)) throw new Error('context home must be absolute')
  return explicit ?? join(process.env.HOME || homedir(), AGH_DIR)
}
const defaults = (): ContextConfig => ({
  rulesEnabled: true,
  instructionFiles: ['AGENTS.md', 'CLAUDE.md'],
  localInstructionFiles: ['AGENTS.local.md', 'CLAUDE.local.md'],
  maxBytes: 32768,
  maxSourceBytes: 1048576,
  timeEnabled: true,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  refreshIntervalMs: 600000,
  customSkillRoots: [],
})
export function parseContextConfig(value: unknown): ContextConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid context configuration')
  const result = defaults()
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(result, key)) throw new Error(`unknown context setting: ${key}`)
    if (key === 'rulesEnabled' || key === 'timeEnabled') {
      if (typeof item !== 'boolean') throw new Error(`invalid ${key}`)
      result[key] = item
    } else if (key === 'timeZone') {
      if (typeof item !== 'string' || item.length > 128) throw new Error('invalid timeZone')
      new Intl.DateTimeFormat('en-US', { timeZone: item }).format(0)
      result.timeZone = item
    } else if (key === 'maxBytes' || key === 'maxSourceBytes' || key === 'refreshIntervalMs') {
      const cap = key === 'maxBytes' ? 60000 : key === 'maxSourceBytes' ? 1048576 : 86400000
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0 || item > cap)
        throw new Error(`invalid ${key}`)
      result[key] = item
    } else if (key === 'instructionFiles' || key === 'localInstructionFiles' || key === 'customSkillRoots') {
      if (
        !Array.isArray(item) ||
        item.length > 16 ||
        !item.every(
          (s) =>
            typeof s === 'string' &&
            s.length > 0 &&
            s.length <= 4096 &&
            ![...s].some((char) => char.charCodeAt(0) < 32),
        )
      )
        throw new Error(`invalid ${key}`)
      const strings: string[] = item
      if (key === 'customSkillRoots') {
        if (strings.some((s) => !isAbsolute(s))) throw new Error('custom Skill roots must be absolute')
        result[key] = [...new Set(strings.map((s) => resolve(s)))]
      } else {
        if (strings.some((s) => s === '.' || s === '..' || /[\\/]/.test(s)))
          throw new Error('instruction candidates must be file names')
        result[key] = [...new Set(strings)]
      }
    }
  }
  return result
}
/** Installation-owned settings only. A repository cannot authorize external Skill roots. */
export function readContextConfig(home = contextHome()): ContextConfig {
  const file = join(home, 'context.json')
  if (!existsSync(file)) return defaults()
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    if (fstatSync(fd).size > 65536) throw new Error('context configuration too large')
    const bytes = Buffer.alloc(65537)
    const size = readSync(fd, bytes, 0, bytes.length, 0)
    if (size > 65536) throw new Error('context configuration too large')
    return parseContextConfig(JSON.parse(bytes.subarray(0, size).toString('utf8')))
  } finally {
    closeSync(fd)
  }
}
export function writeContextConfig(value: unknown, home = contextHome()): ContextConfig {
  const config = parseContextConfig(value)
  mkdirSync(home, { recursive: true })
  const root = realpathSync(home)
  const temporary = join(root, `context.${randomUUID()}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  try {
    renameSync(temporary, join(root, 'context.json'))
  } finally {
    rmSync(temporary, { force: true })
  }
  return config
}
