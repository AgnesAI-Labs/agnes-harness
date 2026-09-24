import type { ToolDef } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import {
  hasAuthenticToolPolicyHash,
  hasCompleteToolPolicyEnvelope,
  resolveValidatedToolCallPolicy,
} from '../src/registry/tool-policy.js'
import { ToolRegistry } from '../src/registry/tools.js'

const meta = {
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  isOpenWorld: false,
  replay: 'never' as const,
  costHint: undefined,
  deferLoading: undefined,
  requiresApproval: 'destructive' as const,
}

function dynamic(classify: NonNullable<ToolDef['classify']>): ToolDef {
  return {
    name: 'computer_use',
    description: 'd',
    parameters: { type: 'object', properties: { action: { type: 'string' } } } as never,
    meta,
    policyVersion: 'computer-use-v1',
    classify,
    execute: async () => ({ content: [] }),
  }
}

const provenance = {
  source: 'agnes/computer-use',
  trust: 'builtin' as const,
  packageIdentity: '@agnes/base',
  packageVersion: '1.0.0',
  executionDomain: 'host-computer-use' as const,
}

describe('resolved tool-call policy envelope', () => {
  it('classifies once and binds a canonical hash, definition fingerprint, and Host domain', () => {
    const classify = vi.fn((args: { action?: string }) => ({
      isReadOnly: args.action === 'capture',
      isDestructive: args.action !== 'capture',
      replay: args.action === 'capture' ? ('safe' as const) : ('never' as const),
      requiresApproval: args.action === 'capture' ? ('never' as const) : ('destructive' as const),
      approvalScopes: args.action === 'capture' ? [] : ['cua:input:background'],
    }))
    const registry = new ToolRegistry()
    registry.add(dynamic(classify as NonNullable<ToolDef['classify']>), provenance)
    const tool = registry.resolve('computer_use')
    if (!tool) throw new Error('missing tool')

    const envelope = resolveValidatedToolCallPolicy(tool, { action: 'click' })
    expect(classify).toHaveBeenCalledTimes(1)
    expect(envelope).toEqual({
      resolvedPolicy: {
        isReadOnly: false,
        isDestructive: true,
        isConcurrencySafe: false,
        isOpenWorld: false,
        replay: 'never',
        requiresApproval: 'destructive',
        approvalScopes: ['cua:input:background'],
        policyVersion: 'computer-use-v1',
      },
      policyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      definitionFingerprint: tool.definitionFingerprint,
      executionDomain: 'host-computer-use',
    })
    expect(Object.isFrozen(envelope)).toBe(true)
    expect(Object.isFrozen(envelope.resolvedPolicy)).toBe(true)
    expect(Object.isFrozen(envelope.resolvedPolicy.approvalScopes)).toBe(true)
    expect(hasAuthenticToolPolicyHash(envelope)).toBe(true)
    expect(
      hasAuthenticToolPolicyHash({
        ...envelope,
        resolvedPolicy: { ...envelope.resolvedPolicy, replay: 'safe' },
      }),
    ).toBe(false)
  })

  it('gives legacy static tools an equivalent versioned policy without invoking author code', () => {
    const registry = new ToolRegistry()
    registry.add(
      {
        name: 'write',
        description: 'd',
        parameters: { type: 'object', properties: {} } as never,
        meta,
        execute: async () => ({ content: [] }),
      },
      { source: 'agnes/tools-core', trust: 'builtin' },
    )
    const tool = registry.resolve('write')
    if (!tool) throw new Error('missing tool')
    const envelope = resolveValidatedToolCallPolicy(tool, {})
    expect(envelope.resolvedPolicy).toEqual({
      isReadOnly: false,
      isDestructive: true,
      isConcurrencySafe: false,
      isOpenWorld: false,
      replay: 'never',
      requiresApproval: 'destructive',
      approvalScopes: [],
      policyVersion: 'static-v1',
    })
  })

  it.each(['isConcurrencySafe', 'isOpenWorld'] as const)(
    'treats a pre-migration policy missing %s as readable but incomplete',
    (field) => {
      const registry = new ToolRegistry()
      registry.add(
        {
          name: 'write',
          description: 'd',
          parameters: { type: 'object', properties: {} } as never,
          meta,
          execute: async () => ({ content: [] }),
        },
        { source: 'agnes/tools-core', trust: 'builtin' },
      )
      const tool = registry.resolve('write')
      if (!tool) throw new Error('missing tool')
      const current = resolveValidatedToolCallPolicy(tool, {})
      const legacyPolicy = { ...current.resolvedPolicy }
      delete legacyPolicy[field]
      expect(
        hasCompleteToolPolicyEnvelope({
          ...current,
          resolvedPolicy: legacyPolicy,
        }),
      ).toBe(false)
    },
  )

  it('fails closed when runtime classifier output is asynchronous or privileged', async () => {
    for (const classify of [
      (() => Promise.resolve({})) as unknown as NonNullable<ToolDef['classify']>,
      (() => ({
        isReadOnly: true,
        isDestructive: false,
        replay: 'safe',
        requiresApproval: 'never',
        approvalScopes: [],
        executionDomain: 'host-computer-use',
      })) as NonNullable<ToolDef['classify']>,
      ...(['isConcurrencySafe', 'isOpenWorld'] as const).map(
        (field) =>
          (() => ({
            isReadOnly: true,
            isDestructive: false,
            [field]: true,
            replay: 'safe',
            requiresApproval: 'never',
            approvalScopes: [],
          })) as NonNullable<ToolDef['classify']>,
      ),
    ]) {
      const registry = new ToolRegistry()
      registry.add(dynamic(classify), provenance)
      const tool = registry.resolve('computer_use')
      if (!tool) throw new Error('missing tool')
      expect(() => resolveValidatedToolCallPolicy(tool, {})).toThrow(/classify:/)
    }
  })

  it.each(['isConcurrencySafe', 'isOpenWorld'] as const)(
    'binds Core-derived %s into the definition fingerprint',
    (field) => {
      const classify = () => ({
        isReadOnly: true,
        isDestructive: false,
        replay: 'safe' as const,
        requiresApproval: 'never' as const,
        approvalScopes: [],
      })
      const original = new ToolRegistry()
      original.add(dynamic(classify), provenance)
      const changed = new ToolRegistry()
      const changedDefinition = dynamic(classify)
      changed.add(
        {
          ...changedDefinition,
          meta: { ...changedDefinition.meta, [field]: !changedDefinition.meta[field] },
        },
        provenance,
      )
      expect(original.resolve('computer_use')?.definitionFingerprint).not.toBe(
        changed.resolve('computer_use')?.definitionFingerprint,
      )
    },
  )

  it('snapshots registered metadata so caller mutation cannot drift policy away from its fingerprint', () => {
    const classify = () => ({
      isReadOnly: true,
      isDestructive: false,
      replay: 'safe' as const,
      requiresApproval: 'never' as const,
      approvalScopes: [],
    })
    const dynamicDefinition = dynamic(classify)
    const definition = {
      ...dynamicDefinition,
      meta: { ...dynamicDefinition.meta, costHint: { credits: 1 } },
    }
    const registry = new ToolRegistry()
    registry.add(definition, provenance)
    const registered = registry.resolve('computer_use')
    if (!registered) throw new Error('missing tool')
    const fingerprint = registered.definitionFingerprint
    definition.meta.isConcurrencySafe = true
    definition.meta.isOpenWorld = true
    definition.meta.costHint.credits = 999
    const afterMutation = registry.resolve('computer_use')
    if (!afterMutation) throw new Error('missing tool')
    const envelope = resolveValidatedToolCallPolicy(afterMutation, {})
    expect(afterMutation.definitionFingerprint).toBe(fingerprint)
    expect(envelope.definitionFingerprint).toBe(fingerprint)
    expect(envelope.resolvedPolicy).toMatchObject({ isConcurrencySafe: false, isOpenWorld: false })
    expect(afterMutation.meta.costHint).toEqual({ credits: 1 })
    expect(Object.isFrozen(afterMutation.meta)).toBe(true)
    expect(Object.isFrozen(afterMutation.meta.costHint)).toBe(true)
  })
})
