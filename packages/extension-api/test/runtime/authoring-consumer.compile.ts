import type {
  ProviderFactory,
  PublicProviderInstance,
  RuntimePluginDefinition,
} from '@agnes/extension-api/runtime'
import type {
  InterceptorDefinition,
  PureToolDefinition,
  SimpleLoopDefinition,
} from '@agnes/extension-api/runtime/authoring'
import {
  defineRoutingStrategy,
  defineRuntimePlugin,
  defineSimpleLoop,
} from '@agnes/extension-api/runtime/authoring'

export const routing = defineRoutingStrategy({
  id: 'first-route',
  select(input) {
    const route = input.allowedRoutes[0]
    if (!route) throw new Error('No authorized route')
    return { route, reason: 'first authorized route' }
  },
})

export const simple = defineSimpleLoop({
  id: 'simple',
  permissions: [],
  next: () => ({ kind: 'finish', output: null }),
})
declare const completeFactory: ProviderFactory<PublicProviderInstance>
declare const completeRuntime: RuntimePluginDefinition
export const authorPlugin = defineRuntimePlugin({
  id: '@demo/simple',
  version: '1.0.0',
  providers: [simple, completeFactory],
})
// @ts-expect-error A source declaration is not an executable provider factory.
export const invalidFactory: ProviderFactory<PublicProviderInstance> = simple
export const invalidRuntime: RuntimePluginDefinition = {
  ...completeRuntime,
  // @ts-expect-error The Runtime accepts only built factories.
  providers: [simple],
}

export type ToolContext = Parameters<PureToolDefinition<string>['execute']>[1]
export function checkToolContext(context: ToolContext): void {
  // @ts-expect-error Pure tools have no effect broker.
  context.effects
  // @ts-expect-error Call cancellation is controlled by the host.
  context.signal = new AbortController().signal
}

export const asyncDecision: SimpleLoopDefinition = {
  id: 'async-loop',
  permissions: [],
  // @ts-expect-error A decision callback cannot return a Promise.
  async next() {
    return { kind: 'finish', output: null }
  },
}

export const interceptor: InterceptorDefinition<'tool_call'> = {
  id: 'check-tool',
  event: 'tool_call',
  execution: 'pure',
  permissions: [],
  readFields: ['/args'],
  writeFields: ['/allow'],
  handle(input) {
    // @ts-expect-error Hook projections are deeply readonly.
    input.args = null
    return { allow: true }
  },
}

export const invalidDirective: InterceptorDefinition<'tool_call'> = {
  id: 'invalid-directive',
  event: 'tool_call',
  execution: 'pure',
  permissions: [],
  readFields: [],
  writeFields: ['/allow'],
  // @ts-expect-error A tool directive does not create an approval decision variant.
  handle() {
    return { allow: 'ask' }
  },
}
