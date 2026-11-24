import type { ChildKind } from '@agnes/core-child-control/child/types'
import type { SystemPromptSection } from '@agnes/protocol'
import type { PinnedSystemPrompt } from '../request/system-prompt.js'
import type { SessionImpl } from '../step/session.js'
import { clipText } from './failure.js'

export const RESULT_DELIVERY_GUIDANCE =
  'Your final answer is delivered automatically to the parent. The parent does not see your intermediate tool outputs. Include findings, evidence, and verified file paths in your final answer. Name risks and unfinished work. Work efficiently within a tight step budget: batch related shell checks into one script instead of many small commands, stop retrying blocked or captcha-gated sources, and return a concise answer as soon as key facts are verified.'

const toolGuidance =
  'Use only tools offered to this worker. Discover deferred tools with tool_search and tool_describe when offered. Discovery grants no execution permission.'
const workerPersona =
  'You are Agnes, working on the delegated task. Follow the assigned role, repository rules, approvals, sandbox and tool limits. Read the actual sources, verify results, and distinguish completed actions from plans. Copy the original before an irreversible change. Use the requested language and report limitations honestly.'

/** Tool schemas and SDK sections already come from the child's filtered registry. Keep custom role and deployment sections verbatim. */
function slimWorkerSections(sections: readonly SystemPromptSection[]) {
  return sections.flatMap((section) => {
    const { id, source } = section
    if (id === 'channel-style' && source === '@agnes/code/prompts/channel-style.md') return []
    if (id === 'persona' && source === '@agnes/code/prompts/persona.md')
      return [{ ...section, text: workerPersona }]
    if (id === 'tools-available' && source === '@agnes/code') return [{ ...section, text: toolGuidance }]
    return [section]
  })
}

function withGuidance(slim: readonly SystemPromptSection[]) {
  // Reuse the existing persona slot. A deployment may instead provide one full override.
  const section = slim.find((s) => s.id === 'persona') ?? slim[0]
  if (!section) return [{ id: 'persona', order: 1, source: 'core', text: RESULT_DELIVERY_GUIDANCE }]
  return slim.map((s) => (s === section ? { ...s, text: `${s.text}\n\n${RESULT_DELIVERY_GUIDANCE}` } : s))
}

export function childPromptSections(kind: ChildKind, sections: readonly SystemPromptSection[]) {
  return kind === 'spawn' ? withGuidance(slimWorkerSections(sections)) : sections
}

/** Decorate the existing composer so owner overrides and live role/tool authority stay in force. */
export function childPromptBinding(
  kind: ChildKind,
  binding?: PinnedSystemPrompt,
): PinnedSystemPrompt | undefined {
  if (kind !== 'spawn') return binding
  const provider = binding?.provider
  return {
    config: binding?.config ?? {},
    provider: {
      id: provider?.id ?? 'core.child-prompt',
      version: provider?.version ?? '1.0.0',
      defaults: () => childPromptSections(kind, provider?.defaults() ?? []),
      compose: (config, sections) => {
        const slim = slimWorkerSections(sections)
        return withGuidance(provider?.compose(config, slim) ?? slim)
      },
    },
  }
}

const bound = new WeakSet<SessionImpl>()
export function bindChildPrompt(kind: ChildKind, child: SessionImpl) {
  if (kind === 'spawn' && !bound.has(child)) {
    const prompt = childPromptBinding(kind, child.d.systemPrompt)
    if (prompt) child.d.systemPrompt = prompt
    bound.add(child)
  }
}

/** Keep the full answer in the child ledger. Paths are atomic: never turn a clipped prefix into an artifact reference. */
export function compactChildHandoff(findings: string, verifiedPaths: readonly string[] = [], risks = '') {
  const summary = clipText(findings.trim(), 640)
  const outstanding = clipText(risks.trim(), 320)
  const paths: string[] = []
  let pathChars = 0
  for (const path of verifiedPaths) {
    if (!path || pathChars + path.length + 1 > 240) continue
    paths.push(path)
    pathChars += path.length + 1
  }
  return {
    findings: summary,
    verifiedPaths: paths,
    risks: outstanding,
    truncated:
      summary !== findings.trim() || outstanding !== risks.trim() || paths.length < verifiedPaths.length,
  }
}
