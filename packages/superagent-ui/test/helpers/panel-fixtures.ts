import type { ApiResponse } from '../../../superagent/src/runtime/panel-api.js'
import { type SetupCode, SetupError } from '../../../superagent/src/setup.js'
import { feishuKind } from '../../../superagent/src/sources/feishu.js'
import { feishuChannel } from '../../../superagent/src/sources/feishu-trigger.js'
import { githubKind } from '../../../superagent/src/sources/github.js'
import { githubChannel } from '../../../superagent/src/sources/github-trigger.js'
import type { SourceKind } from '../../../superagent/src/sources/kind.js'
import type { DroppedReply, PromptsView, ThreadRow, TicketRow, TicketStage, TriggerRow } from '../../src/api.js'

export const MEMBER = 'ou_alice'
export const ALLOWED: Record<string, { id: string; name?: string }[]> = {
  feishu: [{ id: MEMBER, name: 'Alice' }],
  github: [{ id: 'alice' }],
}
type Actor = TriggerRow['actor']
/** Resolve an actor display label using the fixture policy's allowed list or the source kind's unnamed fallback. */
export function actor(source: string, id: string, human = true): Actor {
  if (!id) return { source, id }
  const entry = ALLOWED[source]?.find((item) => item.id.toLowerCase() === id.toLowerCase())
  const unnamed = source === 'feishu' ? feishuKind.policy?.unnamed : undefined
  const name = entry ? entry.name || entry.id : unnamed ? undefined : id
  return { source, id, name: name ? { zh: name, en: name } : human ? unnamed?.person : unnamed?.bot }
}
type TicketFields = Omit<TicketRow, 'stage' | 'action'>
export const TICKET = {
  id: 't1',
  title: '修复回归',
  state: 'open',
  actions: { retry: false, stop: true },
  strength: 'explicit',
  ended: undefined,
  attention: undefined,
  assignments: 1,
  inputs: 2,
  undelivered: 0,
  deliveryError: undefined,
  sessionId: 'worker-t1',
  directory: '/w/t1',
  summary: 'working on it',
  createdAt: '2026-09-22T00:00:00Z',
  updatedAt: '2026-09-23T00:00:00Z',
  threads: [
    {
      key: 'github:42',
      source: 'github',
      title: '#42 Fix login',
      url: 'https://github.com/acme/widgets/pull/42',
      facts: {
        number: { value: '#42' },
        ci: { label: { zh: 'CI 失败', en: 'CI failed' }, value: '1', problem: true },
      },
    },
  ],
} satisfies TicketFields
export const ticketSummary = (fields: Partial<TicketFields> = {}, stage: TicketStage = { stage: 'working' }): TicketRow => ({ ...TICKET, ...fields, ...stage })
export const threadSummary = (fields: Partial<ThreadRow> = {}): ThreadRow => ({
  key: 'feishu:oc_1:om_root',
  source: 'feishu',
  title: '这个文案好奇怪',
  stage: 'subscribed',
  latest: undefined,
  lastAt: '2026-09-23T00:00:00Z',
  createdAt: '2026-09-22T00:00:00Z',
  subscriptions: 1,
  tickets: [{ id: 't1', title: '修复回归', state: 'open' }],
  evaluating: undefined,
  pending: 0,
  pollError: undefined,
  url: undefined,
  facts: { chat: { value: '团队群' } },
  ...fields,
})
type TriggerFields = Partial<Omit<TriggerRow, 'disposition' | 'actions'>> & {
  disposition?: Partial<TriggerRow['disposition']>
}
/** Build a trigger row on the default thread and compute `actions.requeue` using the host's eligibility rules. */
export function trigger(id: string, at: string, { disposition, ...fields }: TriggerFields = {}): TriggerRow {
  const row = {
    id,
    source: 'feishu',
    actor: actor('feishu', MEMBER),
    human: true,
    at,
    text: `message ${id}`,
    preview: `message ${id}`,
    url: undefined,
    threads: ['feishu:oc_1:om_root'],
    ...fields,
    disposition: {
      queued: false,
      evaluating: false,
      delivered: false,
      filtered: undefined,
      fanout: [],
      handbacks: [],
      decision: undefined,
      ...disposition,
    },
  }
  return { ...row, actions: { requeue: requeueable(row) } }
}
const requeueable = ({ human, disposition: d }: Pick<TriggerRow, 'human' | 'disposition'>) =>
  human && !d.queued && !d.evaluating && (!!d.filtered || d.decision?.outcome === 'unavailable' || d.delivered || (d.fanout.length > 0 && !d.decision))
type SearchItem = ApiResponse<'GET search'>['items'][number]
export function found(id: string, at: string, { threadTitle, filtered, ...fields }: TriggerFields & { threadTitle?: string; filtered?: string } = {}): SearchItem {
  const { text: _text, ...result } = trigger(id, at, fields)
  return filtered === undefined ? { ...result, threadTitle } : { ...result, threadTitle: undefined, filtered }
}
export const promptVersion = (revision: number, config: PromptsView['current']['config']): PromptsView['current'] => ({
  revision,
  previousRevision: revision ? revision - 1 : null,
  savedAt: '',
  source: 'panel',
  config,
})
/** Build a dropped outbound reply fixture (`feishu` replies to `oc_1`/`om_root`; `github` comments on PR #42). */
export const droppedReply = (id: string, hoursAgo: number, source: 'feishu' | 'github', reason: DroppedReply['dropped']['reason'], { ticket, thread }: { ticket?: DroppedReply['ticket']; thread?: false } = {}): DroppedReply => ({
  id,
  preview: `Reply ${id}`,
  kind: 'reply',
  channel: source === 'feishu' ? feishuChannel('oc_1', 'om_root') : githubChannel(42),
  dropped: { at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), reason },
  ...(ticket ? { ticket } : {}),
  ...(thread === false ? {} : { thread: source === 'feishu' ? 'feishu:oc_1:om_root' : 'github:42' }),
})
export const dayAgo = () => new Date(Date.now() - 86_400_000).toISOString()
export const problemOf = (code: SetupCode, values: Record<string, string> = {}) => new SetupError(code, values).problem
// The kinds' configurations differ, and the fake reads them only as the records the views carry.
export const KINDS = [feishuKind, githubKind] as unknown as SourceKind[]
export const MACHINE = {
  stateDir: '/srv/superagent',
  promptMaxChars: 100000,
  admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15000,
}
