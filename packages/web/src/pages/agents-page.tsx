import {
  AGENTS_NAMESPACE,
  agentsCatalog,
  BusinessAgentGallery,
  useBusinessAgents,
} from '@agnes/web-admin/agents'
import { homeNavigation, type UiExtensionContext } from '@agnes/web-client'
import { IconButton, useUiText } from '@agnes/web-ui'
import { useMemo } from 'react'
import { homeAdmin } from './admin-api.js'
import { HomePageFrame } from './page-frame.js'

const source = { connect: homeAdmin }
const openPlugins = () => homeNavigation.open('plugins')

/** 业务 Agent · FDE: the gallery of business agents, each one click away from a session. */
export function AgentsPage({ context }: { context: UiExtensionContext }) {
  const { t } = useUiText(AGENTS_NAMESPACE, agentsCatalog)
  const data = useBusinessAgents(source)
  // Another surface may point at one agent: `focus` names its package, `start` begins one-click start.
  const selection = context.selection as { focus?: unknown; start?: unknown } | undefined
  const focusId = typeof selection?.focus === 'string' ? selection.focus : undefined
  const focus = useMemo(
    () => (focusId ? { id: focusId, start: selection?.start === true } : undefined),
    // The selection object is new for every request, so the same card can be asked for again.
    [selection, focusId],
  )
  return (
    <HomePageFrame
      id="agents"
      title={
        <>
          {context.t('home.entry.agents')}{' '}
          <span className="home-page-title-note">{context.t('home.entry.agents.sub')}</span>
        </>
      }
      // Starting an agent opens its page inside this one: Agent FDE › the agent.
      pushTitle={`${context.t('home.entry.agents')} ${context.t('home.entry.agents.sub')}`}
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
      <BusinessAgentGallery data={data} focus={focus} onOpenPlugins={openPlugins} />
    </HomePageFrame>
  )
}
