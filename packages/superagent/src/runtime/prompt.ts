// Adapted from dsh-superagent (MIT)
/**
 * The Superagent prompt section each request carries: the prompt revision, the team's composed prompt for the role, the
 * ticket's environment and its mandate. The `context` hook rebuilds it on every request, so a saved revision applies at
 * the next request and an unchanged one leaves the request prefix byte for byte as it was. The revision's skills are
 * written into the AGH home's skill directory, which AGH watches and reloads.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import type { Variable } from '../app/execution-environment.js'
import { type Prompts, type PromptVersion, SKILL_PREFIX } from '../app/prompts.js'
import { bundledSkills } from '../app/skill-files.js'
import type { Store } from '../app/store.js'
import type { Ticket } from '../core/index.js'
import { BUSY_DELAYS_MS, retryBusySync } from '../infra/busy.js'
import { HOST_PLATFORM, isWindows } from '../infra/platform.js'
import { KV } from '../kv.js'
import type { Health } from '../sources/host.js'
import { mandateInstructions } from './assignment.js'
import type { SessionRole } from './sessions.js'
import { forShell, WINDOWS_SHELL_NOTE } from './shell-text.js'

export interface PromptHost {
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly store: Pick<Store, 'get' | 'set' | 'keys' | 'tickets'>
  /** The worker's environment section of `ticket`, or undefined while setup has not resolved the deployment. */
  environment(ticket: Ticket): Variable[] | undefined
  /** Writes a revision's skills; called whenever a session starts working under a revision that has not been written. */
  readonly skills?: SkillFiles
  /** The operating system the sessions' commands run on, this process's by default (see `forShell`). */
  readonly platform?: string
}

/**
 * The section text, and the revision it was composed from, for the sessions' shell (see `forShell`); a Windows worker is
 * also told about its shell.
 */
export function sectionText(host: PromptHost, version: PromptVersion, role: SessionRole): string {
  const platform = host.platform ?? HOST_PLATFORM
  const ticket = role.kind === 'worker' ? host.store.tickets.get(role.ticketId) : undefined
  const composed = host.prompts.compose(
    version.config,
    role.kind,
    ticket ? host.environment(ticket) : undefined,
  )
  const note = isWindows(platform) && role.kind === 'worker' ? `${WINDOWS_SHELL_NOTE}\n` : ''
  return forShell(
    `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${note}${ticket ? mandateInstructions(ticket.mandate) : ''}`,
    platform,
  )
}

/** Prompt revisions by session: the one a session works under, and those it may read. */
export class PromptBinding {
  constructor(private readonly host: PromptHost) {}
  /** The text of a model request now: binds the current revision to the session and writes its skills when new. */
  request(sessionId: string, role: SessionRole): string {
    const version = this.host.prompts.current()
    const revisions = this.host.store.get(KV.sessions.prompts(sessionId)) ?? []
    if (revisions.at(-1) !== version.revision)
      this.host.store.set(KV.sessions.prompts(sessionId), [
        ...revisions.filter((revision) => revision !== version.revision),
        version.revision,
      ])
    this.host.skills?.write(version)
    return sectionText(this.host, version, role)
  }
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  mayRead(sessionId: string, revision: number): boolean {
    return (
      revision === this.promptVersion(sessionId).revision ||
      (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
    )
  }
  /** The current revision, and the revision each of `sessionIds` last worked under. */
  status(sessionIds: readonly string[]) {
    const sessions = sessionIds.flatMap((sessionId) => {
      const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
      return revision === undefined ? [] : [{ sessionId, revision }]
    })
    return { revision: this.host.prompts.current().revision, sessions }
  }
}

/** The AGH home of this process: `AGH_HOME`, or `.agh` in the home directory. */
export function aghHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.AGH_HOME || join(env.HOME || homedir(), AGH_DIR)
}
/** Marks a skill directory Superagent wrote, so it never removes one it did not write. */
const MARK = '.superagent-revision'

/** Where `SkillFiles` reports writes that failed, and that they work again; the panel shows it. */
export interface SkillFilesHealth {
  set(health: Health): void
}
/** The options of `SkillFiles`: the sessions' platform, where it reports, and the pauses of its retries. */
export interface SkillFilesOptions {
  platform?: string
  health?: SkillFilesHealth
  busyDelaysMs?: readonly number[]
}

/**
 * Superagent's skills as files in `<AGH home>/skills/dsh-superagent-<name>/SKILL.md`, in the text the sessions' shell
 * reads (see `forShell`). A revision's skills replace the previous revision's; a skill directory without Superagent's
 * mark is left alone. A file another program holds (as Windows reports while it is open) is retried a few times; if it
 * stays held, the failure is reported to `health` and the write is tried again at the next request, which goes on with
 * the skills as they were.
 */
export class SkillFiles {
  private written?: number
  private failing = false
  constructor(
    private readonly prompts: Pick<Prompts, 'skills'>,
    private readonly root: string,
    private readonly options: SkillFilesOptions = {},
  ) {}
  write(version: PromptVersion): void {
    if (this.written === version.revision) return
    const platform = this.options.platform ?? HOST_PLATFORM
    try {
      this.replace(version, platform)
    } catch (error) {
      if (!this.options.health) throw error
      this.failing = true
      this.options.health.set({
        state: 'error',
        detail: `The skill files in ${this.root} could not be written; retrying at the next request: ${String(error)}`,
        at: new Date().toISOString(),
      })
      return
    }
    if (this.failing) this.options.health?.set({ state: 'ready', detail: 'The skill files are written' })
    this.failing = false
    this.written = version.revision
  }
  private replace(version: PromptVersion, platform: string): void {
    const delays = this.options.busyDelaysMs ?? BUSY_DELAYS_MS
    mkdirSync(this.root, { recursive: true })
    const wanted = new Map<string, string>()
    for (const [name, content] of this.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const description =
        bundled?.description ??
        (content.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Custom Superagent skill.')
      wanted.set(
        `${SKILL_PREFIX}${name}`,
        `---\nname: ${SKILL_PREFIX}${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${forShell(content, platform)}\n`,
      )
    }
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      const dir = join(this.root, entry.name)
      if (entry.isDirectory() && !wanted.has(entry.name) && existsSync(join(dir, MARK)))
        retryBusySync(() => rmSync(dir, { recursive: true, force: true }), platform, delays)
    }
    for (const [name, text] of wanted) {
      const dir = join(this.root, name)
      if (existsSync(dir) && !existsSync(join(dir, MARK))) continue
      mkdirSync(dir, { recursive: true })
      retryBusySync(() => replaceChanged(dir, 'SKILL.md', text), platform, delays)
      retryBusySync(() => replaceChanged(dir, MARK, `${version.revision}\n`), platform, delays)
    }
  }
}

/**
 * Replaces `dir/name` whole with `text` (a temporary file renamed over it), and only when its content differs: every
 * write of a skill file makes AGH reload the skills, during which a skill reads as missing, so a start that finds its
 * skills as they were leaves them untouched.
 */
function replaceChanged(dir: string, name: string, text: string): void {
  const path = join(dir, name)
  try {
    if (readFileSync(path, 'utf8') === text) return
  } catch {
    // Missing or unreadable: written below.
  }
  const temporary = join(dir, `.${name}.${process.pid}`)
  writeFileSync(temporary, text)
  renameSync(temporary, path)
}
