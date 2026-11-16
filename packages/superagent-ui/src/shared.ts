/**
 * What the panel needs by value from the Superagent package: the limits, texts and filter lists its forms and
 * translations are keyed by. The panel bundle carries no other package, so these are copies; a test keeps each
 * identical to its source, and the types come from the package's `panel-api`.
 */
export type {
  AdmissionRowView,
  Choice,
  FieldSpec,
  Health,
  Localized,
  TicketStage,
} from '@agnes/superagent/panel-api'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = (typeof TICKET_FILTERS)[number]
export type ThreadFilter = (typeof THREAD_FILTERS)[number]

export const LIMITS = {
  ruleName: 100,
  ruleInstruction: 2000,
  evalTimeoutSeconds: { min: 30, max: 600 },
  maxWorkers: { min: 1, max: 16 },
  prepareCommand: 4000,
  promptMaxChars: { min: 1000, max: 1_000_000 },
  admissionContextMaxPages: { min: 1, max: 100 },
  admissionContextTimeoutMs: { min: 1, max: 90_000 },
} as const

export const HEALTH_TEXT = {
  setupPending: 'Waiting for the deployment check',
  sourceOff: 'Off',
  feishuDedicatedBot:
    "Direct messages and other chats need a Feishu bot instance of Superagent's own; only the listed chats are received",
  feishuWaiting: 'Waiting for the channel subscription',
  feishuChannelUnset: 'Setup required: the Source is on, and its channel instance is not set',
  feishuChatsUnset: 'Setup required: no chat is listed to receive',
  feishuChannelRefused:
    'Setup required: the channel instance {channel} refused the chats ({reason}); retrying',
  feishuPluginUnset:
    'Setup required: to claim the whole instance, name it with its channel row, as <channel row id>/<instance id>',
  feishuInstanceShared:
    'Setup required: the channel instance {channel} already serves the owner or another feature, or a pairing code for it is still unused (it expires within an hour); use a dedicated bot instance',
  feishuInstanceReleasing:
    'Setup required: the channel instance {channel} is in use; waiting for a previous Superagent run to release it',
  feishuInstanceRefused:
    'Setup required: the channel instance {channel} refused the claim ({reason}); retrying',
  feishuNoHistory:
    'The channel cannot read chat history, so nothing is recovered after a restart or disconnect',
  feishuNoMembers:
    'The channel cannot list chat members, so the allowlist is not synced and the allowlist in the settings applies',
  feishuNoReads:
    'The channel cannot read messages or threads, so orchestrator_feishu_read and context reads are unavailable',
  pollFailures: '{count} consecutive failed polls; last: {error}',
} as const
export type HealthCode = keyof typeof HEALTH_TEXT
export const USER_ERRORS = {
  unknownTicket: ['missing', 'Unknown ticket'],
  unknownProblem: ['missing', 'Unavailable Eval not found'],
  unknownTrigger: ['missing', 'Unknown trigger'],
  unknownAssignment: ['missing', 'Unknown assignment'],
  unknownBlock: ['missing', 'Unknown settings block: {block}'],
  unknownPromptRevision: ['missing', 'Unknown prompt revision {revision}'],
  unknownPromptPart: ['refused', 'Unknown built-in prompt part {part}'],
  ticketEnded: ['refused', 'Ticket has ended'],
  assignmentEnded: ['refused', 'Assignment has ended; a newer assignment owns this ticket'],
  evalFinished: [
    'refused',
    "Eval {eval} has finished or a later eval replaced it; decide the trigger's current eval",
  ],
  notAdmissible: ['refused', 'Trigger is not admissible: {reason}'],
  notExplicit: [
    'refused',
    'An accept through orchestrator_route is for explicit requests from allowed senders; assess proactive candidates with orchestrator_eval and orchestrator_eval_decide',
  ],
  ticketStopped: [
    'refused',
    'A person stopped this ticket; new work needs an accept through orchestrator_route',
  ],
  mandateRevoked: [
    'refused',
    "The current policy no longer holds this ticket's mandate; new work needs an accept through orchestrator_route",
  ],
  notRetryable: [
    'refused',
    'Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed',
  ],
  sourceThread: ['refused', 'This is the thread the ticket started on; it stays subscribed'],
  followedThread: [
    'refused',
    "This thread is the ticket's own, such as its pull request's; it stays subscribed",
  ],
  notFollowing: ['refused', 'This ticket does not follow that thread'],
  questionWithResult: [
    'refused',
    'A question for a person cannot also be a ready result or an answer; report it separately',
  ],
  askerWithoutQuestion: ['refused', 'The message that raised a question needs the question it raised'],
  notAsker: [
    'refused',
    "A question must name the person's message that raised it, which reached this ticket",
  ],
  notAnswerable: [
    'refused',
    "An answer must name the person's question it answers, which reached this ticket",
  ],
  ackEnded: ['refused', 'Ticket ended; do not acknowledge historical requests'],
  notReached: ['refused', 'Trigger does not belong to this worker'],
  handedBack: ['refused', 'This ticket handed that trigger back already'],
  handedBackHere: [
    'refused',
    'The worker of this ticket handed that trigger back as beyond it: accept it as new work, attach it to another ticket, or ignore it',
  ],
  workerDecides: [
    'refused',
    'This message reached ticket {tickets} on its thread: its worker decides whether it belongs there and hands back what does not, which then arrives as a candidate. Only a stop goes through orchestrator_route, with kind stop',
  ],
  ackNoChannel: ['refused', 'Acknowledgement requires an assigned human source message'],
  ackNotPerson: ['refused', 'Use the original human trigger, not a bot, CI or worker report'],
  notReady: [
    'refused',
    'Ticket is not ready for delivery. Keep progress internal and wait for a verified ready report; do not relabel progress as an answer or send it through another channel.',
  ],
  notAttention: [
    'refused',
    "Attention requires the ticket's current attention question in human_action. Routine unfinished work stays internal.",
  ],
  notQuestion: [
    'refused',
    'An answer must target the original human question, not a worker report or automated trigger',
  ],
  noAnswer: [
    'refused',
    "No worker answer is ready for this human trigger. Wait for the worker's report, or request one with orchestrator_ticket_request_status, which acts only on a worker that reported waiting; ordinary progress cannot be relabelled as an answer.",
  ],
  noChannel: ['refused', 'No reply channel for this ticket or trigger'],
  panelOnlyEnvironment: [
    'refused',
    'The execution environment (ticket directory, prepare command, blocked commands) can only be changed in the management panel',
  ],
  panelOnlyAccounts: [
    'refused',
    'Source fields that setup reads, such as account CLIs, can only be changed in the management panel',
  ],
  setupComplete: ['refused', 'Setup is complete'],
  modelUnavailable: ['refused', 'The {block} model is not available: {error}'],
  promptTooLong: ['refused', 'Prompt configuration exceeds {limit} characters'],
  promptPlaceholders: [
    'refused',
    'The “{part}” template must keep {placeholders}, which the system fills in',
  ],
  promptPartEmpty: ['refused', 'The “{part}” part cannot be empty; reset it to follow its built-in text'],
  sourceNotInstalled: ['refused', 'The {source} Source kind is not installed'],
  noLabels: ['refused', 'This Source has no names to refresh'],
  nothingToSync: [
    'refused',
    "The {source} Source's part of the Policy has nothing to sync from, or the Source is off or waiting for setup",
  ],
} as const satisfies Record<string, readonly ['missing' | 'refused', string]>
export type UserErrorCode = keyof typeof USER_ERRORS

