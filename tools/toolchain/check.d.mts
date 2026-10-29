export const root: string
type Runtime = { version: string; execPath: string }
export function assertRuntime(runtime: Runtime, expected?: Runtime): void
export function verificationEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
export function pnpmInvocation(env?: NodeJS.ProcessEnv): string[]
export function checkToolchain(env?: NodeJS.ProcessEnv): {
  runtime: Runtime
  child: Runtime
  packageManager: string
}
