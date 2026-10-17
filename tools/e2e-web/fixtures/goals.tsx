import { Context } from '@agnes/cordis'
import {
  AgnesClientService,
  ClientResourceService,
  CommandService,
  clientModule,
  LocaleService,
  SessionService,
  SlotRegistry,
  ThemeService,
  workbenchPanels,
} from '@agnes/web-client'
import { webLocaleCatalog } from '@agnes/web-foundation/locale-catalog'
import { createAntdRoot } from '@agnes/web-ui'
import * as official from '../../../packages/package-manager/bundled-plugins/goal-ui/src/client.js'
import { RegisteredConversationCard } from '../../../packages/web-conversation/src/registered-card.js'

const ctx = new Context()
await ctx.plugin(SlotRegistry)
const client = { sessions: { get: () => undefined } } as never
new AgnesClientService(ctx, client)
new CommandService(ctx)
const session = new SessionService(ctx)
new ClientResourceService(ctx, client, session)
new ThemeService(ctx, 'light')
const locale = new LocaleService(ctx, 'en')
locale.register('web', webLocaleCatalog)
await ctx.plugin(clientModule(official), {
  packageId: '@agnes/goal-ui',
  revision: 'fixture',
  allowedSlots: [],
  slotCatalogVersion: 'dsh-client-slots/v1',
  binding: { owner: 'fixture-goal', lifetime: 'profile', availability: 'active' },
} as never)
const goal = {
  id: 'goal-1',
  revision: 2,
  objective: 'Review the plugin contracts and ship the patch',
  phase: 'active',
  rounds: 2,
  maxRounds: 10,
  creditsUsed: 1.25,
  budgetCredits: 10,
} as const
const timeline = {
  sessionId: 'synthetic',
  slots: [
    { extId: 'agnes/goal', slot: 'status.line', payload: { text: 'Active goal', level: 'info', goal } },
  ],
  nodes: [],
}
const context = {
  t: (key: string, vars?: Readonly<Record<string, string | number>>) => locale.t(key, vars),
  data: { timeline, disabled: false, command() {} },
}
const Panel = workbenchPanels.get('goal')!.component
createAntdRoot(document.getElementById('fixture-root')!).render(
  <main style={{ padding: 32 }}>
    <RegisteredConversationCard card={{ kind: 'session.actions', data: context.data }} context={context} />
    <div style={{ marginTop: 24, width: 400 }}>
      <Panel context={context} />
    </div>
  </main>,
)
