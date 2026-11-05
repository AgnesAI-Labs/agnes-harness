import { createHash } from 'node:crypto'
import type { RefinementWorkflowRuns, WorkflowRunView } from '@agnes/core'
import { redactEvidence } from '@agnes/core'
import type { WorkflowRunSource } from '@agnes/host-extensions/assemble/packages'
import type { SkillDraft } from '@agnes/host-extensions/resources/refinement-skill-install'
import type { SaveRefusal } from '@agnes/host-infrastructure/refinement-registry'
import { SECRET_LIKE } from './save-rules.js'
import { skillDraftOf } from './skill-drafts.js'

export type { WorkflowRunView }

/** The largest `SKILL.md` the installer takes: one file of a skill. */
export const MAX_SKILL_FILE_BYTES = 256 * 1024

/**
 * The host's answer to which `workflow` runs of a session may become a skill. The run record is the
 * workflow plugin's `runs` projection, offered by the plugin and folded here for that session's own
 * ledger alone (`state`), so a run of another session is never found. No offer, a projection that
 * cannot be read, or a run that is not in it, is `not-found`; the plugin's reader says whether a run
 * that is there finished with every member completed.
 */
export function createWorkflowRuns(o: {
  /** The projection state of one session as the offered source names it; undefined when it cannot be read. */
  state(session: {
    key: string
    lane: string
  }): Promise<{ source: WorkflowRunSource; state: unknown } | undefined>
}): RefinementWorkflowRuns {
  return {
    async read(session, runId) {
      let offered: Awaited<ReturnType<typeof o.state>>
      try {
        offered = await o.state(session)
      } catch {
        return 'not-found'
      }
      if (!offered) return 'not-found'
      const found = offered.source.reader(offered.state).finished(runId)
      if (found === undefined) return 'not-found'
      return found === 'not-completed' ? found : structuredClone(found)
    },
  }
}

/** The definition in its one canonical form: stages and members in their order, keys in a fixed order. */
const definitionOf = (view: WorkflowRunView) => ({
  name: view.name,
  stages: view.stages.map((stage) => ({
    name: stage.name,
    members: stage.members.map((member) => ({ name: member.name, task: member.task })),
  })),
})

/**
 * The hash that recognises a definition again: the hash of the stages (names and tasks, in order) with
 * the whitespace of each text trimmed and collapsed, so the same stages count as one definition whatever
 * the run was called and however the text is spaced. Letter case is kept: it can matter in a task (a
 * path, a branch name).
 */
export const normalizedWorkflowHash = (view: WorkflowRunView): string => {
  const plain = (text: string) => text.trim().replace(/\s+/gu, ' ')
  return createHash('sha256')
    .update(
      JSON.stringify(
        view.stages.map((stage) => [
          plain(stage.name),
          stage.members.map((member) => [plain(member.name), plain(member.task)]),
        ]),
      ),
    )
    .digest('hex')
}

/** The planner's text with every fenced block taken out: a definition is never taken from it. */
export function withoutFencedBlocks(text: string): string {
  const kept: string[] = []
  let fence: string | undefined
  for (const line of text.split(/\r?\n/u)) {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line)?.[1]
    if (fence === undefined) {
      if (marker === undefined) kept.push(line)
      else fence = marker
    } else if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length)
      fence = undefined
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/**
 * The body of the skill a finished run becomes: when to use it (the planner's words, without any
 * block it wrote itself), one sentence saying to run it with the `workflow` tool, and the definition
 * as one `json` block of `{ name, stages }`. The same view and text always give the same bytes.
 */
export function renderWorkflowSkillBody(view: WorkflowRunView, whenToUse: string): string {
  const when = withoutFencedBlocks(whenToUse)
  return [
    ...(when ? [when, ''] : []),
    'Run this with the `workflow` tool, passing `name` and `stages` below unchanged.',
    '',
    '```json',
    JSON.stringify(definitionOf(view), null, 2),
    '```',
    '',
  ].join('\n')
}

/**
 * The refusal for a definition whose text the source rules would not accept as an entry: any name or
 * task that redaction would change, or that looks like a credential. Nothing is rewritten.
 */
export function workflowTextProblem(view: WorkflowRunView): SaveRefusal | undefined {
  const texts = [
    view.name,
    ...view.stages.flatMap((s) => [s.name, ...s.members.flatMap((m) => [m.name, m.task])]),
  ]
  return texts.some((text) => redactEvidence(text) !== text || SECRET_LIKE.test(text))
    ? 'source-rules'
    : undefined
}

/**
 * The skill a finished run becomes for the entry that names it: its title and name, the generated body.
 * `static-check` when the name or title cannot make a saved skill, `workflow-definition-too-large` when
 * the skill file would pass the installer's limit (nothing is cut).
 */
export function workflowSkillDraft(
  view: WorkflowRunView,
  entry: { id: string; title: string; content: string },
): SkillDraft | { refused: 'workflow-definition-too-large' | 'static-check' } {
  const when = withoutFencedBlocks(entry.content) || entry.title
  const draft = skillDraftOf({
    id: entry.id,
    title: entry.title,
    content: renderWorkflowSkillBody(view, when),
  })
  if (!draft) return { refused: 'static-check' }
  const bytes = Buffer.byteLength(draft.files[0]?.content ?? '', 'utf8')
  return bytes > MAX_SKILL_FILE_BYTES ? { refused: 'workflow-definition-too-large' } : draft
}
