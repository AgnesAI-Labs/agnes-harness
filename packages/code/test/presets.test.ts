import { describe, expect, it } from 'vitest'
import { loadAllPresets, loadPreset, PRESET_NAMES, PROMPT_SECTIONS, presets } from '../src/index.js'
import { parsePreset } from '../src/presets/load.js'

// The preset document schema (`preset.json`) and the `validatePreset` helper that would check a
// recipe against it are not part of @agnes/protocol yet, so this file checks the shape it needs
// directly. The name of each check says what it actually checks: none of them is a schema, and
// calling one a schema check would be the claim rather than the test.

// Every key a recipe may declare at the top level. It is the typo check the schema will subsume: a
// misspelled key is not a parse error and not a merge error - it is a knob that silently does
// nothing, and the recipe reads as though it is set.
const KNOWN_PRESET_KEYS = [
  'name',
  'extends',
  'surfaces',
  'model',
  'disclosure',
  'tools',
  'mcp',
  'skills_roots',
  'compaction',
  'checkpoint',
  'budget',
  'approval',
  'sandbox',
  'loop',
  'repair',
  'verifier',
  'completion_gate',
  'subagent',
  'harness',
  'telemetry',
  'recovery',
  'deferred',
  'ext',
  'ext_ui',
  'hooks',
  'locale',
  'code_runtime',
]

// The keys `standard` declares, exactly. A variant recipe declares a subset of the same vocabulary
// and inherits the rest, so only the root product recipe can be pinned this way.
const STANDARD_KEYS = [
  'name',
  'extends',
  'surfaces',
  'model',
  'disclosure',
  'tools',
  'mcp',
  'budget',
  'approval',
  'sandbox',
  'subagent',
  'ext_ui',
  'hooks',
]

/**
 * The shape check every shipped recipe is held to, in one place so two describes cannot drift into
 * two versions of it. It says what it verifies and nothing more: the document is a mapping filed
 * under its own name, it declares no key outside the vocabulary, and where it names a parent that
 * parent is a recipe this package registers. Whether the inheritance then produces the right
 * merged document is Task 7's matrix, against the real resolver.
 */
function expectPresetShape(name: string): Record<string, unknown> {
  const doc = loadPreset(name)
  expect(doc.name, name).toBe(name)
  for (const key of Object.keys(doc)) expect(KNOWN_PRESET_KEYS, `${name}: ${key}`).toContain(key)
  if (doc.extends !== undefined) expect([...PRESET_NAMES, 'base'], `${name} extends`).toContain(doc.extends)
  return doc
}

