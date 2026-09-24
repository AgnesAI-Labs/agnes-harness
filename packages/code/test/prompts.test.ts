import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  loadPrompt,
  PROMPT_SECTIONS,
  renderEnvironment,
  renderPersona,
  renderTools,
  sectionOrder,
  validateSections,
} from '../src/index.js'
import { applyVars, stripFrontmatter } from '../src/prompts/sections.js'

const promptsDir = new URL('../prompts/', import.meta.url)
const shippedFiles = readdirSync(promptsDir)
  .filter((f) => f.endsWith('.md'))
  .sort()

describe('prompt section order table', () => {
  it('registers every section at its frozen order', () => {
    expect(PROMPT_SECTIONS.map((s) => [s.id, s.order])).toEqual([
      ['persona', 100],
      ['environment', 110],
      ['agents-md', 120],
      ['coding-doctrine', 130],
      ['code-doctrine', 140],
      ['tools:sdk', 150],
      ['skills', 160],
      ['channel-style', 170],
    ])
    expect(sectionOrder('code-doctrine')).toBe(140)
    expect(() => sectionOrder('nope')).toThrow(/unregistered prompt section/)
  })

  // A property rather than a restatement of the table above: two sections at the same order have no
  // defined relative position, and a table that is not sorted would assemble a prompt in an order
  // nobody wrote down.
  it('keeps orders unique and strictly increasing', () => {
    const orders = PROMPT_SECTIONS.map((s) => s.order)
    expect(new Set(orders).size).toBe(orders.length)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('records who supplies each section, and registers the other packages only to reserve an order', () => {
    const byOwner = (owner: string) => PROMPT_SECTIONS.filter((s) => s.owner === owner).map((s) => s.id)
    expect(byOwner('base')).toEqual(['agents-md', 'skills'])
    expect(byOwner('code')).toEqual([
      'persona',
      'environment',
      'coding-doctrine',
      'code-doctrine',
      'tools:sdk',
      'channel-style',
    ])
    // Nothing this package does not own may be shipped as a file from here.
    for (const s of PROMPT_SECTIONS) if (s.source === 'file') expect(s.owner, s.id).toBe('code')
  })

  it('marks which sections this package ships as files', () => {
    const files = PROMPT_SECTIONS.filter((s) => s.source === 'file').map((s) => s.id)
    expect(files).toEqual(['persona', 'coding-doctrine', 'code-doctrine', 'channel-style'])
  })

  // Which shipped file serves which registered section. Most sections are one file, but a dynamic
  // section may ship more than one template and pick between them at render time, so the mapping is
  // stated rather than derived from the filename.
  const SERVES: Record<string, string> = {
    'channel-style.md': 'channel-style',
    'code-doctrine.md': 'code-doctrine',
    'coding-doctrine.md': 'coding-doctrine',
    'environment.md': 'environment',
    'persona.md': 'persona',
  }
  // Loaded directly by renderTools() (code-mode/environment.ts), not registered in PROMPT_SECTIONS:
  // their content moved out of the assembled system prompt and into the runtime-context tail message,
  // so there is no section id left for them to serve.
  const NON_SECTION_FILES = ['tools-available.md', 'tools-none.md']

  it('ships exactly the prompt files the table accounts for', () => {
    expect(shippedFiles).toEqual([...Object.keys(SERVES), ...NON_SECTION_FILES].sort())
    const ids = new Set(PROMPT_SECTIONS.map((s) => s.id))
    for (const f of Object.keys(SERVES)) expect(ids.has(SERVES[f] as string), f).toBe(true)
    for (const s of PROMPT_SECTIONS)
      if (s.source === 'file') expect(loadPrompt(s.id).length, s.id).toBeGreaterThan(0)
    for (const f of NON_SECTION_FILES)
      expect(readFileSync(new URL(f, promptsDir), 'utf8').length, f).toBeGreaterThan(0)
  })

  it('refuses a table that cannot assemble one deterministic prompt', () => {
    const ok = { id: 'a', order: 1, source: 'file', owner: 'code' } as const
    expect(() => validateSections([ok, { ...ok, id: 'b', order: 1 }])).toThrow(
      /order 1 is claimed by a and b/,
    )
    expect(() => validateSections([ok, { ...ok, order: 2 }])).toThrow(/duplicate prompt section: a/)
    expect(() => validateSections([{ ...ok, owner: 'nobody' as unknown as 'code' }])).toThrow(
      /has no claimant/,
    )
    expect(() => validateSections([{ ...ok, order: 1.5 }])).toThrow(/non-integer order/)
    // The shipped table is the same object the validator returned, so it cannot have skipped it.
    expect(validateSections(PROMPT_SECTIONS)).toBe(PROMPT_SECTIONS)
  })
})

// Golden text. These bytes are the product's voice and two of these sections are hashed into the
// request header, so a reworded sentence is a change to a shipped artefact, not a style edit. The
// needle assertions below say what each prompt must *mean*; this table says what it must *be*, and
// it is the only thing that notices an edit to a sentence no needle happens to quote.
const PROMPT_TEXT: Record<string, string> = {
  'channel-style': [
    'You are answering in a chat channel.',
    '',
    '- Keep replies short enough to read on a phone. One idea per message.',
    '- Do not use markdown tables or nested lists; the channel may not render them.',
    '- Report progress once per turn, not per step.',
    '- Put file contents and long output behind an artifact reference rather than pasting them.',
  ].join('\n'),
  'code-doctrine': [
    'You act by writing code. One `run_code` call is one program, not one command.',
    '',
    '- Variables, imports, and helper functions persist across cells in this kernel. Build on what you already defined.',
    '- `%%bash` must be the first line of a cell to run shell. Each `%%bash` cell is a throw-away subshell: `cd`, `export`, and shell variables do not carry to later cells. Python state does.',
    '- Assign large reads and searches to named variables and print only a summary. Never dump a whole file or a whole search result into the transcript.',
    '- Do not poll with `time.sleep` or a shell `sleep`. Start long work, record its handle, end the turn, and collect the result next turn.',
    "- Do not install dependencies into this kernel to make an external project import or run. Use that project's own environment through `%%bash`.",
    '- Every `await tools.<name>(...)` call goes back through the harness: approval, sandbox, and accounting all apply, and each call can raise `agnes.BridgeError`. Catch it and adapt rather than letting the whole cell die.',
  ].join('\n'),
  'coding-doctrine': [
    'When working with code or repository files:',
    '',
    '- Read the file before editing it. Never guess a path, an import name, or an API shape.',
    '- Change one thing at a time and verify it before moving on. Prefer the smallest edit that works.',
    "- Run the project's own test or build command to check your work. If none exists, say so instead of inventing one.",
    '- Keep output short. Report what changed, what you verified, and what is still open.',
    '- Leave the workspace consistent: no half-applied edits, no stray files.',
  ].join('\n'),
  environment: [
    'Your situation on this request. Every line is a fact the harness measured; none of it is a guess.',
    '',
    '- Harness: Agnes Harness {{agnesVersion}}.',
    '- Platform: {{platform}}. Shell dialect for any shell tool: {{shell}}.',
    '- Date: {{date}}.',
    '- Transcript: this session is an append-only event ledger the harness keeps under the session key {{sessionKey}}. Your requests, your answers, every tool call and every tool result are rows in it. Nothing outside that ledger carries over between sessions.',
    '',
    'Which model answers this request, which preset and tool-disclosure mode apply, your working directory, and the operating-system sandbox level in force are stated in the most recent message beginning "[runtime context]", not here: those five facts can change between requests in the same session, and restating them here would rewrite this section every time one does.',
  ].join('\n'),
  persona: [
    'You are Agnes, a general-purpose AI agent powered by Agnes Harness. You help users understand problems, plan work, and complete tasks using the tools and capabilities available in the current session.',
    '',
    "Agnes Harness runs your execution loop, registers the tools you can call, enforces approval and sandboxing, and keeps this session's transcript. The harness and the model are separate: the harness supports different models, and your identity as Agnes does not depend on the model provider.",
    '',
    'Answer questions about what you are from this prompt and from the situation described below it, not from what you recall about yourself. Where a fact you need is not stated here, say you do not have it instead of supplying a plausible one.',
    '',
    "Understand the user's goal and inspect relevant information before acting. Distinguish plans from actions you have actually taken, and explain results clearly.",
    'You do not claim a task is done until the evidence for it exists in this session.',
    'When you cannot do something, you say so plainly and stop; you never simulate a result.',
  ].join('\n'),
  'tools-available': [
    "The tools named in this request's tools field are the complete set offered this turn. You have no others: no filesystem access, no command execution and no network access except through one of them. When a task needs something the list does not cover, say which capability is missing rather than describing what you would have done with it.",
  ].join('\n'),
  'tools-none': [
    'You have no tools on this request. The harness registered none, so you cannot read or write files, run commands, or reach the network. Answer from this conversation alone, and say plainly when a question needs a capability you do not have.',
  ].join('\n'),
}

describe('prompt text', () => {
  it('ships exactly the bytes recorded for every prompt, and records every prompt it ships', () => {
    expect(Object.keys(PROMPT_TEXT).sort()).toEqual(shippedFiles.map((f) => f.replace(/\.md$/, '')))
    for (const [id, text] of Object.entries(PROMPT_TEXT)) expect(loadPrompt(id), id).toBe(text)
  })

  // These bytes go to the model and two of them are hashed into the request header, so a stray
  // localised sentence would change the hash and is a defect, not a style preference. The range
  // covers CJK punctuation, kana, ideographs and fullwidth forms, not only the ideograph block.
  it('keeps every shipped prompt in English', () => {
    for (const f of shippedFiles)
      expect(readFileSync(new URL(f, promptsDir), 'utf8'), f).not.toMatch(/[　-鿿＀-￯]/)
  })

  it('code-doctrine carries every discipline of writing code against a live kernel', () => {
    const t = loadPrompt('code-doctrine')
    for (const needle of [
      'persist across cells',
      '`%%bash` must be the first line',
      'print only a summary',
      'Do not poll with `time.sleep`',
      'Do not install dependencies into this kernel',
      'end the turn, and collect the result next turn',
    ])
      expect(t, needle).toContain(needle)
  })

  it('coding-doctrine carries the disciplines of editing a repository directly', () => {
    const t = loadPrompt('coding-doctrine')
    for (const needle of [
      'Read the file before editing it',
      'Change one thing at a time',
      "Run the project's own test or build command",
      'Keep output short',
    ])
      expect(t, needle).toContain(needle)
  })

  it('environment.md is a template with the documented placeholders', () => {
    const t = loadPrompt('environment')
    for (const p of ['{{platform}}', '{{shell}}', '{{date}}', '{{agnesVersion}}', '{{sessionKey}}'])
      expect(t, p).toContain(p)
    for (const moved of [
      '{{cwd}}',
      '{{slot}}',
      '{{route}}',
      '{{model}}',
      '{{preset}}',
      '{{disclosure}}',
      '{{enforcement}}',
    ])
      expect(t, moved).not.toContain(moved)
  })

  // The situational facts the model has to be able to state back. Each needle is a fact the harness
  // measures rather than a phrase it likes, so a rewording that drops one is a loss of information.
  it('persona and environment together name the harness and the transcript, and name neither the model nor the cwd', () => {
    const t = `${loadPrompt('persona')}\n${loadPrompt('environment')}`
    for (const needle of ['Agnes Harness', 'append-only event ledger', 'session key {{sessionKey}}'])
      expect(t, needle).toContain(needle)
    for (const moved of ['{{model}}', '{{cwd}}']) expect(t, moved).not.toContain(moved)
  })

  it('the tool templates never promise a capability the list does not carry', () => {
    expect(loadPrompt('tools-available')).not.toContain('{{')
    expect(loadPrompt('tools-available')).toContain('complete set offered this turn')
    expect(loadPrompt('tools-none')).toContain('You have no tools on this request')
    expect(loadPrompt('tools-none')).not.toContain('{{')
  })
})

describe('prompt rendering', () => {
  it('renders persona with no placeholders standing', () => {
    const text = renderPersona()
    expect(text).toContain('You are Agnes, a general-purpose AI agent powered by Agnes Harness.')
    expect(text).not.toContain('{{')
  })

  const facts = {
    agnesVersion: '0.1.0',
    platform: 'darwin-arm64',
    shell: 'posix',
    date: '2026-09-09',
    sessionKey: 'agnes:local:local-dev:cli:workspace:f63a',
  }

  it('fills every environment placeholder, leaving none standing', () => {
    const text = renderEnvironment(facts)
    expect(text).not.toContain('{{')
    for (const v of Object.values(facts)) expect(text, v).toContain(v)
  })

  it('states that the offered tools are complete, without enumerating them', () => {
    const text = renderTools(['read', 'shell'])
    expect(text).toContain('complete set offered this turn')
    expect(text).not.toContain('- read')
    expect(text).not.toContain('{{')
  })

  it('says there are none rather than saying the (empty) list is complete', () => {
    const text = renderTools([])
    expect(text).toContain('You have no tools on this request')
    expect(text).not.toContain('complete set offered this turn')
    expect(text).not.toContain('{{')
  })

  it('substitutes every occurrence, leaves an unknown placeholder alone, and never throws', () => {
    expect(applyVars('{{a}} and {{a}}', { a: 'x' })).toBe('x and x')
    expect(applyVars('{{a}} {{b}}', { a: 'x' })).toBe('x {{b}}')
    expect(applyVars('no placeholders', {})).toBe('no placeholders')
  })

  it('drops a frontmatter block and trailing whitespace, and leaves a body without one intact', () => {
    expect(stripFrontmatter('---\ntitle: x\n---\nbody\n')).toBe('body\n')
    expect(stripFrontmatter('body\n')).toBe('body\n')
    // Unterminated frontmatter is not a frontmatter block; dropping to end of file would silently
    // delete the whole prompt.
    expect(stripFrontmatter('---\ntitle: x\nbody\n')).toBe('---\ntitle: x\nbody\n')
    // A horizontal rule inside the body is not a frontmatter fence.
    expect(stripFrontmatter('body\n---\nmore\n')).toBe('body\n---\nmore\n')
    for (const s of PROMPT_SECTIONS)
      if (s.source === 'file') expect(loadPrompt(s.id), s.id).toBe(loadPrompt(s.id).trimEnd())
  })
})
