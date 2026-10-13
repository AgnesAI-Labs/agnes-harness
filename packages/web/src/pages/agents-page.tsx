import {
  AGENTS_NAMESPACE,
  agentsCatalog,
  type BusinessAgent,
  BusinessAgentGallery,
  businessAgentState,
  suggestedBusinessAgents,
  useBusinessAgentStart,
  useBusinessAgents,
} from '@agnes/web-admin/agents'
import { homeNavigation, type UiExtensionContext } from '@agnes/web-client'
import { IconButton, useUiText } from '@agnes/web-ui'
import type { ReactNode } from 'react'
import { homeAdmin } from './admin-api.js'
import { HomePageFrame } from './page-frame.js'

const source = { connect: homeAdmin }
const openPlugins = () => homeNavigation.open('plugins')

/** 业务 Agent · FDE: the gallery of business agents, each one click away from a session. */
export function AgentsPage({ context }: { context: UiExtensionContext }) {
  const { t } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
  const data = useBusinessAgents(source)
  return (
    <HomePageFrame
      id="agents"
      title={
        <>
          {context.t('home.entry.agents')}{' '}
          <span className="home-page-title-note">{context.t('home.entry.agents.sub')}</span>
        </>
      }
      description={t('description')}
      actions={
        <IconButton
          name="refresh-cw"
          label={t('refresh')}
          data-testid="business-agents-refresh"
          disabled={data.busy}
          onClick={data.reload}
        />
      }
    >
      <BusinessAgentGallery data={data} onOpenPlugins={openPlugins} />
    </HomePageFrame>
  )
}

/**
 * Business agents for a surface that suggests a few, such as the new-session empty state: the
 * suggestions (ready ones first), `start` to run one-click start for one of them, and the dialog
 * to render once. Starting ends in a new-session draft with the agent's loop selected and its
 * sample prompt filled in.
 */
export function useBusinessAgentSuggestions(count = 3): {
  agents: readonly BusinessAgent[]
  total: number
  start(agent: BusinessAgent): void
  dialog: ReactNode
} {
  const data = useBusinessAgents(source)
  const starter = useBusinessAgentStart({
    api: data.api,
    features: data.features,
    onChanged: data.refreshInstalled,
    onOpenPlugins: openPlugins,
  })
  return {
    agents: suggestedBusinessAgents(data.agents, data.installed, count),
    total: data.agents.length,
    // A ready agent needs no confirmation: it goes straight to the new session.
    start: (agent) =>
      starter.start(agent, {
        quiet: businessAgentState(data.installed.find((item) => item.id === agent.entry.id)) === 'ready',
      }),
    dialog: starter.dialog,
  }
}