describe('standard.yaml', () => {
  const doc = loadPreset('standard')
  const policy = (doc.approval as { command_policy: Array<{ tool: string; argv: string; action: string }> })
    .command_policy

  // The rule ships as a string and whoever compiles it chooses the flags, so the flags are part of
  // the rule and are pinned here rather than left to whatever the call site happens to pass. No
  // flags at all is what every verdict below is stated under, and what the host must compile with.
  // The pin is load-bearing, not pedantic: under `m` two of the rows below change answer (the test
  // that follows the table pins exactly which two), and under `v` the pattern does not compile.
  const ARGV_FLAGS = ''

  // `allow` = runs with no human in the loop. `ask` = the operator is prompted. `ask` is never a
  // denial, so a case whose intent is arguable is listed as `ask`: the cost of asking about an odd
  // filename is one prompt, the cost of not asking about an escaping one is a write outside the
  // workspace that nobody saw.
  //
  // Every input below is an ABSOLUTE path, because that is the only spelling the evaluator is ever
  // handed: the producing end resolves the model's path against the workspace, checks containment,
  // and refuses anything outside it as non-canonical - which reaches the operator as a question, not
  // as a rule miss. The previous version of this table was written in relative spellings, which the
  // evaluator never sees and the session validator refuses outright; it passed anyway, because
  // nothing in it ever ran the rule against the thing the rule is matched against.
  //
  // `/w/repo` stands in for a workspace root. It carries no meaning in the rule - see the row for
  // `/etc/passwd`, which this pattern allows and which no producer will ever hand it.
  const ARGV_CASES: Array<[string, 'allow' | 'ask', string]> = [
    // --- ordinary workspace paths ---
    ['/w/repo/src/a.ts', 'allow', 'plain path'],
    ['/w/repo/a.txt', 'allow', 'single component under the root'],
    ['/w/repo/deep/nested/dir/file.md', 'allow', 'many components'],
    ['/w/repo/.hidden/x', 'allow', 'dotfile directory'],
    ['/w/repo/pkg/@scope/x.ts', 'allow', 'npm scope in a path'],
    ['/w/repo/\u4e2d\u6587/\u6587\u4ef6.md', 'allow', 'non-ASCII names'],
    ['/w/repo/a b/c d.txt', 'allow', 'spaces are ordinary filename bytes'],
    ['/w/repo/a/./b', 'allow', 'an interior . goes nowhere'],
    // --- the honest row: containment is the producer's half of the pair, not this rule's ---
    [
      '/etc/passwd',
      'allow',
      'the pattern cannot know a workspace root; normalizeArgv refuses this before a rule sees it',
    ],
    // --- dots that are part of a name, not a parent reference ---
    ['/w/repo/weird..name/x.ts', 'allow', 'dots inside a component'],
    ['/w/repo/a..b', 'allow', 'dots inside a component'],
    ['/w/repo/...', 'allow', 'three dots is an ordinary filename'],
    ['/w/repo/..a/x', 'allow', 'component merely starts with dots'],
    ['/w/repo/a/b..', 'allow', 'component merely ends with dots'],
    ['/w/repo/\u4e2d..\u6587', 'allow', 'dots inside a non-ASCII component'],
    ['/w/repo/a~/x', 'allow', 'a tilde is an ordinary filename byte'],
    ['/w/repo/~backup.txt', 'allow', 'a file whose name starts with ~, inside the workspace'],
    // --- escapes that are only escapes after decoding, i.e. different files on disk ---
    ['/w/repo/%2e%2e/etc/passwd', 'allow', 'percent-encoded: a directory literally named %2e%2e'],
    ['/w/repo/..%2fetc', 'allow', 'one component whose name contains %2f'],
    ['/w/repo/..%5cx', 'allow', 'one component whose name contains %5c'],
    ['/w/repo/x/..%2f../y', 'allow', 'no component is exactly ..'],
    ['/w/repo/\uff0e\uff0e/etc', 'allow', 'U+FF0E look-alike is a different directory name'],
    ['/w/repo/\u2024\u2024/etc', 'allow', 'U+2024 look-alike is a different directory name'],
    // --- relative spellings: never what the evaluator is handed, and never pre-approved ---
    ['src/a.ts', 'ask', 'relative: no leading separator'],
    ['a.txt', 'ask', 'relative: single component'],
    ['./a', 'ask', 'relative: leading .'],
    ['..', 'ask', 'relative: the parent itself'],
    ['../outside.txt', 'ask', 'relative: one level out'],
    ['~', 'ask', 'the home directory itself'],
    ['~/.ssh/authorized_keys', 'ask', 'writing here grants shell access'],
    ['~name/x', 'ask', 'another user\u2019s home directory'],
    // --- the .. family, forward slashes ---
    ['/..', 'ask', 'the parent of the root'],
    ['/../x', 'ask', 'one level out of the root'],
    ['/w/repo/..', 'ask', 'trailing .. after a real prefix'],
    ['/w/repo/../../etc/passwd', 'ask', 'net escape through several levels'],
    ['/w/repo/./../x', 'ask', '. then ..'],
    ['/w/repo/a/./../../x', 'ask', '. interleaved with ..'],
    ['/w/repo/a/../..', 'ask', 'trailing .. pair'],
    ['/w/repo//../../etc', 'ask', 'empty component before ..'],
    ['/w/repo/.../../x', 'ask', '... followed by a real ..'],
    ['/w/repo/x/....//y', 'ask', 'empty component; cannot survive normalisation'],
    // --- the .. family, backslashes: a separator on Windows, a filename byte on POSIX ---
    ['/w/repo/src\\..\\..\\etc', 'ask', 'backslash-separated ..'],
    ['/w/repo/..\\x', 'ask', 'backslash-separated ..'],
    ['/w/repo/a\\..', 'ask', 'backslash-separated ..'],
    ['/w/repo/src/\\../x', 'ask', 'mixed separators'],
    // --- absolute and rooted, but not a path this rule may pre-approve ---
    ['//etc/passwd', 'ask', 'double-slash: an empty first component'],
    ['/', 'ask', 'the root itself has no component'],
    ['/w/repo/a/', 'ask', 'trailing separator, empty last component'],
    ['/w/repo//a', 'ask', 'empty interior component'],
    ['C:\\Windows\\x', 'ask', 'drive-rooted, backslash'],
    ['c:/windows/x', 'ask', 'drive-rooted, forward slash, lowercase'],
    ['C:x', 'ask', 'drive-relative: resolves against the drive cwd, not this workspace'],
    ['C:/x', 'ask', 'drive-rooted'],
    ['c:', 'ask', 'bare drive'],
    ['\\Windows\\System32\\x', 'ask', 'root-relative on the current drive'],
    ['\\\\server\\share\\x', 'ask', 'UNC path leaves the machine entirely'],
    ['\\\\?\\C:\\Windows\\x', 'ask', 'extended-length prefix bypasses path parsing'],
    // --- control bytes: legal in a POSIX filename, so they smuggle past a `.`-based scan ---
    ['/w/repo/x\n/../../etc/passwd', 'ask', 'newline hides the .. from a dot-based lookahead'],
    ['/w/repo/x\n../../etc/passwd', 'ask', 'newline, no separator after it'],
    ['/w/repo/a\r\n/../x', 'ask', 'CRLF'],
    ['/w/repo/a\n/etc/passwd', 'ask', 'newline then an absolute path'],
    ['/w/repo/x\u2028/../../etc', 'ask', 'LINE SEPARATOR'],
    ['/w/repo/a\u2029/x', 'ask', 'PARAGRAPH SEPARATOR'],
    ['/w/repo/a\u0085/../x', 'ask', 'NEL'],
    ['/w/repo/a\u0085b/x', 'ask', 'NEL with no .. at all: still a control byte'],
    ['/w/repo/a\u009f', 'ask', 'C1 control byte'],
    ['/w/repo/x\u000b/../y', 'ask', 'vertical tab'],
    ['/w/repo/x\ty', 'ask', 'tab'],
    ['/w/repo/\0../x', 'ask', 'NUL'],
    ['/w/repo/a\0/../x', 'ask', 'NUL'],
    ['/w/repo/src/../../etc/passwd\0.ts', 'ask', 'NUL truncation'],
    ['/w/repo/a/..%00/../x', 'ask', 'encoded NUL plus a real ..'],
    // --- malformed ---
    ['', 'ask', 'the empty string is not a path'],
  ]

  it('declares exactly the keys the root product recipe owns, and no key outside the vocabulary', () => {
    expect(Object.keys(doc).sort()).toEqual([...STANDARD_KEYS].sort())
    expectPresetShape('standard')
  })

  // Values, not shapes. A recipe is data: every one of these numbers and enums is a product default
  // somebody could widen in a one-character edit, and a test that only asserts `typeof budget ===
  // 'object'` would not notice. The two marked below decide how much a single turn may spend and
  // whether a subagent gets its own tree, so they are pinned for a safety reason, not a tidiness one.
  it('pins the default values, not merely the presence of the keys that hold them', () => {
    expect(doc.surfaces).toEqual(['cli', 'sdk', 'acp', 'daemon'])
    expect(doc.disclosure).toBe('standard')
    expect(doc.tools).toEqual({
      core: ['read', 'write', 'edit', 'shell', 'grep', 'find', 'ls', 'todo', 'web_fetch'],
    })
    expect(doc.mcp).toEqual({ defer: true })
    expect(doc.sandbox).toEqual({ level: 'L0', required: false, on_unavailable: 'allow' })
    // Spend ceiling for one request. Widening it costs money silently; nothing else asserts it.
    expect(doc.budget).toEqual({ per_request_cap: 4000, max_steps: 80 })
    // `isolation: worktree` is what keeps a subagent's writes off the operator's checkout. `none`
    // parses just as well and is a containment change, so the value is pinned, not just the key.
    expect(doc.subagent).toEqual({ max_depth: 1, max_fan_out: 4, isolation: 'worktree' })
    expect(doc.ext_ui).toEqual({ input: 'prompt', unattended: 'decline' })
    expect(doc.hooks).toEqual(['session_start', 'tool_call', 'tool_result', 'format_deviation'])
  })

  // The seam between this file and the prompt order table: a typo in `prompt_sections` names a
  // section nobody registered, and assembly would silently drop it. Neither task owns this check,
  // so it lives here, next to the list it validates.
  it('names only registered prompt sections, each supplied by a package that exists', () => {
    const registered = new Set(PROMPT_SECTIONS.map((s) => s.id))
    // Every recipe that names sections, not only this one: a typo names a section nobody registered
    // and assembly drops it silently, and each recipe writes its own list.
    for (const name of PRESET_NAMES) {
      const named = (loadPreset(name).model as { prompt_sections?: string[] } | undefined)?.prompt_sections
      if (named === undefined) continue
      for (const id of named) expect(registered.has(id), `${name}: unregistered section ${id}`).toBe(true)
      // ... and in the frozen order, so a recipe cannot reorder the assembled prompt by listing
      // sections out of sequence.
      const orders = named.map((id) => PROMPT_SECTIONS.findIndex((s) => s.id === id))
      expect(orders, name).toEqual([...orders].sort((a, b) => a - b))
    }
    expect((doc.model as { prompt_sections: string[] }).prompt_sections.length).toBeGreaterThan(0)
  })

  it('extends base and declares the product identity keys base must not have', () => {
    expect(doc.extends).toBe('base')
    expect(doc.disclosure).toBe('standard')
    expect((doc.model as { prompt_sections: string[] }).prompt_sections).toEqual([
      'persona',
      'environment',
      'coding-doctrine',
    ])
    expect((doc.model as { contract_id: string }).contract_id).toBe('agnes-model-contract@v1')
  })

  // Each slot is a route target object, not a bare string: the routing vocabulary belongs to the ai
  // layer and that is the shape it defines. Both fields carry the placeholder `default`, which the
  // host resolves against the deployment's own adapter list — a product recipe never names a
  // concrete provider or model.
  it('routes name ai routes, never concrete models', () => {
    const route = (doc.model as { route: Record<string, unknown> }).route
    expect(Object.keys(route).sort()).toEqual(['compaction', 'escalation', 'fast', 'primary', 'verifier'])
    for (const [slot, target] of Object.entries(route))
      expect(target, slot).toEqual({ route: 'default', model: 'default' })
  })

  it('carries the workspace edit/write allow rule and nothing wider', () => {
    expect(policy).toHaveLength(1)
    expect(policy[0]).toMatchObject({ tool: 'edit|write', action: 'allow' })
    // shell is never pre-approved, under any rule in the table.
    expect(policy.some((p) => p.tool.includes('shell'))).toBe(false)
    // The word is the evaluator's. `ask` parses for one more version and is reported when a session
    // opens; a recipe that ships may not be the thing being reported about.
    for (const rule of policy) expect(['allow', 'require_approval', 'deny'], rule.tool).toContain(rule.action)
  })

  // The rule the host would refuse to open a session on is the rule that pre-approves nothing: an
  // allow rule matched against an absolute path has to require one, and one written for a relative
  // path both fails that check and never matches. This asserts the property directly, so it holds
  // without the whole host having to be assembled to find out.
  it('is an allow rule that can only match an absolute path', () => {
    const argv = policy[0]?.argv as string
    expect(argv.startsWith('^/')).toBe(true)
    expect(new RegExp(argv).test('src/a.ts')).toBe(false)
  })

  // Every case is pinned, allow *and* ask, because a pre-approval rule is only as good as the
  // spellings it was tested against: the two previous versions of this rule each passed their own
  // examples and each auto-approved a write outside the workspace under a spelling nobody had
  // listed. `why` is not decoration — it is the reason a future edit may not quietly flip a row.
  it.each(ARGV_CASES)('argv %j is %s (%s)', (input, verdict, _why) => {
    expect(new RegExp(policy[0]?.argv as string, ARGV_FLAGS).test(input)).toBe(verdict === 'allow')
  })

  // `m` is the flag that matters, because it moves `$` to the first line break: a name carrying a
  // newline then ends the match early, and the lookahead loses its reach in step. Recompiling the
  // whole table under `m` changes exactly these two rows, and both are `ask` rows that stay inside
  // the workspace when resolved as a path, so nothing that escapes becomes auto-approved. The
  // exact list is the point of the test. It is also what stops `[\s\S]*` in the lookahead from
  // reading as belt-and-braces around `.*`: swap the two and this list grows to six, the four
  // extra rows being the escaping ones a `.` cannot see past because it stops at the newline.
  it('changes exactly two non-escaping rows when the same table is recompiled under m', () => {
    const rule = policy[0]?.argv as string
    const changed = ARGV_CASES.filter(
      ([input, verdict]) => new RegExp(rule, 'm').test(input) !== (verdict === 'allow'),
    ).map(([input]) => input)
    expect(changed).toEqual(['/w/repo/a\n/etc/passwd', '/w/repo/a\u2029/x'])
  })

  it('covers every family the rule claims to decide (a shrunken table would pass vacuously)', () => {
    // Exact, not a floor: a floor of 16 and 46 against an actual 22 and 51 would let eleven rows
    // be deleted without a single test going red.
    expect(ARGV_CASES.filter(([, v]) => v === 'allow')).toHaveLength(23)
    expect(ARGV_CASES.filter(([, v]) => v === 'ask')).toHaveLength(50)
    expect(new Set(ARGV_CASES.map(([i]) => i)).size).toBe(ARGV_CASES.length)
  })

  it('is reachable through the named export the host reads', () => {
    expect(PRESET_NAMES).toEqual(['standard', 'claw', 'channel', 'minimal-rl', 'standard-windows'])
    expect(presets.standard).toEqual(doc)
    expect(Object.keys(presets)).toEqual([...PRESET_NAMES])
  })

  it('ships a file for every registered name, each declaring its own name', () => {
    for (const name of PRESET_NAMES) expect(loadPreset(name).name, name).toBe(name)
    expect(Object.keys(loadAllPresets())).toEqual([...PRESET_NAMES])
  })

  it('refuses an unknown preset name', () => {
    expect(() => loadPreset('nope')).toThrow(/unknown preset/)
  })

  it('refuses a file whose declared name does not match the one asked for', () => {
    expect(() => parsePreset('name: hybrid\n', 'standard')).toThrow(/declares name=hybrid/)
    expect(() => parsePreset('extends: base\n', 'standard')).toThrow(/declares name=undefined/)
    expect(() => parsePreset('- a\n- b\n', 'standard')).toThrow(/is not a mapping/)
  })
})

