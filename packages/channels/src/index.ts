export * from './adapter.js'
export * from './degrade.js'
export * from './errors.js'
export * from './manifest.js'
export * from './runner/config.js'
export { createRunner, type Runner, type RunnerDeps, type RunnerStatus } from './runner/runner.js'

export const PACKAGE_NAME = '@agnes/channels' as const
