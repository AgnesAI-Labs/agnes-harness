import type { RuntimePromptPreload, WorkspaceInvocationView } from '@agnes/core'
import type { PublicationDispatch } from '../publication-dispatch.js'
import type { WorkspaceInvocationResolver } from '../workspace-invocation-resolver.js'
import type { SkillRuntimeInput } from './skills.js'

const encoder = new TextEncoder()
const MAX_SKILL_BYTES = 32 * 1024
// ASCII directory names can be adjacent to CJK prose. Keep English name boundaries strict.
const ASCII_NAME_CHAR = 'A-Za-z0-9._-'

/** Adds the Host-owned per-session workspace lease boundary to a resource generation snapshot. */
export function bindSkillRuntimeToWorkspace(
  runtime: SkillRuntimeInput,
  workspaceInvocationFor: WorkspaceInvocationResolver,
  publication?: PublicationDispatch,
): SkillRuntimeInput & Required<Pick<SkillRuntimeInput, 'runInWorkspace'>> {
  return Object.freeze({
    ...runtime,
    runInWorkspace: <T>(sessionKey: string, invoke: () => Promise<T>): Promise<T> => {
      const port = workspaceInvocationFor(sessionKey)
      const handler = (view: WorkspaceInvocationView) =>
        runtime.scopeWorkspace ? runtime.scopeWorkspace(view.root, sessionKey, invoke) : invoke()
      return publication ? publication.workspace(() => ({ port, handler })) : port.run(handler)
    },
  })
}

function normalized(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * This is deliberately lexical. Only $name (case-sensitive) or a named Skill suffix opts into
 * loading a body. Ordinary mentions leave discovery to the catalog and skill_read.
 */
export function explicitlyMentionsSkill(prompt: string, name: string): boolean {
  const target = normalized(name)
  if (!target) return false
  const input = normalized(prompt)
  if (new RegExp(`(^|[^${ASCII_NAME_CHAR}])\\$${escaped(target)}(?=$|[^\\p{L}\\p{N}._-])`, 'u').test(input))
    return true
  const lowerTarget = target.toLocaleLowerCase('en-US')
  const lowerInput = input.toLocaleLowerCase('en-US')
  // A CJK name inside a longer CJK word is not an explicit mention. Allow a delimiter or the
  // ordinary "用/使用" verb immediately before it; quoted names start after punctuation.
  const leading = /[^\p{ASCII}]/u.test(target)
    ? '(?:^|[^\\p{L}\\p{N}._-]|(?:请)?(?:使)?用)'
    : `(^|[^${ASCII_NAME_CHAR}])`
  return new RegExp(
    `${leading}["'\x60「『“‘]?${escaped(lowerTarget)}["'\x60」』”’]?\\s*(?:技能|skill)(?=$|[^A-Za-z0-9_-])`,
    'u',
  ).test(lowerInput)
}

/**
 * Builds Core's private current-turn preloader. This closure is Host-owned and is never installed
 * as an extension hook, so raw prompt text does not cross the extension API boundary.
 */
export function createSkillPromptPreloader(
  input: SkillRuntimeInput | (() => SkillRuntimeInput | undefined),
  workspaceInvocationFor: WorkspaceInvocationResolver,
  publication?: PublicationDispatch,
): (input: { sessionKey: string; prompt: string }) => Promise<RuntimePromptPreload | undefined> {
  return ({ sessionKey, prompt }) => {
    // Resolve and enter the session's workspace before touching resource state. Missing sessions
    // therefore fail with E_WORKSPACE_REQUIRED instead of reading a worker-global catalogue.
    const port = workspaceInvocationFor(sessionKey)
    const load = async (runtime: SkillRuntimeInput) => {
      try {
        const matches = runtime
          .list()
          .filter(
            (skill) =>
              skill.actual === 'ready' &&
              skill.desired === 'enabled' &&
              skill.trust === 'trusted' &&
              skill.resolution.winner === true &&
              explicitlyMentionsSkill(prompt, skill.name),
          )
        // A spelling that names more than one current winner is ambiguous. Leave discovery to
        // skill_read instead of choosing a resource body from an accidental normalization collision.
        if (matches.length !== 1) return undefined
        const skill = matches[0]
        if (!skill) return undefined
        const result = runtime.read(skill.resourceId, { sessionKey })
        if (!result.ok) return undefined
        const revision = result.revision ?? skill.revision
        const directory = result.directory && result.directory.length > 0 ? result.directory : '-'
        const body = `resourceId: ${skill.resourceId}\nrevision: ${revision}\ndirectory: ${directory}\n\n${result.content}`
        if (encoder.encode(body).byteLength > MAX_SKILL_BYTES) return undefined
        return {
          key: `${skill.resourceId}@${revision}`,
          note:
            `The user explicitly named the trusted Skill "${skill.name}". Host has already loaded it. ` +
            'Do not search for it or read it again; directly carry out its instructions. ' +
            'Workspace file search tools remain available if those instructions require them.\n' +
            '<active_skill>\n' +
            body +
            '\n</active_skill>',
        }
      } catch {
        // Resource state and authorization are Host-owned. A failed lookup must never turn into a
        // partial body or fail the user's turn; skill_read remains available for normal discovery.
        return undefined
      }
    }
    const handler = (view: WorkspaceInvocationView) => {
      const runtime = typeof input === 'function' ? input() : input
      if (!runtime) return Promise.resolve(undefined)
      return runtime.scopeWorkspace
        ? runtime.scopeWorkspace(view.root, sessionKey, () => load(runtime))
        : load(runtime)
    }
    return publication ? publication.workspace(() => ({ port, handler })) : port.run(handler)
  }
}
