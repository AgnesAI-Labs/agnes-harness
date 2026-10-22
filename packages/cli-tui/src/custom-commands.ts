import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import type { TuiApp } from './app.js'
import { escapeControl } from './component.js'
import { tt } from './locale-extended.js'

/** One `.md` file that is a slash command. `project` ones come from the repository, so they are not trusted. */
export type CustomCommand = {
  name: string
  scope: 'project' | 'personal'
  /** `.agh/commands/<name>.md` for a project command, the absolute path for a personal one. */
  shown: string
  description: string
  hint: string
  body: string
  digest: string
}
export type CustomScan = {
  commands: Map<string, CustomCommand>
  skipped: Array<{ file: string; reason: string }>
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
const MAX_BYTES = 32 * 1024
const MAX_FILES = 200
const PREVIEW_CHARS = 200
const CACHE_MS = 1000

const oneLine = (s: string): string => escapeControl(s).replace(/\s+/g, ' ').trim()

/** `---` frontmatter with flat `key: value` lines; anything it does not understand stays in the body. */
function parse(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  for (const row of (m[1] as string).split(/\r?\n/)) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(row)
    if (kv) fields[kv[1] as string] = (kv[2] as string).replace(/^(['"])(.*)\1$/, '$2').trim()
  }
  return { fields, body: text.slice(m[0].length) }
}

function readDir(
  dir: string,
  scope: CustomCommand['scope'],
  into: CustomScan,
  taken: (name: string) => string | undefined,
): void {
  let names: string[]
  try {
    names = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .slice(0, MAX_FILES)
  } catch {
    return
  }
  for (const file of names) {
    const path = join(dir, file)
    const name = file.slice(0, -'.md'.length)
    const skip = (reason: string) =>
      into.skipped.push({ file: scope === 'project' ? `${AGH_DIR}/commands/${file}` : path, reason })
    const why = taken(name)
    if (!NAME.test(name)) skip('custom.invalid')
    else if (why) skip(why)
    else {
      try {
        // lstat: a symlink in a repository could otherwise pull any file on this machine into a prompt.
        const st = lstatSync(path)
        if (!st.isFile()) skip('custom.notFile')
        else if (st.size > MAX_BYTES) skip('custom.size')
        else {
          const { fields, body } = parse(readFileSync(path, 'utf8'))
          into.commands.set(name, {
            name,
            scope,
            shown: scope === 'project' ? `${AGH_DIR}/commands/${file}` : path,
            description: oneLine(fields.description ?? ''),
            hint: oneLine(fields['argument-hint'] ?? ''),
            body,
            digest: createHash('sha256').update(path).update(body).digest('hex'),
          })
        }
      } catch {
        skip('custom.notFile')
      }
    }
  }
}

/** Scans the project and personal directories. Built-ins win, then project over personal. */
export function scanCustomCommands(
  dirs: { project?: string; personal?: string },
  builtin: (name: string) => boolean,
): CustomScan {
  const scan: CustomScan = { commands: new Map(), skipped: [] }
  const taken = (name: string) =>
    builtin(`/${name}`) ? 'custom.builtin' : scan.commands.has(name) ? 'custom.overridden' : undefined
  if (dirs.project) readDir(dirs.project, 'project', scan, taken)
  if (dirs.personal) readDir(dirs.personal, 'personal', scan, taken)
  return scan
}

const cache = new WeakMap<TuiApp, { at: number; scan: CustomScan }>()

/** The commands visible now. Over --connect the session's workspace is on the daemon's machine, so only personal ones. */
export function customCommandsFor(
  app: TuiApp,
  builtin: (name: string) => boolean,
  fresh = false,
): CustomScan {
  const hit = cache.get(app)
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.scan
  const dirs = {
    ...(app.o.remote ? {} : { project: join(app.cwd, AGH_DIR, 'commands') }),
    ...(app.o.commandsDir ? { personal: app.o.commandsDir } : {}),
  }
  const scan = scanCustomCommands(dirs, builtin)
  cache.set(app, { at: Date.now(), scan })
  return scan
}

/** `$1`..`$9` and `$@`, in one pass so an argument that contains `$1` is not expanded again. */
export function expand(body: string, args: readonly string[]): string {
  return body.replace(/\$([1-9@])/g, (_m, k: string) =>
    k === '@' ? args.join(' ') : (args[Number(k) - 1] ?? ''),
  )
}

// Project commands the user has seen the expansion of in this process, by path and content.
const confirmed = new Set<string>()

/** Runs `/name args` when it is a custom command; undefined when it is not one. */
export function customSlash(
  app: TuiApp,
  cmd: string,
  line: string,
  builtin: (name: string) => boolean,
): { text?: string; prompt?: string; draft?: string; presentation?: 'transcript' } | undefined {
  const found = customCommandsFor(app, builtin, true).commands.get(cmd.slice(1))
  if (!found) return undefined
  const text = expand(found.body, line.trim().split(/\s+/).slice(1)).trim()
  if (!text) return { text: tt('custom.empty', app.locale, { name: cmd }) }
  // Format and private-use characters (bidi overrides, tag characters, zero-width) can hide text the
  // preview cannot show, so a repository's command that carries them is not run at all.
  if (found.scope === 'project' && /[\p{Cf}\p{Co}]/u.test(found.body))
    return { text: tt('custom.hidden', app.locale, { path: oneLine(found.shown) }) }
  if (found.scope === 'project' && !confirmed.has(found.digest)) {
    confirmed.add(found.digest)
    const chars = [...text]
    const path = oneLine(found.shown)
    // A cut preview says so: the rest is sent too, and the user is confirming all of it.
    const more = chars.length > PREVIEW_CHARS
    const preview = `${escapeControl(chars.slice(0, PREVIEW_CHARS).join(''))}${more ? `\n${tt('custom.more', app.locale, { count: String(chars.length - PREVIEW_CHARS), path })}` : ''}`
    return {
      text: tt('custom.confirm', app.locale, { path, preview }),
      presentation: 'transcript',
      draft: line.trim(),
    }
  }
  return { prompt: text }
}

/** The `/help` section for custom commands and the files that were left out, as lines; empty when there are none. */
export function customHelp(app: TuiApp, builtin: (name: string) => boolean): string[] {
  const { commands, skipped } = customCommandsFor(app, builtin, true)
  const out: string[] = []
  if (commands.size) {
    out.push('', tt('custom.heading', app.locale))
    for (const c of commands.values()) {
      const where =
        c.scope === 'project' ? ` [${tt('custom.project', app.locale, { path: oneLine(c.shown) })}]` : ''
      out.push(`  /${c.name}${c.hint ? ` ${c.hint}` : ''}  ${c.description}${where}`.trimEnd())
    }
  }
  if (skipped.length) {
    out.push('', tt('custom.skipped', app.locale))
    for (const s of skipped.slice(0, 10))
      out.push(`  ${oneLine(s.file)}: ${tt(s.reason as 'custom.builtin', app.locale)}`)
    if (skipped.length > 10) out.push(`  ... ${skipped.length - 10}`)
  }
  return out
}
