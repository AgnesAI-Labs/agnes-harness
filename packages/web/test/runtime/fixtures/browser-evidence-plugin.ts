/**
 * Browser fixture for the headless Chrome evidence suite. The suite bundles this file with the
 * platform modules left external and serves it under `/plugins/`, so it runs in a release page
 * against the import-map React, Cordis and web-client singletons. It plays both sides: `apply` is
 * the author client module, and `startHost` is a host with the whole DSH slot catalog declared and
 * a reconciler whose roster the suite publishes. `mountHtmlViewer` renders the host's HTML viewer.
 */
import { Context } from '@agnes/cordis'
import {
  AgnesClientService,
  type ClientContext,
  CommandService,
  DSH_SLOT_CATALOG,
  LocaleService,
  type ModuleIdentity,
  SessionService,
  type SlotName,
  SlotOutlet,
  SlotRegistry,
  SlotsProvider,
  ThemeService,
} from '@agnes/web-client'
import { type ComponentProps, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createReconciler, type ReadyClientModule } from '../../../src/client-modules/reconcile.js'

const Fixture = () => createElement('span', { className: 'evidence-fixture' }, 'fixture')

/** Author module: one fixture in every slot the roster allows, in the shape each slot kind needs. */
export function apply(ctx: ClientContext, config: ModuleIdentity): void {
  for (const name of config.allowedSlots ?? []) {
    const kind = ctx.slots.spec(name)?.kind
    ctx.slots.register(
      {
        name: name as SlotName,
        ...(kind === 'keyed' ? { key: 'fixture' } : {}),
        ...(kind === 'chain' ? { select: () => ({}) } : {}),
      },
      Fixture,
    )
  }
}

/** Host: render every catalog slot in a session and reconcile the roster the suite publishes. */
export async function startHost() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const registry = (ctx as unknown as { slots: SlotRegistry }).slots
  new AgnesClientService(ctx, {} as never)
  new CommandService(ctx)
  const session = new SessionService(ctx, 'fixture-session')
  new ThemeService(ctx, 'light')
  const locale = new LocaleService(ctx, 'en')
  for (const { key, kind, scope } of DSH_SLOT_CATALOG) registry.declare(key, { kind, scope }, 'fixture-host')
  // Only the host may fill the host-only root slot; the author module fills the public ones.
  registry.register({ name: 'root', owner: 'fixture-host' }, Fixture)
  const mount = document.createElement('div')
  mount.id = 'fixture-slots'
  document.body.append(mount)
  createRoot(mount).render(
    createElement(
      SlotsProvider,
      { registry, session, locale },
      ...DSH_SLOT_CATALOG.map(({ key }) => createElement(SlotOutlet, { key, name: key })),
    ),
  )
  let modules: ReadyClientModule[] = []
  let revision = 0
  const reconciler = createReconciler({
    ctx,
    locale,
    source: { list: async () => ({ revision: String(++revision), modules, statuses: [] }) },
    removeOwner: (owner) => registry.removeOwner(owner),
  })
  return {
    async publish(next: ReadyClientModule[]) {
      modules = next
      await reconciler.invalidate()
      return Object.fromEntries(reconciler.snapshot())
    },
  }
}

/** Host side of the HTML viewer: renders the component at the top of the page, over the shell. */
export async function mountHtmlViewer(props: ComponentProps<typeof import('@agnes/web-ui').HtmlViewer>) {
  // Loaded on first use, so the slot checks run without the component layer in the page.
  const { HtmlViewer } = await import('@agnes/web-ui')
  const mount = document.createElement('div')
  mount.id = 'viewer-host'
  Object.assign(mount.style, { position: 'fixed', inset: '0', zIndex: '1' })
  document.body.append(mount)
  createRoot(mount).render(createElement(HtmlViewer, props))
}
