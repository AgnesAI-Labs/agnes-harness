import { type BusinessAgentsData, useBusinessAgentStart } from '@agnes/web-admin/agents'
import { sessionStartUrl } from '@agnes/web-admin/settings/runtime-panels'
import { useRef } from 'react'
import type { AgentCard } from './agents-model.js'

/** Launch facade adapter: retain today's reviewed package start path until the agent launch facade lands.
 * The selected declaration supplies the exact session combination, permission choice and draft.
 * The current start path still resolves the Loop; replace this adapter with the shared prepare/review/start facade.
 */
export function useAgentLaunch(data: BusinessAgentsData) {
  const selected = useRef<AgentCard>()
  const starter = useBusinessAgentStart({
    api: data.api,
    features: data.features,
    onChanged: data.refreshInstalled,
    openSession: (target) => {
      const card = selected.current
      if (!card) return
      location.assign(
        sessionStartUrl(
          card.declaration.launch.preset,
          card.samplePrompt,
          [card.declaration.ref],
          target.loop,
        ),
      )
    },
  })
  return {
    ...starter,
    start(card: AgentCard) {
      if (
        starter.startingId ||
        (starter.pageId && selected.current?.declaration.ref !== card.declaration.ref)
      )
        return
      selected.current = card
      starter.start(card)
    },
  }
}
