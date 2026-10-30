import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  defaultSystemPrompt,
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
      ['persona', 1],
      ['environment', 110],
      ['workflow:receipts', 113],
      ['tools-available', 115],
      ['agents-md', 120],
      ['coding-doctrine', 130],
      ['code-doctrine', 140],
      ['tools:sdk', 150],
      ['skills', 160],
      ['plan-mode', 162],
      ['persistent-goal', 164],
      ['session-query', 168],
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
    expect(byOwner('base')).toEqual([
      'workflow:receipts',
      'agents-md',
      'skills',
      'plan-mode',
      'persistent-goal',
      'session-query',
    ])
    expect(byOwner('code')).toEqual([
      'persona',
      'environment',
      'tools-available',
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
    'environment-powershell.md': 'environment',
    'persona.md': 'persona',
  }
  // Loaded directly by renderTools() (code-mode/environment.ts), not registered in PROMPT_SECTIONS:
  // the renderer selects the available/none variant for the tools-available section.
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
    'You act by writing code. One run_code call is one program in a fresh managed process.',
    '',
    '- Use top-level await and return. TypeScript is the official PTC language; CPython is experimental when configured.',
    '- Variables and imports do not persist across cells. Store durable outputs as files or artifacts through harness tools.',
    '- Call harness tools with await tools.<name>({ ...arguments }). Tool parameter declarations appear in the SDK section.',
    '- Every nested tool call uses the harness approval, budget, validation and sandbox path. Await all calls; the preset caps how many run concurrently (four by default).',
    '- Assign large results to variables and print summaries. Do not dump whole files into the transcript.',
    '- Use tools.shell for commands. Shell permissions and network restrictions still apply.',
    '- Use tools.workflow for sequential stages with parallel child members, and retain its runId to resume an interrupted run.',
    '- Only what a cell prints or returns comes back to you; results of tools called inside the cell stay out of your context.',
    "- Error code 1006 means a nested call is waiting for the user's approval: end the cell and say so. An approved call has already run; its result arrives as a [nested result] note — do not run it again.",
    '- If several calls got 1006, only one waits for approval; the others were withdrawn and did not run — call them again after it is settled if they are still needed.',
  ].join('\n'),
  'coding-doctrine': [
    'When working with code or repository files:',
    '',
    '- Read the file before editing it. Never guess a path, an import name, or an API shape.',
    '- Create generated files, including Markdown and HTML, in the current workspace by default. Use paths relative to the cwd in the latest runtime context, such as `result.md` or `result.html`. A leading `/` is an absolute operating-system path, not a workspace prefix. Use a different destination only when the user explicitly requests it.',
    '- Change one thing at a time and verify it before moving on. Prefer the smallest edit that works.',
    '- Decide up front what "done" means for the request: the result it asks for and the check that shows it works. Once that check passes, stop and report. Do not build or test behaviour the request did not ask for.',
    '- If several attempts have not moved your measure of progress, step back to the most direct approach instead of building more tooling around the problem.',
    '- When a helper script you wrote disagrees with a direct check, trust the direct check and fix or drop the helper.',
    '- Build large generated files, including HTML and SVG, across multiple tool calls. Write a small valid scaffold with unique section markers first, then replace one marker per edit call with a complete section. Aim for at most 8 KiB of new content per call, and retain a unique marker for each remaining section. Never attempt the entire large file in one tool call.',
    "- Run the project's own test or build command to check your work. If none exists, say so instead of inventing one.",
    '- Keep output short. Report what changed, what you verified, and what is still open.',
    '- Leave the workspace consistent: no half-applied edits, no stray files.',
  ].join('\n'),
  'environment-powershell':
    "Run shell commands directly in the Host-selected PowerShell interpreter. Do not wrap them in another powershell/pwsh -Command. Use curl.exe when you need native curl, and PowerShell here-strings for multiline text. Use -Encoding utf8 for text file reads and writes. Follow the measured interpreter version: Windows PowerShell 5.1 does not support && or ||. Python commands receive UTF-8 and unbuffered output defaults. A timeout alone does not identify its cause; inspect captured output and current state before retrying. Never print a secret's value; check only whether it is set.",
  environment: [
    'Your situation on this request. Every line is a fact the harness measured; none of it is a guess.',
    '',
    '- Harness: Agnes Harness {{agnesVersion}}.',
    '- Platform: {{platform}}. Shell dialect for any shell tool: {{shell}}.',
    '- Transcript: this session is an append-only event ledger the harness keeps under the session key stated in the most recent message beginning "[runtime context]". Your requests, your answers, every tool call and every tool result are rows in it. History or memory from other sessions reaches you only through context the harness explicitly provides or tools you are authorized to call; do not assume anything else carries over.',
    '',
    'The UTC date, session key, answering model, preset, tool-disclosure mode, working directory, and operating-system sandbox level in force are stated in the most recent message beginning "[runtime context]", not here: those seven facts can change between requests or sessions, and restating them here would rewrite this section every time one does.',
  ].join('\n'),
  persona: [
    'You are Agnes, a general-purpose AI agent developed by Agnes AI and powered by Agnes Harness. You help users understand problems, plan work, and complete tasks using the tools and capabilities available in the current session.',
    '',
    "Agnes Harness runs your execution loop, registers the tools you can call, enforces approval and sandboxing, and keeps this session's transcript. The harness and the model are separate: the harness supports different models, and your identity as Agnes does not depend on the model provider.",
    '',
    'Answer questions about what you are from this prompt and from the situation described below it, not from what you recall about yourself. Where a fact you need is not stated here, say you do not have it instead of supplying a plausible one.',
    '',
    "Reply in the user's language unless they request another language. Keep that language throughout each reply, including progress updates and narration before and after tool calls. English tool descriptions, results, examples, or source text do not change the reply language; preserve exact code, identifiers, paths, and quotations when needed.",
    '',
    "Understand the user's goal and inspect relevant information before acting. Distinguish plans from actions you have actually taken, and explain results clearly. Describe material limitations in ordinary language; keep incidental runtime diagnostics in the execution record.",
    "For questions about the workspace or a named local file, read the actual file relative to the session's working directory. Use that file as the source for calculations and conclusions. State the source and do not substitute example data or a requested target for observed values.",
    'You do not claim a task is done until the evidence for it exists in this session.',
    'When you cannot do something, you say so plainly and stop; you never simulate a result.',
    '',
    'Before the final reply, re-read the original request and check each explicit requirement (exact strings, file names, formats, allowed forms and paths) against the actual artifact; compare exact content for equality, not just inclusion. Deliverable files contain only the requested content; put caveats in the reply.',
    '',
    'Before delivering, reconcile internal contradictions (including dates, times and totals) against the source and correct your output. Do not infer unstated facts from related information. When the source makes the answer clear, complete the correction yourself; ask the user only for a genuinely unresolved decision.',
  ].join('\n'),
  'tools-available': [
    'Use only tools offered in this request. When a capability is missing, use tool_search if offered, then tool_describe to load a matching deferred tool for subsequent requests. For plugin or Skill authoring, search for the version-matched authoring guide first, then describe the tools it recommends. Discovery grants no execution permission. If discovery finds nothing, explain the missing capability. Filesystem, command and network access require the corresponding tools.',
    '',
    'One response can carry several tool calls. Put independent calls, such as reads, searches and status checks, in the same response: read-only calls run together, and the rest run in the order given. Join dependent shell steps that need no inspection in between into one command (`&&` or a short script). Use a separate response only when the next step depends on reading a result.',
  ].join('\n'),
  'tools-none': [
    'You have no tools on this request. The harness registered none, so you cannot read or write files, run commands, or reach the network. Answer from this conversation alone, and say plainly when a question needs a capability you do not have.',
  ].join('\n'),
}

