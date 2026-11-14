/** The initial state of the fake panel server and the detail pages in it, built from the row builders. */

import {
  builtInBase,
  builtInParts,
  defaultPrompts,
  SKILL_NAME,
  SKILL_PREFIX,
  TEAM_SECTIONS,
} from '../../../superagent/src/app/prompts.js'
import { SettingsSchema } from '../../../superagent/src/policy.js'
import type { ThreadPageView, TicketPageView } from '../../src/api.js'
import { actor, MACHINE, MEMBER, threadSummary, ticketSummary, trigger } from './panel-fixtures.js'
import type { PanelServer } from './panel-server.js'
export const acceptDecision = (): NonNullable<TicketPageView['decision']> => ({
  id: 'd1',
  kind: 'accept',
  outcome: 'accept',
  reason: [{ code: 'explicitRouted' }],
  at: '2026-09-22T00:00:00Z',
  strength: 'explicit',
  ticketId: undefined,
  triggerIds: ['e1'],
  thread: 'feishu:oc_1:om_root',
  rules: [],
  preview: '@bot 修一下',
  ticketTitle: undefined,
})
export const ticketDetail = (): TicketPageView => ({
  ...ticketSummary(),
  paused: false,
  decision: acceptDecision(),
  decisionArchived: false,
  threads: [threadSummary()],
  mandate: {
    strength: 'explicit',
    policyVersion: 'abcdef1234567890',
    basis: { via: 'addressed', sender: 'Alice', addressed: 'mention' },
    actor: actor('feishu', MEMBER),
    scope: '修复登录页回归',
  },
  basis: {
    facts: [
      { name: 'sender', value: 'Alice' },
      { name: 'addressed', value: 'mention' },
    ],
    legacy: false,
  },
  environment: [
    {
      key: 'DSH_SUPERAGENT_DIR',
      value: '/w/t1',
      description: { zh: '执行目录', en: 'Directory' },
      owner: 'executor',
    },
    {
      key: 'DSH_SUPERAGENT_GITHUB_NUMBER',
      value: '',
      description: { zh: '编号', en: 'Number' },
      owner: 'github',
    },
  ],
  channels: [
    {
      source: 'feishu',
      url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1',
      label: { zh: '飞书消息', en: 'Feishu message' },
    },
    {
      source: 'github',
      url: 'https://github.com/acme/widgets/issues/42',
      label: { zh: 'GitHub #42', en: 'GitHub #42' },
    },
  ],
  assignments: [
    {
      id: 'a1',
      state: 'running',
      createdAt: '2026-09-22T00:00:00Z',
      startedAt: '2026-09-22T00:01:00Z',
      report: { state: 'progress', summary: 'working', at: '2026-09-22T00:02:00Z' },
    },
  ],
  inputs: [
    {
      id: 'i1',
      kind: 'trigger',
      triggerId: 'e2',
      at: '2026-09-22T00:03:00Z',
      delivered: false,
      trigger: {
        id: 'e2',
        actor: actor('feishu', MEMBER),
        human: true,
        preview: '顺便改标题',
        thread: 'feishu:oc_1:om_root',
      },
    },
    {
      id: 'i2',
      kind: 'policy-changed',
      at: '2026-09-22T00:04:00Z',
      delivered: true,
      from: 'aaaaaaaaaaaaaaaa',
      to: 'bbbbbbbbbbbbbbbb',
    },
  ],
})
export function threadPage(
  key: string,
  { before, around }: { before?: string; around?: string },
): ThreadPageView | undefined {
  if (key !== threadSummary().key) return undefined
  const base = {
    ...threadSummary(),
    tickets: [ticketSummary()],
    correlated: [{ key: 'github:42', title: 'PR 42' }],
    decisions: [],
    url: 'https://example.test/thread',
    context: [],
  }
  const decision = {
    id: 'd1',
    outcome: 'accept' as const,
    reason: [{ code: 'said', values: { text: 'x' } }],
    ticketId: 't1',
  }
  if (before === 'cursor-1' || around === 'e1')
    return {
      ...base,
      timeline: [trigger('e1', '2026-09-20T00:00:00Z', { disposition: { decision } })],
      earlier: null,
    }
  return {
    ...base,
    earlier: 'cursor-1',
    timeline: [
      trigger('e3', '2026-09-23T00:00:00Z', { disposition: { fanout: ['t1'] } }),
      trigger('e4', '2026-09-23T00:01:00Z', { disposition: { filtered: { code: 'not_a_member' } } }),
    ],
  }
}
export function initial(): PanelServer {
  const settings = SettingsSchema.parse({
    policy: {
      sources: {
        feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' },
        github: { allowed: [{ id: 'alice' }] },
      },
      rules: [{ id: 'copy', name: '文案修改', enabled: true, instruction: '修正明确的文案错误' }],
    },
    sources: {
      feishu: {
        enabled: true,
        config: {
          channel: 'feishu-bot',
          chats: [{ chatId: 'oc_team', listen: 'mentions' }],
          directMessages: true,
        },
      },
      github: { enabled: true, config: { repository: 'acme/widgets', cli: 'gh-agent' } },
    },
    executor: { blockedCommands: ['gh-personal'] },
  })
  const ended = ticketSummary(
    {
      id: 't0',
      title: '旧工单',
      state: 'ended',
      actions: { retry: false, stop: false },
      ended: { at: '2026-09-21T00:00:00Z', by: 'human', reason: 'Human asked to stop', outcome: 'stopped' },
    },
    { stage: 'ended' },
  )
  const reply = {
    source: 'feishu',
    url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1',
    label: { zh: '飞书消息', en: 'Feishu message' },
  }
  const defaults = { revision: 0, previousRevision: null, savedAt: '', source: 'defaults' }
  return {
    health: {},
    down: false,
    pending: 0,
    opened: [],
    requests: [],
    calls: [],
    misuse: [],
    queued: new Set(),
    dropped: [],
    failing: [],
    setup: {
      machine: MACHINE,
      problem: null,
      feishuProblem: null,
      accounts: {
        repository: 'acme/widgets',
        agent: 'agent-bot',
        feishu: { appId: 'cli_bot', brand: 'feishu', botId: 'ou_bot', name: 'Widgets Bot' },
      },
    },
    settings,
    revisions: { policy: 3, eval: 1, executor: 0 },
    prompts: {
      masterId: 'master',
      sections: TEAM_SECTIONS,
      skillName: SKILL_NAME.source,
      builtin: ['feishu', 'github'],
      skillPrefix: SKILL_PREFIX,
      revision: 0,
      current: { ...defaults, config: defaultPrompts() },
      defaults: defaultPrompts(),
      parts: Object.entries(builtInParts()).map(([key, part]) => ({
        key,
        ...part,
        base: builtInBase(part.text),
      })),
      defaultChanged: [],
      revisions: [{ ...defaults, changed: [] }],
      sessions: [],
      notificationPending: false,
      next_offset: null,
    },
    tickets: { open: [ticketSummary()], ended: [ended] },
    ticketDetails: { t1: ticketDetail() },
    threads: [threadSummary()],
    threadPages: threadPage,
    person: [
      ticketSummary(
        {
          attention: { id: 'q1', question: '需要确认按钮颜色' },
          note: { text: '需要确认按钮颜色', error: false },
          reply,
        },
        { stage: 'person', action: 'answer' },
      ),
      ticketSummary(
        {
          id: 't4',
          title: '截图工具',
          actions: { retry: true, stop: true },
          sessionId: 'worker-t4',
          summary: 'LlmError: no adapter registered for provider "provider-a"',
          note: { text: 'LlmError: no adapter registered for provider "provider-a"', error: true },
        },
        { stage: 'person', action: 'failed' },
      ),
    ],
    search: { items: [], threads: [] },
    history: {
      current: 3,
      policyVersion: 'abcdef1234567890',
      items: [
        {
          revision: 4,
          savedAt: '2026-09-23T00:00:00Z',
          source: 'panel',
          policyVersion: '9876543210fedcba',
          policyChanged: true,
          notified: [],
          block: 'source:feishu',
          changes: [{ code: 'sourceRowsAdded', source: 'feishu', field: 'chats', items: ['oc_team'] }],
        },
        {
          revision: 3,
          savedAt: '2026-09-22T00:00:00Z',
          source: 'panel',
          policyVersion: 'abcdef1234567890',
          policyChanged: true,
          notified: [{ id: 't1', title: '修复回归' }],
          block: 'policy',
          changes: [
            { code: 'mode', from: 'off', to: 'observe' },
            { code: 'sourceField', source: 'feishu', field: 'directMessages', from: true, to: false },
            { code: 'sourceRowsAdded', source: 'feishu', field: 'chats', items: ['oc_other', 'oc_new'] },
          ],
        },
      ],
    },
  }
}
