import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Editor } from './editor.js'
import { tt } from './locale-extended.js'
import type { Renderer } from './renderer.js'
import type { NoticeTone } from './views/status-bar.js'

export type ExternalEdit =
  | { kind: 'edited'; text: string }
  | { kind: 'cancelled'; code: number | null }
  | { kind: 'unset' }
  | { kind: 'failed'; reason: string }

/** Words of a command line the way a shell reads them: spaces split, quotes and backslashes group. */
export function splitCommand(line: string): string[] {
  const chars = Array.from(line)
  const words: string[] = []
  let word = ''
  let started = false
  let quote: string | undefined
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string
    const next = i + 1 < chars.length ? (chars[i + 1] as string) : undefined
    if (quote) {
      if (c === quote) quote = undefined
      else if (quote === '"' && c === '\\' && next !== undefined && '"\\$`'.includes(next)) word += chars[++i]
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      started = true
    } else if (c === '\\' && next !== undefined) {
      word += chars[++i]
      started = true
    } else if (/\s/u.test(c)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += c
      started = true
    }
  }
  if (started) words.push(word)
  return words
}

function run(program: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  })
}

/**
 * Writes the draft to a private temp file, hands the terminal to `$VISUAL` (else `$EDITOR`) and reads the
 * file back. The command is split into words and started directly, never through a shell. `suspend`
 * gives the terminal up and returns the call that takes it back; it is called only once an editor is
 * about to run, and its undo always runs. The temp directory is gone when this settles.
 */
export async function editInExternal(
  draft: string,
  o: { env: NodeJS.ProcessEnv; tmpDir: string; suspend(): () => void },
): Promise<ExternalEdit> {
  const [program, ...args] = splitCommand(o.env.VISUAL?.trim() || o.env.EDITOR?.trim() || '')
  if (!program) return { kind: 'unset' }
  let dir: string | undefined
  try {
    await mkdir(o.tmpDir, { recursive: true, mode: 0o700 })
    dir = await mkdtemp(join(o.tmpDir, 'edit-'))
    const file = join(dir, 'prompt.md')
    await writeFile(file, draft, { mode: 0o600 })
    // Cooked mode would let a Ctrl-C reach this process too; the editor, not the TUI, is being interrupted.
    const ignore = (): void => {}
    process.on('SIGINT', ignore)
    const resume = o.suspend()
    let code: number | null
    try {
      code = await run(program, [...args, file])
    } finally {
      resume()
      process.off('SIGINT', ignore)
    }
    if (code !== 0) return { kind: 'cancelled', code }
    // Editors end a file with a newline the user did not type.
    return { kind: 'edited', text: (await readFile(file, 'utf8')).replace(/\r\n?/g, '\n').replace(/\n$/, '') }
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** The status-line notice an unsuccessful edit leaves; a finished one needs none. */
export function externalEditNotice(
  result: ExternalEdit,
  locale: string,
): { text: string; tone: NoticeTone } | undefined {
  switch (result.kind) {
    case 'unset':
      return { text: tt('editor.unset', locale), tone: 'info' }
    case 'cancelled':
      return { text: tt('editor.cancelled', locale, { code: String(result.code ?? '-') }), tone: 'warning' }
    case 'failed':
      return { text: tt('editor.failed', locale, { reason: result.reason }), tone: 'error' }
    default:
      return undefined
  }
}

/** Where the editor command comes from and where its temp file goes; the app passes `<AGH_HOME>/tmp`. */
export type ExternalEditorConfig = { env: NodeJS.ProcessEnv; tmpDir: string }

/** Ctrl-G: edits the draft in the user's own editor, replaces it on success and says why on any other outcome. */
export async function editDraft(
  editor: Editor,
  renderer: Renderer,
  status: { setNotice(text?: string, tone?: NoticeTone): void },
  locale: string,
  config: ExternalEditorConfig = { env: process.env, tmpDir: join(tmpdir(), 'agh-edit') },
): Promise<void> {
  const result = await editInExternal(editor.expanded(), { ...config, suspend: () => renderer.suspend() })
  if (result.kind === 'edited') editor.replaceDraft(result.text)
  const notice = externalEditNotice(result, locale)
  status.setNotice(notice?.text, notice?.tone)
  renderer.requestRender()
}