// Two variant recipes. Everything asserted here is a field the file itself declares: what the
// omitted fields become after the merge is Task 7's matrix, against the real resolver, because the
// merge does not happen in this package and an inheritance claim made without running it is a claim
// about a document nobody produced.
describe('claw', () => {
  const doc = expectPresetShape('claw')

  it('parks instead of denying, and never fakes an approval', () => {
    expect(doc.approval).toEqual({ on_unavailable: 'park' })
    // No `timeout_ms: 0`. It reads as "never time out" and behaves as "time out at once", and a
    // timed-out approval is a rejection: the knob written to wait would have refused everything.
    // The host refuses that document now; this pins that the recipe does not carry it.
    expect((doc.approval as Record<string, unknown>).timeout_ms).toBeUndefined()
  })

  // What this asserts is what the file says. That the host really refuses to open a session on a
  // platform without L1 is asserted where a host exists to refuse it, in
  // packages/host/test/shipped-presets.test.ts.
  it('declares the L1 sandbox requirement', () => {
    expect(doc.sandbox).toEqual({ level: 'L1', required: true })
  })

  // What is asserted here is only that the file does not restate the rule. That the inherited rule
  // survives the merge is Task 7's, and it is a different claim: a missing key and a key that
  // merges correctly look identical from here.
  it('does not restate command_policy', () => {
    expect((doc.approval as Record<string, unknown>).command_policy).toBeUndefined()
  })

  it('raises the step ceiling and subagent depth for unattended runs', () => {
    expect(doc.budget).toEqual({ per_request_cap: 4000, max_steps: 200 })
    expect(doc.subagent).toEqual({ max_depth: 2, max_fan_out: 4 })
    expect(doc.surfaces).toEqual(['daemon', 'sdk'])
    // No cli and no acp: both are somebody sitting in front of the run, which is what this recipe
    // is defined by the absence of.
    expect(doc.surfaces).not.toContain('cli')
    expect(doc.surfaces).not.toContain('acp')
  })

  it('lets an unattended run refine its own next turn but not the deployment', () => {
    expect(doc.harness).toEqual({ auto_refine: { enabled: true, global_needs_human: true } })
  })
})

