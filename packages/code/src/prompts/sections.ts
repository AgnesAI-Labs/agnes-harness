import { readFileSync } from 'node:fs'

/** Replaced with reviewed package assets by the CLI SEA build. */
declare const AGNES_CODE_PROMPT_TEXTS: Readonly<Record<string, string>> | undefined

export type PromptSectionSpec = {
  id: string
  order: number
  /** `file`: shipped as `prompts/<id>.md`. `dynamic`: built at assembly time from live facts. */
  source: 'file' | 'dynamic'
  /** Which package supplies the text. Sections owned elsewhere are registered here only so that
   * every order number in the assembled prompt has exactly one claimant. */
  owner: 'code' | 'base'
}

const OWNERS: ReadonlyArray<PromptSectionSpec['owner']> = ['code', 'base']

/**
 * Refuses a table that cannot produce one deterministic prompt. Two sections holding the same order
 * sort against each other by contributor name, so which of them the model reads first would depend
 * on what the assembly happened to be called; a section with no owner is a slot nobody has to fill,
 * and it fails as a hole in the prompt rather than as an error. Both are refused where the table is
 * written, not where the request is assembled, so a bad table cannot be shipped at all.
 */
export function validateSections(specs: ReadonlyArray<PromptSectionSpec>): ReadonlyArray<PromptSectionSpec> {
  const claimed = new Map<number, string>()
  const ids = new Set<string>()
  for (const s of specs) {
    if (!OWNERS.includes(s.owner)) throw new Error(`prompt section ${s.id} has no claimant`)
    if (!Number.isInteger(s.order)) throw new Error(`prompt section ${s.id} has a non-integer order`)
    if (ids.has(s.id)) throw new Error(`duplicate prompt section: ${s.id}`)
    const held = claimed.get(s.order)
    if (held !== undefined)
      throw new Error(`prompt section order ${s.order} is claimed by ${held} and ${s.id}`)
    ids.add(s.id)
    claimed.set(s.order, s.id)
  }
  return specs
}

/**
 * The assembled system prompt in order. Order 0 is the model contract prefix, which the provider
 * injects and this package never touches, so it is not listed. The numbers are frozen: they are
 * gaps of ten so a section can be inserted later without renumbering the ones around it.
 */
export const PROMPT_SECTIONS: ReadonlyArray<PromptSectionSpec> = validateSections([
  { id: 'persona', order: 100, source: 'file', owner: 'code' },
  { id: 'environment', order: 110, source: 'dynamic', owner: 'code' },
  // Order 115, formerly 'tools-available', is retired rather than reassigned: the tool list moved
  // to the runtime-context tail message (code-mode/prompts.ts's contribute()), and the gaps of ten
  // exist precisely so a retirement like this one does not force renumbering everything below it.
  //
  // The row below, 'agents-md', is reserved for base and not yet implemented: no file under
  // packages/base currently registers a section with this id. If a base file ever claims order 120,
  // tools/guards/src/prompt-section-order.test.ts requires that claim's id to be 'agents-md' -- the
  // guard does not, on its own, confirm that nothing has claimed the order in the meantime. The slot
  // is reserved now so that when base ships AGENTS.md support it has an already-agreed position
  // between environment and coding-doctrine, instead of a later change renumbering this table to
  // make room.
  { id: 'agents-md', order: 120, source: 'dynamic', owner: 'base' },
  { id: 'coding-doctrine', order: 130, source: 'file', owner: 'code' },
  { id: 'code-doctrine', order: 140, source: 'file', owner: 'code' },
  { id: 'tools:sdk', order: 150, source: 'dynamic', owner: 'code' },
  // Skill routing catalog. It is a context-hook section, not additionalContext: the shared
  // additionalContext channel is capped at 8192 bytes by the hook schema.
  { id: 'skills', order: 160, source: 'dynamic', owner: 'base' },
  { id: 'channel-style', order: 170, source: 'file', owner: 'code' },
])

export function sectionOrder(id: string): number {
  const spec = PROMPT_SECTIONS.find((s) => s.id === id)
  if (!spec) throw new Error(`unregistered prompt section: ${id}`)
  return spec.order
}

/**
 * Drops a leading YAML frontmatter block. An unterminated `---` is not a block: treating it as one
 * would delete the whole prompt, and an empty section is far harder to notice than a stray fence.
 */
export function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, '')
}

/** Fills `{{name}}` placeholders. An unknown name is left standing rather than raising: a prompt
 * that is missing one fact is still usable, and the literal braces make the gap visible. */
export function applyVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole)
}

export function loadPrompt(id: string): string {
  if (typeof AGNES_CODE_PROMPT_TEXTS !== 'undefined') {
    const text = AGNES_CODE_PROMPT_TEXTS[id]
    if (text === undefined) throw new Error(`missing bundled prompt ${id}`)
    return stripFrontmatter(text).trimEnd()
  }
  const url = new URL(`../../prompts/${id}.md`, import.meta.url)
  return stripFrontmatter(readFileSync(url, 'utf8')).trimEnd()
}

/**
 * Persona used to interpolate the model id and the cwd straight into this section's text, which
 * meant switching either one rewrote system's very first section on every request. Both facts are
 * still stated to the model, just not here: they are part of runtimeSnapshotFacts()
 * (code-mode/prompts.ts), rendered into the tail runtime-context message instead of a
 * system-prompt section.
 */
export function renderPersona(): string {
  return loadPrompt('persona')
}
