import type { RuntimePromptPreload, WorkspaceInvocationView } from '@agnes/core'
import type { PublicationDispatch } from '../publication-dispatch.js'
import type { WorkspaceInvocationResolver } from '../workspace-invocation-resolver.js'
import type { SkillRuntimeInput } from './skills.js'

const encoder = new TextEncoder()
const MAX_SKILL_BYTES = 32 * 1024
// ASCII directory names can be adjacent to CJK prose. Keep English name boundaries strict.
const ASCII_NAME_CHAR = 'A-Za-z0-9._-'
const LOADED_SKILL_SUPPRESSED_TOOLS = Object.freeze(['tool_search', 'skill_read'])

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
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * This is deliberately lexical. A prompt may load one Skill only when it contains the complete
 * normalized name at a word boundary; semantic matching would turn a private resource into a
 * prompt-derived discovery channel.
 */
export function explicitlyMentionsSkill(prompt: string, name: string): boolean {
  const target = normalized(name)
  if (!target) return false
  const input = normalized(prompt)
  // CJK prose does not have ASCII-style token delimiters: `使用语文老师技能` explicitly contains the
  // complete configured name even though its leading character is a letter. The trailing side is
  // still closed: punctuation, whitespace, end of text, or the explicit Skill suffix are allowed;
  // a prefix such as `语文老` before `师` is refused. This is lexical equality, not semantic search.
  if (/[^\p{ASCII}]/u.test(target))
    return new RegExp(`${escaped(target)}(?=$|[\\s\\p{P}]|技能|skill)`, 'u').test(input)
  return new RegExp(`(^|[^${ASCII_NAME_CHAR}])${escaped(target)}(?=$|[^${ASCII_NAME_CHAR}])`, 'u').test(input)
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
          suppressTools: LOADED_SKILL_SUPPRESSED_TOOLS,
          section: {
            id: `skill-preload:${skill.resourceId}`,
            order: 151,
            source: 'runtime:skill-preload',
            text:
              `The user explicitly named the trusted Skill "${skill.name}". Host has already loaded it for this turn. ` +
              'Do not search for it or read it again; directly carry out its instructions. ' +
              'Workspace file search tools remain available if those instructions require them.\n' +
              '<active_skill>\n' +
              body +
              '\n</active_skill>',
          },
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
