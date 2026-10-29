import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdminMemoryParams, AdminMemoryResult } from '@agnes/protocol/gen/app-server'
import type { Session } from '@agnes/sdk'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { escapeControl } from './component.js'
import { editInExternal, externalEditNotice } from './external-editor.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'

const METHOD = '_agnes/v1/admin.memory'
const INDEX = 'MEMORY.md'
// The daemon's own file-name rule (memory-file `name`): one flat directory of `.md` files.
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$/
const MAX_ADD = 2000

// One confirmation per session object: a session switch leaves the old one's card behind.
const pending = new WeakMap<Session, string>()

type Failure = { data?: { code?: unknown; reason?: unknown } }
const dataOf = (error: unknown): Failure['data'] => (error as Failure | null)?.data

/**
 * `/memory`: the workspace's memory files through the daemon method the Web settings page uses
 * (`admin.memory`). That method lists files, reads one, and replaces one when the caller names the hash
 * it read (a stale hash is refused). It has no delete and no create-by-name, so neither is offered here:
 * `/memory edit` changes a file that exists, and `/memory add` appends one line to MEMORY.md.
 */
export async function memorySlash(app: TuiApp, line: string): Promise<SlashResult> {
  const { locale, session: s } = app
  const body = line.trim().slice('/memory'.length).trim()
  const [word = '', ...more] = body.split(/\s+/)
  const rest = body.slice(word.length).trim()
  const call = (params: AdminMemoryParams) => s.client.call<AdminMemoryResult>(METHOD, params)
  const said = (key: Parameters<typeof tt>[0], vars?: Record<string, string | number>): SlashResult => ({
    text: tt(key, locale, vars),
  })
  const fileName = (value: string | undefined): string | undefined => {
    const name = value && !value.includes('.') ? `${value}.md` : value
    return name && NAME.test(name) ? name : undefined
  }
  try {
    if (word === 'cancel') {
      pending.delete(s)
      return said('memory.cancelled')
    }
    if (word === 'confirm') {
      const text = pending.get(s)
      if (text === undefined) return said('memory.noPending')
      pending.delete(s)
      const before = (await call({ cwd: app.cwd, file: INDEX })).file
      if (!before) return said('memory.unsupported')
      const head =
        before.content === '' || before.content.endsWith('\n') ? before.content : `${before.content}\n`
      await call({ cwd: app.cwd, file: INDEX, content: `${head}- ${text}\n`, baseHash: before.hash })
      return said('memory.added', { file: INDEX })
    }
    if (word === 'add') {
      const text = oneLine(rest)
      if (!text) return said('memory.usage')
      if (text.length > MAX_ADD) return said('memory.tooLong', { max: MAX_ADD })
      pending.set(s, text)
      return { text: tt('memory.addCard', locale, { text, file: INDEX }), presentation: 'transcript' }
    }
    if (word === 'show' || word === 'edit') {
      const name = fileName(more[0])
      if (!name || more.length !== 1) return said('memory.usage')
      const read = await call({ cwd: app.cwd, file: name })
      const known = read.inspection.files.some((entry) => entry.path === name)
      if (!read.file || (!known && name !== INDEX)) return said('memory.unknown', { name: oneLine(name) })
      if (word === 'show') {
        const shown = read.file.bytes === 0 ? tt('memory.empty', locale) : escapeControl(read.file.content)
        return {
          text: `${tt('memory.fileHead', locale, { name, bytes: read.file.bytes })}\n${shown}`,
          presentation: 'transcript',
        }
      }
      const config = app.o.externalEditor ?? { env: process.env, tmpDir: join(tmpdir(), 'agh-edit') }
      const edit = await editInExternal(read.file.content, {
        ...config,
        suspend: () => app.renderer.suspend(),
      })
      app.renderer.requestRender()
      if (edit.kind !== 'edited') {
        const notice = externalEditNotice(edit, locale)
        return { text: notice?.text ?? '' }
      }
      // The editor hands back the text without its closing newline; a memory file keeps one.
      const content = edit.text === '' ? '' : `${edit.text}\n`
      if (content === read.file.content) return said('memory.unchanged', { name })
      await call({ cwd: app.cwd, file: name, content, baseHash: read.file.hash })
      return said('memory.saved', { name })
    }
    if (word !== '' && word !== 'list') return said('memory.usage')
    const { inspection } = await call({ cwd: app.cwd })
    const kb = (bytes: number) => Math.round(bytes / 102.4) / 10
    const names = [...new Set([INDEX, ...inspection.files.map((entry) => entry.path)])]
    const rows = names.map((name) => {
      const entry = inspection.files.find((candidate) => candidate.path === name)
      return `  ${oneLine(name)}  ${entry ? `${entry.bytes} B` : tt('memory.empty', locale)}`
    })
    return {
      text: [
        tt('memory.header', locale, {
          mode: oneLine(inspection.settings.mode),
          used: kb(inspection.bytes),
          limit: kb(inspection.settings.totalMaxBytes),
          root: oneLine(inspection.root),
        }),
        ...rows,
        tt('memory.hint', locale),
      ].join('\n'),
      presentation: 'transcript',
    }
  } catch (error) {
    const data = dataOf(error)
    if (data?.code === 'METHOD_NOT_FOUND' || data?.code === 'CAPABILITY_DENIED')
      return said('memory.unsupported')
    const reason =
      typeof data?.reason === 'string' && data.reason.startsWith('MEMORY_') ? data.reason : undefined
    if (reason === 'MEMORY_CONFLICT') return said('memory.conflict')
    if (reason) return said('memory.refused', { reason: oneLine(reason) })
    throw error
  }
}
