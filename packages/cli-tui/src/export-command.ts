import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { TuiApp } from './app.js'
import { localPath } from './cd-command.js'
import type { SlashResult } from './commands.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'

/** The formats `agh export` writes; the file extension each one conventionally takes. */
const EXTENSION = { agnes: 'jsonl', html: 'html', sharegpt: 'json', 'claude-code': 'jsonl' } as const
export type ExportFormat = keyof typeof EXTENSION
export type ExportRequest = { sessionId: string; format: ExportFormat; out: string }

const isFormat = (word: string): word is ExportFormat => Object.hasOwn(EXTENSION, word)
const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * `/export [format] [path]`: writes this session with the code behind `agh export` (redacted, never
 * raw) and says where. The CLI injects the writer because it boots a second connection for it, so
 * the export sees the whole retained ledger; without the injection (`--connect`, `--standalone`,
 * `--ephemeral`) there is nothing to run here and the command says so.
 */
export async function exportSlash(app: TuiApp, line: string): Promise<SlashResult> {
  const { locale, session: s } = app
  const write = app.o.exportSession
  if (!write) return { text: tt('export.unavailable', locale) }
  const body = line.trim().slice('/export'.length).trim()
  const first = body.split(/\s+/)[0] ?? ''
  // `--html` is what this command took before it wrote files itself.
  const format: ExportFormat = first === '--html' ? 'html' : isFormat(first) ? first : 'agnes'
  const given = first === '--html' || isFormat(first) ? body.slice(first.length).trim() : body
  const stamp = new Date()
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/[-:]/g, '')
  const name = `agh-${s.id.replace(/[^\w.-]/g, '_').slice(0, 24)}-${stamp}.${EXTENSION[format]}`
  const target = given ? localPath(app, given) : join(app.cwd, name)
  const out = isDirectory(target) ? join(target, name) : target
  try {
    await write({ sessionId: s.id, format, out })
  } catch (error) {
    return {
      text: tt('export.failed', locale, {
        reason: oneLine(error instanceof Error ? error.message : String(error)),
      }),
    }
  }
  return { text: tt('export.done', locale, { format, path: oneLine(out) }) }
}
