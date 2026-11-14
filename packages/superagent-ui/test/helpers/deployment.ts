// Adapted from dsh-superagent (MIT)
/** Default deployment and machine fixtures for tests. */
import type { Deployment, Machine, Volatile } from '../../../superagent/src/deployment.js'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return {
    get: () => current,
    set: (next) => {
      current = next
    },
  }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/superagent-test',
  promptMaxChars: reference(100000),
  admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000),
  ...overrides,
})
export const testDeployment = (overrides: { [K in keyof Deployment]?: Deployment[K] | undefined } = {}): Deployment =>
  ({
    ...testMachine(),
    repository: 'acme/widgets',
    github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
    feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
    ...overrides,
  }) as Deployment