export const REASONS = {
  said: '{text}',
  timeout: 'Assessment timed out',
  policyChanged: 'Policy changed during assessment',
  noAdmissible: 'No admissible trigger',
  startedTicket: 'Already started ticket {ticket}',
  acceptedBefore: 'Trigger {trigger} was accepted before',
  routed: 'Routed to ticket {ticket}',
  explicitRouted: 'Explicit request from an allowed sender routed by the orchestrator',
  humanStop: 'Human asked to stop',
  legacyImport: 'Imported from the pre-domain-model task record',
  forwarded: 'Forwarded to the worker of the Ticket already on this Thread',
  senderNotMember: "The sender is not on the Source's list",
  retried: 'Retried by a person',
  hostRestarted: 'Superagent restarted',
  stopUnknown: 'Stop target is unknown or already ended',
  stopNotExplicit: 'A stop needs an explicit request from a sender on the list',
  directionUnsettled:
    'Implementation intent or target direction is not established, or a product/design decision is still required',
  noRuleMatched: 'No enabled admission rule matched',
  ignoredFromCard: 'Ignored from its card, without a rule assessment',
  observed: 'Observe mode: would accept ({text})',
} as const
export type ReasonCode = keyof typeof REASONS
/** Reason code and template values; `triggerId` identifies the trigger in a batch that the reason applies to. */
export interface Reason {
  code: ReasonCode | (string & {})
  values?: Record<string, string>
  triggerId?: string
}
export const said = (text: string): Reason => ({ code: 'said', values: { text } })
/** Formats reasons in English (prefixed by `triggerId` when present) for agent consumption. */
export function reasonText(reasons: readonly Reason[] | Reason | undefined): string {
  return [reasons ?? []]
    .flat()
    .map((reason) => {
      const template: string = REASONS[reason.code as ReasonCode] ?? reason.code
      const text = template.replace(/\{(\w+)\}/g, (match, name: string) => reason.values?.[name] ?? match)
      return reason.triggerId ? `${reason.triggerId}: ${text}` : text
    })
    .join('; ')
}

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
  platformUnsupported: ['deployment', 'Superagent supports macOS and Linux; it does not run on {platform}.'],
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
  agentCliSignedOut: ['github', 'The agent GitHub CLI cannot read its account.'],
  agentCliNoAccount: ['github', 'The agent GitHub CLI did not report a GitHub account.'],
  repositoryUnreadable: ['github', '@{account} cannot read {repository}.'],
  repositoryUnreported: ['github', 'The agent GitHub CLI did not return {repository}.'],
  repositoryReadOnly: ['github', '@{account} cannot push to {repository}.'],
  agentTokenNoNotifications: [
    'github',
    "The agent's GitHub token cannot read notifications; sign in with gh auth login or a classic token.",
  ],
} as const satisfies Record<string, readonly [SetupPlace, string]>
export type SetupCode = keyof typeof SETUP_PROBLEMS
export interface SetupProblem {
  place: SetupPlace
  code: SetupCode
  values: Record<string, string>
  detail: string
}

export type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
export type Admission = 'explicit' | 'inferred' | 'ignore'
export const ADMISSION_OPTIONS = {
  listedUnaddressed: ['inferred', 'ignore'],
  unlistedAddressed: ['explicit', 'inferred', 'ignore'],
  unlistedUnaddressed: ['inferred', 'ignore'],
} as const satisfies Record<AdmissionCell, readonly Admission[]>
export type AdmissionRow = { [C in AdmissionCell]?: (typeof ADMISSION_OPTIONS)[C][number] | undefined }
/** Default admission rules (matching pre-table behavior): unaddressed messages from listed senders are inferred candidates; unlisted senders are ignored. */
export const ADMISSION_DEFAULTS: Readonly<Record<AdmissionCell, Admission>> = {
  listedUnaddressed: 'inferred',
  unlistedAddressed: 'ignore',
  unlistedUnaddressed: 'ignore',
}
