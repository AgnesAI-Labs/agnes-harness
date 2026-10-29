import type { ChildAgentProvider } from './child-agent.js'
import type { CompactionEngine } from './compaction-engine.js'
import type { LoopFactory } from './loop.js'
import type { ModelAdapter } from './model-adapter.js'
import { definePersistenceProvider, type PersistenceProvider } from './persistence.js'
import { defineKind } from './provider-kind.js'
import type { ReferenceResolver } from './reference-resolver.js'
import {
  SANDBOX_PROVIDER_ID_PATTERN,
  type SandboxProvider,
  sandboxCapabilityNames,
  validSandboxCapabilities,
} from './sandbox-provider.js'
import type { ToolPolicy } from './tool-policy.js'
import type { ToolRuntimeProvider } from './tool-runtime.js'

/**
 * Host-installed kinds. Each token is the one identity both `ctx.providers.register` and the
 * Host registry use, so an author imports it instead of spelling a name.
 */

const CHILD_AGENT_FLAGS = [
  'continuable',
  'interrupt',
  'modelSelection',
  'inheritsParentContext',
  'worktree',
] as const

const text = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''

export const loopKind = defineKind<LoopFactory>({
  kind: 'loop',
  scope: 'session',
  versioned: true,
  validate(factory) {
    if (
      !Array.isArray(factory.capabilities) ||
      typeof factory.create !== 'function' ||
      typeof factory.resume !== 'function' ||
      !factory.codec
    )
      throw new Error('Invalid loop factory')
  },
  capabilities: (factory) => factory.capabilities,
})

export const modelAdapterKind = defineKind<ModelAdapter>({
  kind: 'model-adapter',
  scope: 'generation',
  validate(adapter) {
    if (
      !adapter.id ||
      typeof adapter.wireApi !== 'string' ||
      !adapter.wireApi.trim() ||
      !adapter.version ||
      typeof adapter.create !== 'function' ||
      !adapter.capabilities ||
      ['imageInput', 'tools', 'streaming'].some(
        (key) => typeof adapter.capabilities[key as keyof typeof adapter.capabilities] !== 'boolean',
      ) ||
      ['payload', 'payloadOnly'].some(
        (key) =>
          adapter.capabilities[key as keyof typeof adapter.capabilities] !== undefined &&
          typeof adapter.capabilities[key as keyof typeof adapter.capabilities] !== 'boolean',
      ) ||
      // An adapter that accepts only a payload necessarily accepts a payload.
      (adapter.capabilities.payloadOnly === true && adapter.capabilities.payload !== true)
    )
      throw new Error('invalid model adapter registration')
  },
  capabilities: (adapter) =>
    Object.entries(adapter.capabilities)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name),
})

export const compactionKind = defineKind<CompactionEngine>({
  kind: 'compaction',
  scope: 'generation',
  validate(engine) {
    if (!text(engine?.id) || !text(engine.version) || typeof engine.create !== 'function')
      throw new Error('invalid compaction engine registration')
  },
  capabilities: () => ['budget', 'summarize'],
})

export const persistenceKind = defineKind<PersistenceProvider>({
  kind: 'persistence',
  scope: 'process',
  validate(provider) {
    definePersistenceProvider(provider)
  },
  capabilities: (provider) => [
    'ledger',
    ...(provider.capabilities.metadata ? ['metadata'] : []),
    ...(provider.capabilities.childControl ? ['child-control'] : []),
    ...(provider.capabilities.reclaim ? ['reclaim'] : []),
    ...(provider.capabilities.integrity ? ['integrity'] : []),
    ...(provider.capabilities.sqlite ? ['sqlite'] : []),
  ],
})

export const sandboxKind = defineKind<SandboxProvider>({
  kind: 'sandbox',
  scope: 'process',
  validate(provider) {
    if (
      !SANDBOX_PROVIDER_ID_PATTERN.test(provider.id) ||
      !provider.version ||
      typeof provider.create !== 'function' ||
      !validSandboxCapabilities(provider.capabilities)
    )
      throw new TypeError('invalid sandbox provider registration')
  },
  capabilities: (provider) => sandboxCapabilityNames(provider.capabilities),
})

export const toolRuntimeKind = defineKind<ToolRuntimeProvider>({
  kind: 'tool-runtime',
  scope: 'session',
  validate(provider) {
    if (typeof provider.create !== 'function') throw new Error('Invalid tool runtime provider')
  },
  capabilities: () => ['single', 'batch', 'scheduling', 'cancel'],
})

export const toolPolicyKind = defineKind<ToolPolicy>({
  kind: 'tool-policy',
  scope: 'generation',
  validate(policy) {
    if (typeof policy.decide !== 'function') throw new Error('Invalid tool policy')
  },
  capabilities: () => ['allow', 'ask', 'deny'],
})

export const childAgentKind = defineKind<ChildAgentProvider>({
  kind: 'child-agent',
  scope: 'session',
  validate(provider) {
    if (
      !text(provider?.id) ||
      !text(provider.version) ||
      typeof provider.start !== 'function' ||
      !provider.capabilities ||
      CHILD_AGENT_FLAGS.some((flag) => typeof provider.capabilities[flag] !== 'boolean') ||
      (['budget', 'toolFilter'] as const).some(
        (flag) =>
          provider.capabilities[flag] !== undefined && typeof provider.capabilities[flag] !== 'boolean',
      )
    )
      throw new TypeError('invalid child agent registration')
  },
  capabilities: (provider) =>
    ([...CHILD_AGENT_FLAGS, 'budget', 'toolFilter'] as const).filter((flag) => provider.capabilities[flag]),
})

export const referenceResolverKind = defineKind<ReferenceResolver>({
  kind: 'reference-resolver',
  scope: 'generation',
  validate(provider) {
    if (typeof provider.search !== 'function' || typeof provider.resolve !== 'function')
      throw new TypeError('Reference resolver requires search and resolve')
  },
})
