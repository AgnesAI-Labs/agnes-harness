import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseSkillDocument } from '../../skills/src/frontmatter.js'
import { COMPUTER_USE_ACTIONS } from '../src/schema.js'

const path = fileURLToPath(new URL('../skill/SKILL.md', import.meta.url))
const source = await readFile(path, 'utf8')
const parsed = parseSkillDocument(source)
const REVIEWED_SKILL_SHA256 = '130c694ee669693d16943a21bcc3bc95f2ed7e0d16107dff17eb4a98518e81c7'

describe('platform-gated Agnes Computer Use Skill', () => {
  it('is a valid bounded Skill document attributed to the fixed Hermes source', () => {
    expect(parsed?.frontmatter).toMatchObject({
      name: 'agnes-computer-use',
      description: expect.stringContaining('single reviewed computer_use wrapper'),
    })
    expect(source).toContain('fb56a7e06dde62e9f645ff744c82cb47b60c469e')
    expect(source).toContain('Francesco Bonacci (f-trycua)')
    expect(source).toContain('license: MIT')
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThanOrEqual(192 * 1024)
    expect(source).toContain('status: platform-gated')
    expect(source).toContain('wrapper: computer_use')
    expect(source).toContain('hermes_commit: fb56a7e06dde62e9f645ff744c82cb47b60c469e')
    expect(createHash('sha256').update(source).digest('hex')).toBe(REVIEWED_SKILL_SHA256)
  })

  it('documents every and only the 15 wrapper actions in its action contract', () => {
    const actionBlock = /## The 15 wrapper actions[\s\S]*?```text\n([\s\S]*?)```/.exec(source)?.[1]
    expect(actionBlock).toBeDefined()
    const documented = (actionBlock ?? '')
      .split('\n')
      .map((line) => /^([a-z_]+)(?:\s|$)/.exec(line)?.[1])
      .filter((action): action is string => action !== undefined)
    expect(documented).toEqual(COMPUTER_USE_ACTIONS)
    expect(new Set(documented).size).toBe(15)
  })

  it('keeps the capture-element-verify workflow and every verdict branch fail closed', () => {
    expect(source).toContain('Canonical workflow: capture → element → verify')
    for (const branch of [
      'effect="confirmed"',
      'effect="unverifiable"',
      'effect="suspected_noop"',
      'code="stale"',
      'code="background_unavailable"',
      'code="foreground_unsupported"',
    ])
      expect(source).toContain(branch)
    expect(source).toContain('repeating it can double-submit')
    expect(source).toContain('Treat mutation outcome as unknown; do not replay')
    expect(source).toContain('requires its own approval scope')
    expect(source).toContain('never reuse a pair from an older tool result or conversation turn')
  })

  it('states the hard blocks and cannot represent driver admission or raw-tool authorization', () => {
    for (const boundary of [
      'cannot install, admit, start, or grant permissions to a driver',
      'never bypasses Agnes approval',
      'permission dialogs',
      'payment/financial UI',
      '2FA/MFA challenges',
      'Never type passwords, API keys, tokens',
      'Unrestricted/session-yolo mode does not disable',
      'cannot authorize an action',
    ])
      expect(source).toContain(boundary)

    expect(source).toContain('Never call or expose cua-driver raw MCP tools')
    expect(source).toContain('Do not invent raw `snapshot_id`, `element_token`, `get_window_state`')
    expect(source).not.toMatch(
      /(?:^|\n)\s*(?:cua-driver|hermes)\s+(?:skills|computer-use)\s+(?:install|start)/,
    )
  })
})
