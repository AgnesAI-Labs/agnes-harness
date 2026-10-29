import {
  applicationBrand,
  applicationIdentity,
  type LocaleService,
  type SessionService,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import type { AntdRoot } from '@agnes/web-ui'
import { AnimatedTagline, createRegionRenderer } from '@agnes/web-ui'
import { Welcome, XProvider } from '@agnes/web-ui/x'
import { type ReactElement, useSyncExternalStore } from 'react'
import { EMPTY_STATE_DSH_CHILDREN, EMPTY_STATE_SLOT, type EmptyStateRegionMount } from './contracts.js'

type EmptyStateText = (key: string, vars?: Readonly<Record<string, string | number>>) => string

export function EmptyStateBuiltin({ t = (key) => key }: { t?: EmptyStateText }): ReactElement {
  const identity = useSyncExternalStore(applicationIdentity.subscribe, applicationIdentity.getSnapshot)
  const brand = applicationBrand(document.documentElement.lang)
  return (
    <div data-agnes-region-owner="builtin" data-agnes-region-unit="empty-state">
      <div className="conversation-hero-dsh" data-agnes-conversation-hero={true}>
        <SlotOutlet
          name="conversation.hero.workspace"
          props={{ owner: { surface: 'conversation.hero' } }}
          hideWhenEmpty={true}
        />
        <SlotOutlet
          name="conversation.hero.workspace.directoryFlow"
          props={{ owner: { surface: 'conversation.hero.workspace' } }}
          hideWhenEmpty={true}
        />
        <SlotOutlet
          name="conversation.hero.agentPreset"
          props={{ owner: { surface: 'conversation.hero' } }}
          hideWhenEmpty={true}
        />
      </div>
      <XProvider>
        <Welcome
          variant="borderless"
          rootClassName="empty-state-welcome"
          title={
            <span className="empty-state-lockup">
              <SlotOutlet
                name="conversation.hero.brand.mark"
                fallback={
                  identity?.assets.mark ? (
                    <img src={identity.assets.mark} alt="" className="empty-brand-mark" />
                  ) : (
                    <span className="agnes-mark empty-brand-mark" aria-hidden="true" />
                  )
                }
              />
              <span id="empty-state-title" className="empty-state-heading" translate="no">
                {brand.name}
              </span>
            </span>
          }
          description={<AnimatedTagline className="empty-state-copy" text={t('app.emptyState.tagline')} />}
        />
      </XProvider>
    </div>
  )
}
/**
 * Move the empty-state children behind the browser slot ledger.
 *
 * This operation is intentionally idempotent at the caller boundary: one root is created per
 * container and its registration is removed together with the root.  It is safe to call while the
 * section is hidden; the app keeps ownership of `hidden` and the region only owns its contents.
 */
export function mountEmptyStateRegion(
  registry: SlotRegistry,
  container: HTMLElement,
  services: {
    session?: SessionService
    locale?: LocaleService
  } = {},
): EmptyStateRegionMount {
  if (!registry.spec(EMPTY_STATE_SLOT))
    registry.declare(EMPTY_STATE_SLOT as string, { kind: 'single', scope: 'root' }, 'web-shell')
  // Priority 0 is the built-in. Third-party entries can explicitly shadow it with a lower value.
  const translate: EmptyStateText | undefined = services.locale
    ? (key, vars) => services.locale?.t(key, vars) ?? key
    : undefined
  const removeBuiltin = registry.register(
    {
      name: EMPTY_STATE_SLOT as string,
      id: 'builtin-empty-state',
      owner: '@agnes/web-empty-state',
      priority: 0,
      children: EMPTY_STATE_DSH_CHILDREN,
    },
    () => <EmptyStateBuiltin {...(translate ? { t: translate } : {})} />,
  )
  container.replaceChildren()
  const root: AntdRoot = createRegionRenderer(container)
  const providerProps = {
    registry,
    ...(services.session ? { session: services.session } : {}),
    ...(services.locale ? { locale: services.locale } : {}),
  }
  root.render(
    <SlotsProvider {...providerProps}>
      <SlotOutlet name={EMPTY_STATE_SLOT} />
    </SlotsProvider>,
  )
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      root.unmount()
      removeBuiltin()
    },
  }
}
