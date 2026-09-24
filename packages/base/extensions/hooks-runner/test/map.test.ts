import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fakeSeamInit } from '../../../testkit/seam-init.js'
import { readHooksConfig } from '../src/config.js'
import { type CcHookMap, mapEvent, translateReturn } from '../src/map.js'

const map = JSON.parse(
  readFileSync(new URL('../generated/cc-hook-map.json', import.meta.url), 'utf8'),
) as CcHookMap

describe('cc-hook-map', () => {
  it('contains all 27 Claude Code events and maps exactly 12', () => {
    expect(map.version).toBe('0.0.0')
    expect(Object.keys(map.events)).toHaveLength(27)
    expect(Object.values(map.events).filter((entry) => entry.to !== null)).toHaveLength(12)
    expect(mapEvent(map, 'PreToolUse')).toEqual({ to: ['tool_call'] })
    expect(mapEvent(map, 'UserPromptSubmit')).toEqual({ to: ['before_step', 'context'] })
    expect(mapEvent(map, 'Notification')).toMatchObject({ unsupported: expect.stringContaining('UI') })
    expect(mapEvent(map, 'Bogus')).toEqual({ unsupported: 'unknown Claude Code hook event Bogus' })
  })

  it('rejects malformed generated maps instead of trusting a cast', () => {
    expect(() =>
      mapEvent({ version: 'bad', events: { PreToolUse: { to: ['not-a-hook' as never] } } }, 'PreToolUse'),
    ).toThrow('invalid Claude Code hook map')
    expect(() =>
      mapEvent({ version: 'bad', events: { PreToolUse: { to: ['tool_call', 'tool_call'] } } }, 'PreToolUse'),
    ).toThrow('invalid Claude Code hook map')
  })
})

describe('readHooksConfig', () => {
  it('combines files in precedence order and skips missing, broken and invalid entries', async () => {
    const init = fakeSeamInit({
      files: {
        '.agh/user-hooks.json': JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'shell',
                hooks: [{ type: 'command', command: './lint.sh', timeout: 5 }],
              },
              { matcher: 42, hooks: [{ type: 'command', command: 'ignored' }] },
              { hooks: [{ type: 'command', command: '' }] },
            ],
            PostToolUse: [{ hooks: [{ type: 'http', url: 'https://hooks.example.test/a' }] }],
          },
        }),
        '.agh/broken-hooks.json': '{broken',
        '.agh/workspace-hooks.json': JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: './check.sh' }] }],
          },
        }),
      },
    })

    await expect(
      readHooksConfig(init.adapters.fs, [
        '.agh/user-hooks.json',
        '.agh/broken-hooks.json',
        '.agh/missing-hooks.json',
        '.agh/workspace-hooks.json',
      ]),
    ).resolves.toEqual([
      {
        event: 'PreToolUse',
        matcher: 'shell',
        hooks: [{ type: 'command', command: './lint.sh', timeout: 5 }],
      },
      {
        event: 'PostToolUse',
        hooks: [{ type: 'http', url: 'https://hooks.example.test/a' }],
      },
      { event: 'Stop', hooks: [{ type: 'command', command: './check.sh' }] },
    ])
  })

  it('returns fresh validated values and rejects unsafe scalar shapes', async () => {
    const init = fakeSeamInit({
      files: {
        'hooks.json': JSON.stringify({
          hooks: {
            PreToolUse: [
              { hooks: [{ type: 'command', command: 'ok', timeout: -1 }] },
              { hooks: [{ type: 'command', command: 'bad\u0000command' }] },
              { hooks: [{ type: 'http', url: 'file:///etc/passwd' }] },
            ],
          },
        }),
      },
    })

    await expect(readHooksConfig(init.adapters.fs, ['hooks.json'])).resolves.toEqual([])
  })
})

describe('translateReturn', () => {
  it('maps exit 2 and Claude decisions to Agnes directives', () => {
    expect(translateReturn('tool_call', { exitCode: 2, stderr: 'no rm', stdout: '' })).toEqual({
      allow: false,
      reason: 'no rm',
    })
    expect(
      translateReturn('tool_call', {
        exitCode: 0,
        stderr: '',
        stdout: '',
        output: {
          hookSpecificOutput: {
            permissionDecision: 'deny',
            permissionDecisionReason: 'policy',
          },
        },
      }),
    ).toEqual({ allow: false, reason: 'policy' })
    expect(
      translateReturn('tool_call', {
        exitCode: 0,
        stderr: '',
        stdout: '',
        output: { hookSpecificOutput: { permissionDecision: 'ask' } },
      }),
    ).toEqual({ allow: true })
    expect(
      translateReturn('before_step', {
        exitCode: 0,
        stderr: '',
        stdout: '',
        output: { decision: 'block', reason: 'nope' },
      }),
    ).toEqual({ block: true, reason: 'nope' })
    expect(translateReturn('turn_stopping', { exitCode: 2, stderr: 'not done', stdout: '' })).toEqual({
      action: 'continue',
      note: 'not done',
    })
  })

  it('maps additional context and preserves an existing tool result when supplied', () => {
    expect(
      translateReturn('context', {
        exitCode: 0,
        stderr: '',
        stdout: '',
        output: { hookSpecificOutput: { additionalContext: 'remember X' } },
      }),
    ).toEqual({ additionalContext: 'remember X' })

    expect(
      translateReturn(
        'tool_result',
        {
          exitCode: 0,
          stderr: '',
          stdout: '',
          output: { hookSpecificOutput: { additionalContext: 'remember X' } },
        },
        { content: [{ type: 'text', text: 'original' }], isError: false },
      ),
    ).toEqual({
      result: {
        content: [
          { type: 'text', text: 'original' },
          { type: 'text', text: 'remember X' },
        ],
        isError: false,
      },
    })

    expect(() =>
      translateReturn('tool_result', {
        exitCode: 0,
        stderr: '',
        stdout: '',
        output: { additionalContext: 'must not replace the original result' },
      }),
    ).toThrow('requires the current result')
  })

  it('throws on invalid process results and invalid or oversized hook output', () => {
    expect(() => translateReturn('tool_call', { exitCode: 1, stderr: 'bad', stdout: '' })).toThrow(
      'unexpected hook exit code',
    )
    expect(() =>
      translateReturn('context', {
        exitCode: 0,
        stderr: '',
        stdout: '',
        output: { hookSpecificOutput: { additionalContext: { secret: true } } },
      }),
    ).toThrow('additionalContext')
    expect(() =>
      translateReturn('context', {
        exitCode: 0,
        stderr: '',
        stdout: '',
        output: { additionalContext: 'x'.repeat(8_193) },
      }),
    ).toThrow('additionalContext')
    expect(() =>
      translateReturn('session_start', { exitCode: 2, stderr: 'cannot block', stdout: '' }),
    ).toThrow('cannot block observe hook')
  })
})
