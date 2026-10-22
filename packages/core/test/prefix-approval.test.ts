import { describe, expect, it } from 'vitest'
import { prefixCommand } from '../src/execution/turn/prefix-approval.js'

const base = {
  meta: { commandArg: 'command' },
  scope: 'tool:shell:execute',
  onceOnly: false,
  requiresApproval: 'destructive',
  taint: false,
  authorization: 'allow',
  posixShell: true,
  workspaceRoot: '/work/proj',
}
const call = (args: Record<string, unknown>) => ({ name: 'shell', args: { command: 'git status', ...args } })

describe('prefixCommand: only a plain one-shot POSIX shell call may use a prefix grant', () => {
  it('speaks for an ordinary call, with or without a cwd inside the workspace', () => {
    expect(prefixCommand({ ...base, call: call({}) })).toBe('git status')
    expect(prefixCommand({ ...base, call: call({ cwd: 'sub/dir' }) })).toBe('git status')
    expect(prefixCommand({ ...base, call: call({ cwd: '/work/proj/sub', shell: 'bash' }) })).toBe(
      'git status',
    )
  })

  it.each<[string, Record<string, unknown>]>([
    ['background', { background: true }],
    ['persistent', { persistent: true }],
    ['an existing shell session', { sessionId: 's1' }],
    ['pwsh', { shell: 'pwsh' }],
    ['a cwd that climbs out', { cwd: '../other' }],
    ['an absolute cwd elsewhere', { cwd: '/etc' }],
    ['a cwd that is not text', { cwd: 5 }],
  ])('does not for %s', (_name, args) => {
    expect(prefixCommand({ ...base, call: call(args) })).toBeUndefined()
  })

  it.each<[string, Partial<typeof base>]>([
    ['a non-POSIX (PowerShell/win32) execution shell', { posixShell: false }],
    ['a once-only gate', { onceOnly: true }],
    ['an always-approval tool', { requiresApproval: 'always' }],
    ['tainted context', { taint: true }],
    ['a rule that requires approval', { authorization: 'require_approval' }],
    ['another scope', { scope: 'tool:other:execute' }],
    ['a tool without a declared command argument', { meta: {} as never }],
  ])('does not for %s', (_name, over) => {
    expect(prefixCommand({ ...base, ...over, call: call({}) })).toBeUndefined()
  })

  it('does not for another tool', () => {
    expect(
      prefixCommand({ ...base, call: { name: 'pty_send', args: { command: 'git status' } } }),
    ).toBeUndefined()
  })
})
