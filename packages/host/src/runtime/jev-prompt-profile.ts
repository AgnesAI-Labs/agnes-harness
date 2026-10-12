import { type PromptSection, sha256Hex } from '@agnes/core'

export const JEV_PROMPT_PROFILE = 'agnes-jev-general-prompt-v3'

// Recognize exact bundled templates, not headings or words that custom instructions may share.
const templates: Readonly<Record<string, { hash: string; text: string }>> = {
  persona: {
    hash: 'e60c94e06a5a49f7a89889405153a0af1eca5205e2823f9a33ed9f3da0f5762f',
    text: "You are Agnes, an agent powered by Agnes Harness. Use the session's facts and available tools to complete the user's goal. The harness records and governs execution; your identity is independent of the model provider. Use provided facts for identity and environment; say when a fact is unknown. Distinguish plans, observed results and unresolved work. Claim completion only when recorded results support it. Never invent capabilities, actions or results. If a step fails or evidence is missing, inspect or use another supported approach. Explain any blocker that prevents further progress.",
  },
  'coding-doctrine': {
    hash: 'e69d3b09d44c2f048413842f8238dc7ab2d25197912e9801adbc367a99c10c0c',
    text: 'Inspect relevant files and interfaces before editing; do not invent paths, imports or APIs. Use cwd-relative output paths unless another destination is requested; a leading slash is absolute. Make the smallest coherent change satisfying the full request. Preserve required successful behavior across supported inputs and stated conditions: do not replace required handling with errors, skips or narrower accepted inputs. Apply policies within their stated scope; output restrictions alone do not imply input or execution restrictions. Retain required security and invalid-input refusals. Use complete arguments and whole or staged writes within actual tool/model limits. For implementation changes, when permitted by the request and current scope, verify ordinary behavior and applicable stated conditions with small independent examples derived from the visible request; isolate verification experiments from original task data and policies. Prefer project test/build commands; report unavailable checks. Report the scope and limitations of actual checks; current examples alone do not establish general requirements. Report changes, verified results and unresolved work concisely.',
  },
}
const environmentHash = '45d73934c04501e58ada42ad012b2ac4989f63ba190b8cecbb84bf15ecb151a1'

function environment(text: string): string | undefined {
  const harness = /^- Harness: Agnes Harness ([^\r\n]+)\.$/mu.exec(text)
  const platform = /^- Platform: ([^\r\n]+)\. Shell dialect for any shell tool: ([^\r\n]+)\.$/mu.exec(text)
  if (!harness || !platform) return
  if (
    !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u.test(harness[1] ?? '') ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(platform[1] ?? '') ||
    !/^(?:posix|sh|bash|zsh|fish|cmd|powershell|pwsh)$/u.test(platform[2] ?? '')
  )
    return
  const normalized = text
    .replace(harness[0], '- Harness: Agnes Harness {{agnesVersion}}.')
    .replace(platform[0], '- Platform: {{platform}}. Shell dialect for any shell tool: {{shell}}.')
  if (sha256Hex(normalized) !== environmentHash) return
  return `Environment: ${JSON.stringify({ harness: harness[1], platform: platform[1], shell: platform[2] })}. Session metadata and cwd are in the latest Host context; its model describes the session default, and a request stage may use another model. The transcript is an append-only ledger; only recorded results support execution claims.`
}

/** JevLoop-only profile. Unknown templates and every workspace/custom obligation pass through. */
export function jevPromptProfile(sections: readonly PromptSection[]): PromptSection[] {
  return sections.map((section) => {
    if (section.source !== '@agnes/code') return section
    const known = templates[section.id]
    const text =
      known && sha256Hex(section.text) === known.hash
        ? known.text
        : section.id === 'environment'
          ? environment(section.text)
          : undefined
    return text === undefined ? section : { ...section, text }
  })
}
