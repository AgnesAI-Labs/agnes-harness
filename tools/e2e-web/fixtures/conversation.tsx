import { Context } from '@agnes/cordis'
import type { ContentBlock, UINode, UITurn } from '@agnes/protocol'
import { type ClientResourceService, LocaleService, type SessionService } from '@agnes/web-client'
import { webLocaleCatalog } from '@agnes/web-foundation/locale-catalog'
import { createAntdRoot, webUiLocaleCatalog } from '@agnes/web-ui'
import {
  AssistantRuntimeProvider,
  createConversationProjectionStore,
  useConversationRuntime,
} from '@agnes/web-ui/assistant-ui'
import { Approval, webUnitsLocaleCatalog } from '@agnes/web-units'
import { useState } from 'react'
import { WebConversationMessages } from '../../../packages/web/src/conversation-message-adapter.js'

// Synthetic contract data, real renderer and shared stylesheet. No daemon, model or process effects.
const localeName = new URLSearchParams(location.search).get('locale') === 'zh-CN' ? 'zh-CN' : 'en'
document.documentElement.lang = localeName
const locale = new LocaleService(new Context(), localeName)
locale.register('@agnes/web', webLocaleCatalog)
locale.register('@agnes/web-ui', webUiLocaleCatalog)
locale.register('@agnes/web-units', webUnitsLocaleCatalog)
const tool = (id: string, name: string, resultPreview?: string): Extract<UINode, { kind: 'tool' }> => ({
  kind: 'tool',
  id,
  name,
  seq: 2,
  toolUseId: id,
  status: 'completed',
  summary: name,
  ...(resultPreview ? { resultPreview } : {}),
})
const nodes: UINode[] = [
  { kind: 'user', id: 'user', seq: 1, content: [{ type: 'text', text: 'Review this delivery' }] },
  tool('read', 'read_file', 'Earlier process detail'),
  {
    ...tool('question', 'ask_user_question'),
    slots: [
      {
        slot: 'tool.card.inline',
        extId: 'interaction',
        payload: {
          title: 'Choose delivery',
          question: {
            id: 'delivery',
            questions: [
              {
                id: 'route',
                question: 'Delivery channel',
                options: ['Web', 'CLI'],
                multiple: true,
                allowFreeText: true,
              },
            ],
          },
        },
      },
    ],
  },
  {
    ...tool('file', 'present'),
    slots: [
      {
        slot: 'tool.card.inline',
        extId: 'present',
        payload: {
          title: 'Delivery',
          deliverables: [
            {
              name: 'delivery-report.txt',
              description: 'Synthetic report for browser layout acceptance',
              lane: 'main',
              ref: { sha256: 'a'.repeat(64), size: 6, mime: 'text/plain' },
            },
          ],
        },
      },
    ],
  },
  {
    ...tool('workflow', 'workflow_wait'),
    slots: [
      {
        slot: 'tool.card.inline',
        extId: 'agnes/workflow',
        payload: {
          title: 'Report workflow',
          table: {
            columns: ['Stage', 'Member', 'Status', 'Session', 'Run', 'Id', 'Integration'],
            rows: [
              [
                'Draft',
                'Writer',
                'completed',
                'child-worktree',
                'completed',
                'workflow-fixture',
                'not-merged-by-workflow',
              ],
            ],
          },
        },
      },
    ],
  },
  tool('job', 'job_output', 'job-fixture: running\nSynthetic captured output'),
  tool('child', 'subagent_list', 'child-fixture completed continuable'),
  { kind: 'assistant', id: 'final', seq: 3, text: 'Review the deliverable and choose a channel.' },
]
const turn: UITurn = {
  id: 'turn:fixture',
  turn: 1,
  startSeq: 1,
  startedAt: '2026-10-01T00:00:00Z',
  endedAt: '2026-10-01T00:00:01Z',
  status: 'completed',
  nodeIds: nodes.map((n) => n.id),
  finalAssistantId: 'final',
  inherited: false,
  forkable: false,
  usage: {
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    reasoningComplete: true,
    billingComplete: true,
    calls: [],
  },
}
const store = createConversationProjectionStore({ sessionId: 'fixture-session', nodes, turns: [turn] })
const resources = {
  files: {
    async load() {
      const url = URL.createObjectURL(new Blob(['report'], { type: 'text/plain' }))
      return { url, release: () => URL.revokeObjectURL(url) }
    },
  },
} as unknown as ClientResourceService
function Fixture() {
  const runtime = useConversationRuntime(store)
  const [answer, setAnswer] = useState<ContentBlock[]>()
  const [plan, setPlan] = useState(true)
  const [decision, setDecision] = useState('')
  const session = {
    commands: {
      async prompt(content: { type: 'text'; text: string }[]) {
        setAnswer(content)
        const next: UINode[] = [...nodes, { kind: 'user', id: 'answer', seq: 4, content }]
        store.update({ sessionId: 'fixture-session', nodes: next, turns: [turn] })
      },
    },
  } as unknown as SessionService
  return (
    <main className="conversation-fixture">
      <div id="transcript-content">
        <AssistantRuntimeProvider runtime={runtime}>
          <WebConversationMessages
            nodes={answer ? [...nodes, { kind: 'user', id: 'answer', seq: 4, content: answer }] : nodes}
            turns={[turn]}
            locale={locale}
            session={session}
            resources={resources}
          />
        </AssistantRuntimeProvider>
      </div>
      <section id="approval" hidden={!plan} aria-live="polite">
        <Approval
          initialView={{
            key: 'plan-fixture',
            kind: 'plan',
            title: locale.t('app.approval.title'),
            summary: 'Approve this plan to leave plan mode',
            impact: locale.t('app.approval.impact.plan'),
            preview: '1. Review the report\n2. Deliver the result',
            actions: [
              {
                id: 'live:allow_once',
                label: locale.t('app.approval.allowOnce'),
                onSelect() {
                  setPlan(false)
                  setDecision('allow_once')
                },
              },
              {
                id: 'live:reject_once',
                label: locale.t('app.approval.rejectOnce'),
                onSelect() {
                  setPlan(false)
                  setDecision('reject_once')
                },
              },
            ],
            disabled: false,
          }}
        />
      </section>
      <p data-testid="fixture-plan-decision" role="status">
        {decision}
      </p>
    </main>
  )
}
const root = document.getElementById('fixture-root')
if (!root) throw new Error('fixture root missing')
createAntdRoot(root).render(<Fixture />)
