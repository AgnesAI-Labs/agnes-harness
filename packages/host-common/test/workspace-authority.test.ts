import { describe, expect, it } from 'vitest'
import {
  assertWorkspaceBinding,
  CliWorkspaceAuthority,
  inheritWorkspaceBinding,
  MAX_EXTRA_ROOTS,
  sameWorkspaceBindingAuthority,
  WorkspaceBindingAuthority,
} from '../src/workspace-authority.js'

const envelope = (over: Record<string, unknown> = {}) => ({
  version: 1 as const,
  sessionKey: 'session-a',
  workspaceId: 'a'.repeat(64),
  revision: 3,
  canonicalRoot: '/work/a',
  ...over,
})

describe('WorkspaceBinding authority', () => {
  it('turns only a valid authenticated frame for the expected session into a nominal binding', () => {
    const authority = new WorkspaceBindingAuthority()
    const binding = authority.accept(envelope(), 'session-a')
    expect(binding).toMatchObject({
      sessionKey: 'session-a',
      workspaceId: 'a'.repeat(64),
      authorityRevision: 3,
      canonicalRoot: '/work/a',
    })
    expect(() => assertWorkspaceBinding(binding)).not.toThrow()
    expect(Object.isFrozen(binding)).toBe(true)
  })

  it('rejects plain-object and cross-session forgeries', () => {
    const authority = new WorkspaceBindingAuthority()
    expect(() => assertWorkspaceBinding(envelope())).toThrow('E_WORKSPACE_UNTRUSTED')
    expect(() => authority.accept(envelope(), 'session-b')).toThrow('another session')
    expect(() => authority.accept(envelope({ revision: 0 }), 'session-a')).toThrow('revision')
    expect(() => authority.accept(envelope({ canonicalRoot: 'relative' }), 'session-a')).toThrow('canonical')
  })

  it('lets a child inherit the same authority without accepting a new cwd', () => {
    const parent = new WorkspaceBindingAuthority().accept(envelope(), 'session-a')
    const child = inheritWorkspaceBinding(parent, 'session-a/child')
    expect(child).toMatchObject({
      sessionKey: 'session-a/child',
      workspaceId: parent.workspaceId,
      authorityRevision: parent.authorityRevision,
      canonicalRoot: parent.canonicalRoot,
    })
    expect(() => inheritWorkspaceBinding(envelope() as never, 'child')).toThrow('Host authority')
  })

  it('restricts CLI authority to its one canonical startup root', () => {
    const cli = new CliWorkspaceAuthority('/work')
    const binding = cli.bind('session-a')
    expect(binding.canonicalRoot).toBe('/work')
    expect(binding.workspaceId).toMatch(/^[a-f0-9]{64}$/)
    expect(() => cli.bind('session-b', '/other')).toThrow('startup root')
  })

  it('carries extra roots through accept and inheritance, and compares them as authority', () => {
    const authority = new WorkspaceBindingAuthority()
    const plain = authority.accept(envelope(), 'session-a')
    expect(plain.extraRoots).toEqual([])
    const withExtra = authority.accept(envelope({ extraRoots: ['/shared/a', '/shared/b'] }), 'session-a')
    expect(withExtra.extraRoots).toEqual(['/shared/a', '/shared/b'])
    expect(Object.isFrozen(withExtra.extraRoots)).toBe(true)
    expect(inheritWorkspaceBinding(withExtra, 'session-a/child').extraRoots).toEqual(withExtra.extraRoots)
    expect(
      sameWorkspaceBindingAuthority(
        withExtra,
        authority.accept(envelope({ extraRoots: ['/shared/a', '/shared/b'] }), 'session-a'),
      ),
    ).toBe(true)
    expect(sameWorkspaceBindingAuthority(withExtra, plain)).toBe(false)
    expect(
      sameWorkspaceBindingAuthority(
        withExtra,
        authority.accept(envelope({ extraRoots: ['/shared/a'] }), 'session-a'),
      ),
    ).toBe(false)
  })

  it.each([
    ['a relative path', ['shared']],
    ['a duplicate', ['/shared/a', '/shared/a']],
    ['a non-canonical path', ['/shared/../a']],
    ['too many', Array.from({ length: MAX_EXTRA_ROOTS + 1 }, (_, i) => `/shared/${i}`)],
    ['a non-list', '/shared/a'],
  ])('refuses extra roots that are %s', (_name, extraRoots) => {
    expect(() => new WorkspaceBindingAuthority().accept(envelope({ extraRoots }), 'session-a')).toThrow(
      'E_WORKSPACE_UNTRUSTED',
    )
  })
})
