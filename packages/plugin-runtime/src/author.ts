import type { Context, Inject, Plugin } from '@agnes/cordis'

/** A standard Cordis plugin accepted by the Agnes package loader. */
export type AgnesPlugin<Config = unknown> = Plugin<Config>

/** Preserve the plugin's complete inferred Cordis shape without a runtime wrapper. */
export function defineAgnesPlugin<P extends Plugin>(plugin: P): P {
  return plugin
}

export type { Context, Inject, Plugin }
