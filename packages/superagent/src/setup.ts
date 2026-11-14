// Adapted from dsh-superagent (MIT)
/** Structured startup and configuration errors with the settings location where the operator can fix them. */
import { fill } from './infra/text.js'

export type SetupPlace = 'deployment' | 'github' | 'feishu'
export const SETUP_PROBLEMS = {
  foreignFile: [
    'deployment',
    '{file} was not written by Superagent; move it, or choose another state directory.',
  ],
  gitTooOld: [
    'deployment',
    'git does not read the github.com credential configuration Superagent writes; Superagent needs git 2.32 or later.',
  ],
  environmentFailed: ['deployment', 'Preparing the agent environment failed.'],
  sessionTaken: [
    'deployment',
    'A session {session} exists that Superagent did not open; archive or remove it, then check the setup again.',
  ],
  agentHomeMismatch: [
    'deployment',
    'The daemon runs with HOME {actual}, not the agent home {home}; start this AGH with HOME set to the agent home.',
  ],
  agentGhNotShim: [
    'deployment',
    'Sessions run gh from {actual}, not the shim in {shims}; put {shims} first on the PATH this AGH starts with.',
  ],
  agentCredentialMixed: [
    'deployment',
    "git would ask other credential helpers than the agent's for github.com: {helpers}.",
  ],
  agentLoginMismatch: ['github', 'gh acts as @{account}, not the agent account @{login}.'],
  repositoryUnset: ['github', 'The GitHub Source names no repository.'],
  agentCliUnset: ['github', 'The agent GitHub CLI is not set.'],
  agentCliMissing: ['github', 'The agent GitHub CLI was not found.'],
  agentCliSignedOut: ['github', 'The agent GitHub CLI cannot read its account.'],
  agentCliNoAccount: ['github', 'The agent GitHub CLI did not report a GitHub account.'],
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  repositoryUnreported: ['github', 'The agent GitHub CLI did not return {repository}.'],
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
  feishuCliFailed: ['feishu', 'The bot lark-cli does not work.'],
  feishuNoApp: ['feishu', 'auth status of the bot lark-cli did not report the app.'],
  feishuBotNotReady: [
    'feishu',
    'The bot identity of app {app} is {status}; configure the app secret with lark-cli.',
  ],
  feishuUserIdentity: [
    'feishu',
    'The bot lark-cli allows user identities (strict mode {mode}); give the bot its own lark-cli configuration in strict mode bot.',
  ],
  feishuNoBot: ['feishu', "The Feishu bot API did not return the bot's open_id."],
} as const satisfies Record<string, readonly [SetupPlace, string]>
export type SetupCode = keyof typeof SETUP_PROBLEMS
export interface SetupProblem {
  place: SetupPlace
  code: SetupCode
  values: Record<string, string>
  detail: string
}

/**
 * Thrown by deployment and account verification checks when a required CLI, account, or repository check fails.
 * `Setup` records it for the management overview, and the HTTP layer returns `problem` so the panel can localize it.
 */
export class SetupError extends Error {
  readonly place: SetupPlace
  constructor(
    readonly code: SetupCode,
    readonly values: Record<string, string> = {},
  ) {
    const [place, text] = SETUP_PROBLEMS[code]
    const sentence = fill(text, values)
    super(values.output ? `${sentence}\n${values.output}` : sentence)
    this.place = place
  }
  get problem(): SetupProblem {
    return { place: this.place, code: this.code, values: this.values, detail: this.message }
  }
}
