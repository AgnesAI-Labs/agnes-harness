import { loadPreset } from '@agnes/code'
import { COMMAND_ACTIONS, type CommandRule, checkCommandRule } from '@agnes/host-common/command-policy'
import { describe, expect, it } from 'vitest'

describe('checkCommandRule', () => {
  it('accepts both shipped Windows absolute-path rules at session open', () => {
    const approval = loadPreset('standard-windows').approval as { command_policy: CommandRule[] }
    expect(approval.command_policy).toHaveLength(2)
    for (const rule of approval.command_policy) expect(checkCommandRule(rule)).toBeUndefined()
  })
  const why = (rule: CommandRule): string => {
    try {
      checkCommandRule(rule)
    } catch (e) {
      return String((e as { detail: { reason: string } }).detail.reason)
    }
    throw new Error('expected a refusal')
  }
  it('refuses a rule whose regex does not compile', () => {
    expect(why({ tool: 'edit', argv: '[', action: 'allow' })).toMatch(/valid regular expression/)
    expect(why({ tool: '(', argv: '^/repo/', action: 'allow' })).toMatch(/valid regular expression/)
  })
  it('refuses a rule that is anchored nowhere', () => {
    expect(why({ tool: 'edit', argv: 'src/', action: 'allow' })).toMatch(/anchored/)
    expect(why({ tool: 'edit', argv: 'src/', action: 'deny' })).toMatch(/anchored/)
  })
  it('refuses an allow rule that can match a relative path', () => {
    expect(why({ tool: 'edit', argv: '^(?!\\.\\.)', action: 'allow' })).toMatch(/absolute/)
    expect(why({ tool: 'edit', argv: '^src/', action: 'allow' })).toMatch(/absolute/)
  })
  it('accepts the absolute spellings, and applies the absolute rule only to allow', () => {
    for (const argv of ['^/repo/', '^[/\\\\]repo', '^[\\\\/]repo', '^C:\\\\repo', '^[A-Za-z]:'])
      expect(checkCommandRule({ tool: 'edit', argv, action: 'allow' }), argv).toBeUndefined()
    // A deny rule that matches a relative path denies more, not less, so it is not refused here.
    expect(checkCommandRule({ tool: 'edit', argv: '^src/', action: 'deny' })).toBeUndefined()
  })
  it('refuses an allow rule whose leading class is not a separator', () => {
    // `^[` used to be read as absolute on its own. The second of these is an allow rule matching the
    // relative traversal the check exists to refuse.
    for (const argv of ['^[a-z]+/', '^[.]{2}/', '^[^/]+/', '^[.a-z]/'])
      expect(why({ tool: 'edit', argv, action: 'allow' })).toMatch(/absolute/)
  })
  it('refuses an allow rule where a quantifier makes the leading separator optional', () => {
    // `?`, `*` and a zero-minimum `{0,..}`/`{0}` all let the match start without the separator that
    // was checked, so `/repo/evil` (no leading slash) would still satisfy the rule.
    for (const argv of [
      '^/?tmp/evil$',
      '^/*tmp/evil$',
      '^/{0,3}tmp/evil$',
      '^/{0}tmp/evil$',
      '^[/]?tmp/evil$',
    ])
      expect(why({ tool: 'edit', argv, action: 'allow' }), argv).toMatch(/absolute/)
  })
  it('refuses an allow rule whose leading backslash starts an escape other than a separator', () => {
    // In a regex `\` escapes the next character; only `\/` and `\\` are separators. `^\w+/evil$`
    // and friends match the relative `tmp/evil`.
    for (const argv of ['^\\w+/evil$', '^\\S*$', '^\\/?tmp/evil$', '^\\\\?server'])
      expect(why({ tool: 'edit', argv, action: 'allow' }), argv).toMatch(/absolute/)
    for (const argv of ['^\\/repo/', '^\\\\server'])
      expect(checkCommandRule({ tool: 'edit', argv, action: 'allow' }), argv).toBeUndefined()
  })
  it('refuses an allow rule with a top-level alternation that bypasses the anchor', () => {
    // `^/` is only one branch of `^/|foo`; the pattern as a whole also matches the relative "foo"
    // anywhere in the string, so the leading `^/` guarantees nothing about what actually matched.
    expect(why({ tool: 'edit', argv: '^/|foo', action: 'allow' })).toMatch(/absolute/)
  })
  it('keeps accepting alternation nested inside a group', () => {
    // Unlike a top-level `|`, one inside `(...)` cannot let the match skip the leading `/`.
    expect(checkCommandRule({ tool: 'edit', argv: '^/(a|b)/', action: 'allow' })).toBeUndefined()
  })
  it('accepts the shipped workspace-write absolute-path rule at session open', () => {
    const approval = loadPreset('permission-workspace-write').approval as { command_policy: CommandRule[] }
    expect(approval.command_policy).toContainEqual(
      expect.objectContaining({ tool: 'edit|write', action: 'allow' }),
    )
    for (const rule of approval.command_policy) expect(checkCommandRule(rule)).toBeUndefined()
  })

  // The vocabulary is the evaluator's, and this file is the only thing that checks a table before it
  // is installed. An action the evaluator does not know decides nothing - base's matchPolicy
  // compares against its own three words, so a rule spelled otherwise never fires and the table
  // reads as a policy it is not.
  it('validates the evaluator words, and refuses an action outside them', () => {
    expect(COMMAND_ACTIONS).toEqual(['allow', 'require_approval', 'deny'])
    for (const action of COMMAND_ACTIONS)
      expect(() => checkCommandRule({ tool: 'edit', argv: '^/repo/', action }), action).not.toThrow()
    for (const action of ['ALLOW', 'approve', 'prompt', 'require-approval', ''])
      expect(why({ tool: 'edit', argv: '^/repo/', action: action as never })).toMatch(
        /not one of the actions allow, require_approval, deny/,
      )
  })

  it('refuses the retired ask spelling', () => {
    expect(why({ tool: 'shell', argv: '^curl ', action: 'ask' as never })).toMatch(
      /not one of the actions allow, require_approval, deny/,
    )
  })
})
