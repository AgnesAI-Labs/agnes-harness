// Adapted from dsh-superagent (MIT)
/**
 * The Superagent prompt section each request carries: the prompt revision, the team's composed prompt for the role, the
 * ticket's environment and its mandate. The `context` hook rebuilds it on every request, so a saved revision applies at
 * the next request and an unchanged one leaves the request prefix byte for byte as it was. The revision's skills are
 * written into the AGH home's skill directory, which AGH watches and reloads.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import type { Variable } from '../app/execution-environment.js'
import { type Prompts, type PromptVersion, SKILL_PREFIX } from '../app/prompts.js'
import { bundledSkills } from '../app/skill-files.js'
import type { Store } from '../app/store.js'
import type { Ticket } from '../core/index.js'
import { KV } from '../kv.js'
import { mandateInstructions } from './assignment.js'
import type { SessionRole } from './sessions.js'

export interface PromptHost {
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly store: Pick<Store, 'get' | 'set' | 'keys' | 'tickets'>
  /** The worker's environment section of `ticket`, or undefined while setup has not resolved the deployment. */
  environment(ticket: Ticket): Variable[] | undefined
  /** Writes a revision's skills; called whenever a session starts working under a revision that has not been written. */
  readonly skills?: SkillFiles
}

/** The section text, and the revision it was composed from. */
export function sectionText(host: PromptHost, version: PromptVersion, role: SessionRole): string {
  const ticket = role.kind === 'worker' ? host.store.tickets.get(role.ticketId) : undefined
  const composed = host.prompts.compose(
    version.config,
    role.kind,
    ticket ? host.environment(ticket) : undefined,
  )
  return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${ticket ? mandateInstructions(ticket.mandate) : ''}`
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

/**
 * Superagent's skills as files in `<AGH home>/skills/dsh-superagent-<name>/SKILL.md`. A revision's skills replace the
 * previous revision's; a skill directory without Superagent's mark is left alone.
 */
export class SkillFiles {
  private written?: number
  constructor(
    private readonly prompts: Pick<Prompts, 'skills'>,
    private readonly root: string,
  ) {}
  write(version: PromptVersion): void {
    if (this.written === version.revision) return
    mkdirSync(this.root, { recursive: true })
    const wanted = new Map<string, string>()
    for (const [name, content] of this.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const description =
        bundled?.description ??
        (content.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Custom Superagent skill.')
      wanted.set(
        `${SKILL_PREFIX}${name}`,
        `---\nname: ${SKILL_PREFIX}${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${content}\n`,
      )
    }
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      const dir = join(this.root, entry.name)
      if (entry.isDirectory() && !wanted.has(entry.name) && existsSync(join(dir, MARK)))
        rmSync(dir, { recursive: true, force: true })
    }
    for (const [name, text] of wanted) {
      const dir = join(this.root, name)
      if (existsSync(dir) && !existsSync(join(dir, MARK))) continue
      mkdirSync(dir, { recursive: true })
      const temporary = join(dir, `.SKILL.md.${process.pid}`)
      writeFileSync(temporary, text)
      renameSync(temporary, join(dir, 'SKILL.md'))
      writeFileSync(join(dir, MARK), `${version.revision}\n`)
    }
    this.written = version.revision
  }
}
