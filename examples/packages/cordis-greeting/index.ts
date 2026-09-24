import { type AgnesPlugin, type Context, defineAgnesPlugin } from '@agnes/plugin-runtime'

export interface GreetingConfig {
  readonly message: string
}

const Config = {
  '~standard': {
    version: 1 as const,
    vendor: 'agnes-example',
    validate(value: unknown) {
      if (
        typeof value !== 'object' ||
        value === null ||
        typeof (value as { message?: unknown }).message !== 'string'
      ) {
        return { issues: [{ message: 'message must be a string' }] }
      }
      return { value: { message: (value as { message: string }).message.trim() } }
    },
  },
}

const plugin: AgnesPlugin<GreetingConfig> = {
  Config,
  provide: 'demoGreeting',
  apply(ctx: Context, config: GreetingConfig) {
    ctx.provide('demoGreeting', config.message)
  },
}

export const greeting = defineAgnesPlugin(plugin)
