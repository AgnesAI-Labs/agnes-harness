import { homedir } from 'node:os'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TuiApp } from './app.js'
import { uploadLocalAttachment } from './attachment-upload.js'
import { insertImageChip } from './clipboard-image.js'
import { isLocalImageFile } from './image-file.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'

const MAX_DROPPED = 10

/**
 * The words of a pasted line the way a shell would split them: whitespace or newlines separate,
 * quotes group, and a backslash escapes the next character when that is not a letter or digit (so
 * the `\ ` and `\(` of a terminal's dropped file survive, and a Windows `C:\Users` is left alone).
 */
function words(raw: string): string[] | undefined {
  const out: string[] = []
  let word: string | undefined
  let quote: string | undefined
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charAt(i)
    const next = raw.charAt(i + 1)
    if (c === '\\' && quote !== "'" && next && !/[A-Za-z0-9]/.test(next)) {
      word = (word ?? '') + next
      i++
    } else if (quote) {
      if (c === quote) quote = undefined
      else word = (word ?? '') + c
    } else if (c === "'" || c === '"') {
      quote = c
      word = word ?? ''
    } else if (/\s/.test(c)) {
      if (word !== undefined) out.push(word)
      word = undefined
    } else word = (word ?? '') + c
  }
  if (quote) return undefined
  if (word !== undefined) out.push(word)
  return out
}

const toPath = (word: string): string | undefined => {
  if (word.startsWith('file://')) {
    try {
      return fileURLToPath(word)
    } catch {
      return undefined
    }
  }
  if (word === '~' || word.startsWith('~/')) return homedir() + word.slice(1)
  return word
}

/**
 * The image files a paste names, or undefined when the paste is anything else: every word must be
 * an absolute path, `~/` path or `file://` URL of an existing regular file (symlinks followed) with a
 * png, jpeg, gif or webp extension.
 */
export function pastedImagePaths(raw: string): string[] | undefined {
  const all = words(raw)
  if (!all || all.length === 0 || all.length > MAX_DROPPED) return undefined
  const paths: string[] = []
  for (const word of all) {
    const path = toPath(word)
    if (!path || !isLocalImageFile(path)) return undefined
    paths.push(path)
  }
  return paths
}

/**
 * Editor paste hook: when the paste is only image paths (never under --connect, where this disk is
 * not the session's workspace), uploads each as an attachment and puts its chip in the draft.
 * True when it took the paste. A failed upload puts that path back in the draft as text.
 */
export function attachDroppedImages(app: TuiApp, raw: string): boolean {
  if (app.o.remote) return false
  const paths = pastedImagePaths(raw)
  if (!paths) return false
  const { session, locale } = app
  const signal = app.attachmentSignal
  const say = (text: string, tone: 'error' | 'success') => {
    app.statusBar.setNotice(text, tone)
    app.renderer.requestRender()
  }
  void (async () => {
    for (const path of paths) {
      try {
        const block = await uploadLocalAttachment(session, app.cwd, path, signal)
        const chip = insertImageChip(app, session, block)
        if (chip) say(tt('paste.drop.attached', locale, { name: basename(path), chip }), 'success')
      } catch (error) {
        if (signal.aborted || app.session !== session) return
        app.editor.paste(path.includes(' ') ? `"${path}"` : path)
        const reason = oneLine(error instanceof Error ? error.message : String(error))
        say(tt('paste.drop.failed', locale, { name: basename(path), reason }), 'error')
      }
    }
  })()
  return true
}