describe('channel', () => {
  const doc = expectPresetShape('channel')

  it('adds channel-style last and parks approvals into the group card', () => {
    expect((doc.model as { prompt_sections: string[] }).prompt_sections).toEqual([
      'persona',
      'environment',
      'coding-doctrine',
      'channel-style',
    ])
    expect(doc.approval).toEqual({ on_unavailable: 'park' })
    expect(doc.surfaces).toEqual(['daemon'])
    expect(doc.subagent).toEqual({ max_depth: 1, max_fan_out: 2 })
    expect(doc.ext_ui).toEqual({ input: 'prompt', unattended: 'decline' })
  })

  it('does not restate command_policy either', () => {
    expect((doc.approval as Record<string, unknown>).command_policy).toBeUndefined()
  })
})

// One check over the whole registry rather than per recipe, so a recipe added without a describe
// block of its own is still held to it.
describe('every registered recipe', () => {
  it('is a mapping filed under its own name, in the known vocabulary, extending a recipe that exists', () => {
    for (const name of PRESET_NAMES) expectPresetShape(name)
  })
  it('pre-approves no shell command, in any recipe', () => {
    for (const name of PRESET_NAMES) {
      const rules = ((loadPreset(name).approval ?? {}) as { command_policy?: Array<{ tool: string }> })
        .command_policy
      for (const rule of rules ?? []) expect(rule.tool, `${name}: ${rule.tool}`).not.toMatch(/shell/)
    }
  })
})
