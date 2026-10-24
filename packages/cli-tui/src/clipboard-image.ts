import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import type { ContentBlock } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import type { TuiApp } from './app.js'
import { uploadLocalAttachment } from './attachment-upload.js'
import { isLocalImageFile } from './image-file.js'
import { tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'

/** A read of the system clipboard gets this long, and this many bytes of image, before it is given up. */
export const CLIPBOARD_TIMEOUT_MS = 5_000
export const CLIPBOARD_MAX_BYTES = 20 * 1024 * 1024

export type ClipboardReason = 'empty' | 'unavailable' | 'timeout' | 'too-large' | 'failed'
/** `file`: the clipboard held a copied image file (Finder), so that file is the image and nothing was written. */
export type ClipboardImageResult =
  | { ok: true; file?: string }
  | { ok: false; reason: ClipboardReason; tool?: string }

/**
 * Reads the clipboard's image into `file`, which already exists with mode 0600, as a PNG. The system
 * implementation shells out; tests and embedders pass their own through `clipboard`.
 */
export type ClipboardImagePort = {
  readImage(file: string, signal?: AbortSignal): Promise<ClipboardImageResult>
}

type Ran = { ok: true; out: Buffer } | { ok: false; reason: ClipboardReason | 'exit'; tool: string }

/** One fixed-argument call without a shell, bounded in time and output; stdout is the image when there is one. */
function run(tool: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Ran> {
  return new Promise((done) => {
    execFile(
      tool,
      args,
      {
        encoding: 'buffer',
        timeout: CLIPBOARD_TIMEOUT_MS,
        maxBuffer: CLIPBOARD_MAX_BYTES + 1,
        windowsHide: true,
        env,
        ...(signal ? { signal } : {}),
      },
      (error, out) => {
        if (!error) return done({ ok: true, out })
        const e = error as NodeJS.ErrnoException & { killed?: boolean }
        const reason =
          e.code === 'ENOENT'
            ? 'unavailable'
            : e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? 'too-large'
              : e.killed
                ? 'timeout'
                : typeof e.code === 'number'
                  ? 'exit'
                  : 'failed'
        done({ ok: false, reason, tool })
      },
    )
  })
}

const failure = (r: Extract<Ran, { ok: false }>): ClipboardImageResult => ({
  ok: false,
  // A tool that ran and said no found nothing to paste.
  reason: r.reason === 'exit' ? 'empty' : r.reason,
  tool: r.tool,
})

/** wl-paste and xclip print the image; the file is written here. */
async function viaX11OrWayland(file: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const candidates: Array<{ tool: string; list: string[]; get: string[] }> = [
    ...(env.WAYLAND_DISPLAY
      ? [{ tool: 'wl-paste', list: ['--list-types'], get: ['--type', 'image/png', '--no-newline'] }]
      : []),
    ...(env.DISPLAY
      ? [
          {
            tool: 'xclip',
            list: ['-selection', 'clipboard', '-t', 'TARGETS', '-o'],
            get: ['-selection', 'clipboard', '-t', 'image/png', '-o'],
          },
        ]
      : []),
  ]
  let last: ClipboardImageResult = { ok: false, reason: 'unavailable', tool: 'wl-paste / xclip' }
  for (const c of candidates) {
    const types = await run(c.tool, c.list, env, signal)
    if (!types.ok) {
      last = failure(types)
      if (types.reason === 'unavailable') continue
      return last
    }
    if (!types.out.toString('utf8').split(/\s+/).includes('image/png'))
      return { ok: false, reason: 'empty' } as const
    const image = await run(c.tool, c.get, env, signal)
    if (!image.ok) return failure(image)
    await writeFile(file, image.out)
    return { ok: true } as const
  }
  return last
}

/**
 * A file copied in Finder puts a file reference on the clipboard, and its bitmap is only the file's
 * icon: so the reference is tried first, and a copied file that is not an image is "no image".
 * AppleScript writes a bitmap's PNG straight into the file, so no image crosses stdout.
 */
async function viaOsascript(file: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const ref = await run(
    '/usr/bin/osascript',
    ['-e', 'POSIX path of (the clipboard as «class furl»)'],
    env,
    signal,
  )
  if (ref.ok) {
    const path = ref.out.toString('utf8').replace(/\r?\n$/, '')
    return isLocalImageFile(path)
      ? ({ ok: true, file: path } as const)
      : ({ ok: false, reason: 'empty' } as const)
  }
  const quoted = `"${file.replace(/[\\"]/g, (c) => `\\${c}`)}"`
  const script = [
    'set d to the clipboard as «class PNGf»',
    `set f to open for access POSIX file ${quoted} with write permission`,
    'set eof f to 0',
    'write d to f',
    'close access f',
  ]
  const r = await run(
    '/usr/bin/osascript',
    script.flatMap((line) => ['-e', line]),
    env,
    signal,
  )
  return r.ok ? ({ ok: true } as const) : failure(r)
}

/** Windows PowerShell reads the image through System.Windows.Forms; the path travels in the environment, not the script. */
async function viaPowerShell(file: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const script =
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ' +
    '$i=[System.Windows.Forms.Clipboard]::GetImage(); if($null -eq $i){exit 3}; ' +
    '$i.Save($env:AGH_CLIPBOARD_OUT,[System.Drawing.Imaging.ImageFormat]::Png)'
  // Absolute, like the copy command's: a bare name would find a planted binary in the workspace first.
  const powershell = win32.join(
    env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const r = await run(
    powershell,
    ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
    { ...env, AGH_CLIPBOARD_OUT: file },
    signal,
  )
  return r.ok ? ({ ok: true } as const) : failure(r)
}

export function systemClipboard(
  platform: NodeJS.Platform = process.platform, // guards-allow-platform: the clipboard backend selects the native image reader.
  env: NodeJS.ProcessEnv = process.env,
): ClipboardImagePort {
  return {
    readImage: (file, signal) =>
      platform === 'darwin'
        ? viaOsascript(file, env, signal)
        : platform === 'win32'
          ? viaPowerShell(file, env, signal)
          : viaX11OrWayland(file, env, signal),
  }
}

const PNG = [0x89, 0x50, 0x4e, 0x47]
/** What the port wrote must be a PNG of a sane size: anything else is "no image", not an upload. */
async function checkImage(file: string): Promise<ClipboardReason | undefined> {
  const { size } = await stat(file)
  if (size > CLIPBOARD_MAX_BYTES) return 'too-large'
  if (size < PNG.length) return 'empty'
  const handle = await open(file, 'r')
  try {
    const head = Buffer.alloc(PNG.length)
    await handle.read(head, 0, PNG.length, 0)
    return PNG.every((byte, i) => head[i] === byte) ? undefined : 'empty'
  } finally {
    await handle.close()
  }
}

const counts = new WeakMap<TuiApp, number>()

/**
 * Numbers an uploaded image `[Image #n]`, holds it for the next send and puts the chip in the draft.
 * A session switch while the upload ran leaves the image behind with the old session: no chip then.
 */
export function insertImageChip(app: TuiApp, session: Session, block: ContentBlock): string | undefined {
  if (app.session !== session) return undefined
  const n = (counts.get(app) ?? 0) + 1
  counts.set(app, n)
  const chip = tt('paste.image.chip', app.locale, { n })
  app.busyInput.attach(chip, block, session.id)
  app.editor.insertChip(chip)
  return chip
}
const reading = new WeakSet<TuiApp>()

/**
 * Ctrl-V and /paste: reads the clipboard's image into a 0600 file under the private tmp directory,
 * uploads it as the session's attachment (so --connect never reads the daemon's disk) and puts an
 * `[Image #n]` chip in the draft. The chip is what decides, at send time, whether the image goes out.
 * Says why on the status bar when there is nothing to attach.
 */
export async function pasteClipboardImage(app: TuiApp): Promise<void> {
  if (reading.has(app)) return
  reading.add(app)
  const { locale, session } = app
  const signal = app.attachmentSignal
  const say = (text: string, tone: 'error' | 'success' | 'warning') => {
    app.statusBar.setNotice(text, tone)
    app.renderer.requestRender()
  }
  const dir = app.o.externalEditor?.tmpDir
  const file = dir && join(dir, `clipboard-${Date.now()}-${randomBytes(4).toString('hex')}.png`)
  try {
    if (!dir || !file) return say(tt('paste.image.failed', locale), 'error')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(file, '', { mode: 0o600, flag: 'wx' })
    const port = app.o.clipboard ?? systemClipboard()
    const read = await port.readImage(file, signal)
    const reason = read.ok ? (read.file ? undefined : await checkImage(file)) : read.reason
    if (reason || !read.ok) {
      const tool = read.ok ? '' : (read.tool ?? '')
      const key = {
        empty: 'paste.image.empty',
        unavailable: 'paste.image.unavailable',
        timeout: 'paste.image.timeout',
        'too-large': 'paste.image.tooLarge',
        failed: 'paste.image.failed',
      } as const
      return say(
        tt(key[reason ?? 'failed'], locale, { tool, mb: CLIPBOARD_MAX_BYTES / 1024 / 1024 }),
        reason === 'empty' ? 'warning' : 'error',
      )
    }
    const block = await uploadLocalAttachment(session, dir, read.file ?? file, signal)
    const chip = insertImageChip(app, session, block)
    if (chip) say(tt('paste.image.attached', locale, { chip }), 'success')
  } catch (error) {
    if (signal.aborted) return
    say(
      tt('paste.image.uploadFailed', locale, {
        reason: oneLine(error instanceof Error ? error.message : String(error)),
      }),
      'error',
    )
  } finally {
    reading.delete(app)
    if (file) await rm(file, { force: true }).catch(() => undefined)
  }
}
