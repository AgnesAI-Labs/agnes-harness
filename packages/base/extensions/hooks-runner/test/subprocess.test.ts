import type { ToolContext } from '@agnes/extension-api'
import { describe, expect, it } from 'vitest'
import type { HostExec } from '../../../src/seam-init.js'
import { runSubprocess } from '../src/subprocess.js'

describe('runSubprocess', () => {
  it('uses the sandbox shell sentinel, stdin, env, cwd, timeout and signal', async () => {
    const seen: Parameters<HostExec>[] = []
    const exec: HostExec = async (...args) => {
      seen.push(args)
      return {
        code: 0,
        stdout: '{"hookSpecificOutput":{"additionalContext":"hi"}}',
        stderr: '',
        truncated: false,
        timedOut: false,
      }
    }
    const controller = new AbortController()

    const result = await runSubprocess(
      exec,
      {
        command: './h.sh',
        timeoutMs: 1_000,
        cwd: '/w',
        env: { AGNES_SESSION_ID: 's1', AGNES_STEP_ID: '1/1' },
        signal: controller.signal,
      },
      { hook_event_name: 'PreToolUse' },
    )

    expect(seen).toEqual([
      [
        ['$SHELL', './h.sh'],
        {
          cwd: '/w',
          env: { AGNES_SESSION_ID: 's1', AGNES_STEP_ID: '1/1' },
          stdin: '{"hook_event_name":"PreToolUse"}',
          timeoutMs: 1_000,
          signal: controller.signal,
          maxOutputBytes: 65_536,
        },
      ],
    ])
    expect(result).toEqual({
      exitCode: 0,
      stdout: '{"hookSpecificOutput":{"additionalContext":"hi"}}',
      stderr: '',
      output: { hookSpecificOutput: { additionalContext: 'hi' } },
    })
  })

  it('leaves output undefined for non-JSON stdout and accepts exit 2', async () => {
    const exec: ToolContext['exec'] = async () => ({
      code: 2,
      stdout: 'plain',
      stderr: 'blocked',
      truncated: false,
    })
    const result = await runSubprocess(exec, { command: 'x', timeoutMs: 1, cwd: '/w', env: {} }, {})
    expect(result).toEqual({ exitCode: 2, stdout: 'plain', stderr: 'blocked' })
  })

  it.each([
    {
      name: 'non-contract exit code',
      result: { code: 1, stdout: '', stderr: 'SECRET_FROM_HOOK', truncated: false, timedOut: false },
      error: 'hook subprocess failed with exit 1',
    },
    {
      name: 'timeout',
      result: { code: 1, stdout: '', stderr: 'SECRET_FROM_HOOK', truncated: false, timedOut: true },
      error: 'hook subprocess timed out',
    },
    {
      name: 'truncation',
      result: { code: 0, stdout: '{}', stderr: 'SECRET_FROM_HOOK', truncated: true, timedOut: false },
      error: 'hook subprocess output was truncated',
    },
  ])('rejects $name without leaking hook output', async ({ result, error }) => {
    const promise = runSubprocess(async () => result, { command: 'x', timeoutMs: 1, cwd: '/w', env: {} }, {})
    await expect(promise).rejects.toThrow(error)
    await expect(promise).rejects.not.toThrow('SECRET_FROM_HOOK')
  })

  it('rejects syntactically valid JSON that is not an object', async () => {
    await expect(
      runSubprocess(
        async () => ({
          code: 0,
          stdout: '["not", "an", "object"]',
          stderr: '',
          truncated: false,
          timedOut: false,
        }),
        { command: 'x', timeoutMs: 1, cwd: '/w', env: {} },
        {},
      ),
    ).rejects.toThrow('hook subprocess JSON output must be an object')
  })

  it('rejects invalid specs before invoking the adapter', async () => {
    let calls = 0
    const exec: HostExec = async () => {
      calls += 1
      return { code: 0, stdout: '', stderr: '', truncated: false, timedOut: false }
    }
    await expect(
      runSubprocess(exec, { command: 'bad\u0000command', timeoutMs: 1, cwd: '/w', env: {} }, {}),
    ).rejects.toThrow('invalid hook command')
    await expect(
      runSubprocess(exec, { command: 'ok', timeoutMs: Number.NaN, cwd: '/w', env: {} }, {}),
    ).rejects.toThrow('invalid hook timeout')
    expect(calls).toBe(0)
  })
})
