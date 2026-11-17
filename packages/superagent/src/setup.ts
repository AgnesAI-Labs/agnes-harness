// Adapted from dsh-superagent (MIT)
/** Structured startup and configuration errors with the settings location where the operator can fix them. */
import { fill } from './infra/text.js'

export type SetupPlace = 'deployment' | 'github' | 'feishu'
export const SETUP_PROBLEMS = {
  feishuCliUnset: [
    'feishu',
    'Enter the absolute path of an already configured bot lark-cli wrapper in the Feishu Source. Old channel instances cannot supply a CLI.',
  ],
  feishuCliMissing: ['feishu', 'The Feishu CLI must be an absolute path to an executable wrapper.'],
  feishuCliFailed: [
    'feishu',
    'The Feishu CLI could not verify its authenticated app. Check the wrapper with auth status.',
  ],
  feishuBotNotReady: [
    'feishu',
    'The Feishu CLI bot identity is not ready. Configure bot authentication first.',
  ],
  feishuUserIdentity: [
    'feishu',
    'The Feishu CLI must use strict-mode bot. User or automatic identity is refused.',
  ],
  feishuNoBot: ['feishu', 'The Feishu CLI did not return a valid bot identity.'],
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
  agentCredentialMixed: [
    'deployment',
    "git would ask other credential helpers than the agent's for github.com: {helpers}.",
  ],
  agentNetrc: [
    'deployment',
    "git would sign in to github.com with {file}, not with the agent's GitHub CLI; remove its github.com or default entry, or run Superagent as a user without one.",
  ],
  agentLoginMismatch: ['github', 'gh acts as @{account}, not the agent account @{login}.'],
  repositoryUnset: ['github', 'The GitHub Source names no repository.'],
  agentCliUnset: ['github', 'The agent GitHub CLI is not set.'],
  agentCliMissing: ['github', 'The agent GitHub CLI was not found.'],
  agentCliInShims: [
    'github',
    'The agent GitHub CLI {cli} is in {shims}, which Superagent writes; name the CLI itself, such as the gh-agent wrapper.',
  ],
  agentCliPathNotAscii: [
    'github',
    "The agent GitHub CLI's path {cli} has characters other than ASCII letters, digits and punctuation, which a Windows shim cannot hold; move the CLI to such a path, such as C:\\Superagent\\bin.",
  ],
  shimsPathTooLong: [
    'deployment',
    "The sessions' PATH with Superagent's shims is {length} characters, longer than the {limit} a Windows shim can read; shorten the PATH the daemon starts with.",
  ],
  agentCliSignedOut: ['github', 'The agent GitHub CLI cannot read its account.'],
  agentCliNoAccount: ['github', 'The agent GitHub CLI did not report a GitHub account.'],
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  repositoryUnreported: ['github', 'The agent GitHub CLI did not return {repository}.'],
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
  agentTokenNoNotifications: [
    'github',
    "The agent's GitHub token cannot read notifications; sign in with gh auth login or a classic token.",
  ],
  agentTokenInKeychain: [
    'github',
    "The agent's GitHub token for @{account} is in the macOS keychain, which Superagent's sandboxed sessions cannot read; sign the agent GitHub CLI in again with auth login --insecure-storage.",
  ],
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