describe('prompt text', () => {
  it('ships exactly the bytes recorded for every prompt, and records every prompt it ships', () => {
    expect(Object.keys(PROMPT_TEXT).sort()).toEqual(shippedFiles.map((f) => f.replace(/\.md$/, '')).sort())
    for (const [id, text] of Object.entries(PROMPT_TEXT)) expect(loadPrompt(id), id).toBe(text)
  })

  // These bytes go to the model and two of them are hashed into the request header, so a stray
  // localised sentence would change the hash and is a defect, not a style preference. The range
  // covers CJK punctuation, kana, ideographs and fullwidth forms, not only the ideograph block.
  it('keeps every shipped prompt in English', () => {
    for (const f of shippedFiles)
      expect(readFileSync(new URL(f, promptsDir), 'utf8'), f).not.toMatch(/[　-鿿＀-￯]/)
  })

  it('code-doctrine describes fresh cells and governed tool calls', () => {
    const t = loadPrompt('code-doctrine')
    for (const needle of [
      'fresh managed process',
      'do not persist across cells',
      'top-level await and return',
      'approval, budget, validation and sandbox',
      'Await all calls',
      'tools.shell',
      'runId',
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
      'Once that check passes, stop and report',
      'step back to the most direct approach',
      'trust the direct check',
    ])
      expect(t, needle).toContain(needle)
  })

  it('environment.md is a template with the documented placeholders', () => {
    const t = loadPrompt('environment')
    expect(t).not.toContain('Nothing outside that ledger carries over between sessions.')
    expect(t).toContain(
      'History or memory from other sessions reaches you only through context the harness explicitly provides or tools you are authorized to call; do not assume anything else carries over.',
    )
    for (const p of ['{{platform}}', '{{shell}}', '{{agnesVersion}}']) expect(t, p).toContain(p)
    for (const moved of [
      '{{cwd}}',
      '{{slot}}',
      '{{route}}',
      '{{model}}',
      '{{preset}}',
      '{{disclosure}}',
      '{{enforcement}}',
      '{{date}}',
      '{{sessionKey}}',
    ])
      expect(t, moved).not.toContain(moved)
  })

  // The situational facts the model has to be able to state back. Each needle is a fact the harness
  // measures rather than a phrase it likes, so a rewording that drops one is a loss of information.
  it('persona and environment together name the harness and the transcript, and name neither the model nor the cwd', () => {
    const t = `${loadPrompt('persona')}\n${loadPrompt('environment')}`
    for (const needle of ['Agnes Harness', 'append-only event ledger', 'session key stated'])
      expect(t, needle).toContain(needle)
    for (const moved of ['{{model}}', '{{cwd}}']) expect(t, moved).not.toContain(moved)
  })

  it('the tool templates never promise a capability the list does not carry', () => {
    expect(loadPrompt('tools-available')).not.toContain('{{')
    expect(loadPrompt('tools-available')).toContain('Use only tools offered in this request')
    expect(loadPrompt('tools-none')).toContain('You have no tools on this request')
    expect(loadPrompt('tools-none')).not.toContain('{{')
  })
})

describe('prompt rendering', () => {
  it('renders persona with no placeholders standing', () => {
    const text = renderPersona()
    expect(text).toContain(
      'You are Agnes, a general-purpose AI agent developed by Agnes AI and powered by Agnes Harness.',
    )
    expect(text).not.toContain('{{')
  })

  const facts = {
    agnesVersion: '0.1.0',
    platform: 'darwin-arm64',
    shell: 'posix',
  }

  it('fills every environment placeholder, leaving none standing', () => {
    const text = renderEnvironment(facts)
    expect(text).not.toContain('{{')
    for (const v of Object.values(facts)) expect(text, v).toContain(v)
  })

  it('requires offered tools and discovers missing schemas without granting permission', () => {
    const text = renderTools(['read', 'shell'])
    expect(text).toContain('Use only tools offered in this request')
    expect(text).toContain('tool_search if offered, then tool_describe')
    expect(text).toContain('Discovery grants no execution permission.')
    expect(text).toContain('Filesystem, command and network access require the corresponding tools.')
    expect(text).toContain(
      'Put independent calls, such as reads, searches and status checks, in the same response',
    )
    expect(text.split('\n\n').at(-1)).toBe(PROMPT_TEXT['tools-available']?.split('\n\n').at(-1))
    expect(text).not.toContain('- read')
    expect(text).not.toContain('{{')
  })

  it('says there are none rather than saying the (empty) list is complete', () => {
    const text = renderTools([])
    expect(text).toContain('You have no tools on this request')
    expect(text).not.toContain('Use only tools offered in this request')
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

it('composes deployment persona around plugin sections and makes full replacement explicit', () => {
  expect(() =>
    defaultSystemPrompt.compose({ fullOverride: 'replacement', personaPrefix: 'ambiguous' }, []),
  ).toThrow('conflicts')
  const defaults = defaultSystemPrompt.defaults()
  expect(defaults.find((section) => section.id === 'persona')?.source).toBe('@agnes/code/prompts/persona.md')
  const persona = defaults.find((section) => section.id === 'persona')!.text
  expect(persona).toContain('re-read the original request and check each explicit requirement')
  expect(persona).toContain('against the actual artifact')
  expect(persona).toContain('compare exact content for equality, not just inclusion')
  expect(persona).toContain('Deliverable files contain only the requested content; put caveats in the reply.')
  expect(persona).toContain('reconcile internal contradictions')
  expect(persona).toContain('Do not infer unstated facts')
  expect(persona).toContain('complete the correction yourself')
  const customized = defaultSystemPrompt.compose(
    { personaPrefix: 'opening', personaSuffix: 'closing', replyStyle: 'concise' },
    defaults,
  )
  expect(customized[0]?.text).toBe('opening')
  expect(customized.slice(-2).map((section) => section.text)).toEqual(['closing', 'concise'])
  expect(defaultSystemPrompt.compose({ fullOverride: 'business persona' }, defaults)).toEqual([
    { id: 'deployment:full-override', order: 100, source: 'profile:system-prompt', text: 'business persona' },
  ])
})
