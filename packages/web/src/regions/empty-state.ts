import {
  type LocaleService,
  type SessionService,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import type { AntdRoot } from '@agnes/web-ui'
import { createAntdRoot } from '@agnes/web-ui'
import { createElement } from 'react'
import { EMPTY_STATE_DSH_CHILDREN, EMPTY_STATE_SLOT, type EmptyStateRegionMount } from './contracts.js'

export function EmptyStateBuiltin({
  t = (key) => key,
}: {
  t?: (key: string) => string
}): ReturnType<typeof createElement> {
  return createElement(
    'div',
    { 'data-agnes-region-owner': 'builtin', 'data-agnes-region-unit': 'empty-state' },
    createElement(
      'div',
      { className: 'conversation-hero-dsh', 'data-agnes-conversation-hero': true },
      createElement(SlotOutlet, {
        name: 'conversation.hero.brand.mark',
        props: { owner: { surface: 'conversation.hero' } },
        hideWhenEmpty: true,
      }),
      createElement(SlotOutlet, {
        name: 'conversation.hero.workspace',
        props: { owner: { surface: 'conversation.hero' } },
        hideWhenEmpty: true,
      }),
      createElement(SlotOutlet, {
        name: 'conversation.hero.workspace.directoryFlow',
        props: { owner: { surface: 'conversation.hero.workspace' } },
        hideWhenEmpty: true,
      }),
      createElement(SlotOutlet, {
        name: 'conversation.hero.agentPreset',
        props: { owner: { surface: 'conversation.hero' } },
        hideWhenEmpty: true,
      }),
    ),
    createElement('span', { className: 'agnes-mark empty-brand-mark', 'aria-hidden': 'true' }),
    createElement('h2', { id: 'empty-state-title', className: 'empty-state-heading' }, 'Agnes Harness'),
    createElement('p', { className: 'empty-state-copy' }, t('app.emptyState.tagline')),
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
  services: { session?: SessionService; locale?: LocaleService } = {},
): EmptyStateRegionMount {
  if (!registry.spec(EMPTY_STATE_SLOT))
    registry.declare(EMPTY_STATE_SLOT as string, { kind: 'single', scope: 'root' }, 'web-shell')
  // Priority 0 is the built-in. Third-party entries can explicitly shadow it with a lower value.
  const translate = services.locale ? (key: string) => services.locale?.t(key) ?? key : undefined
  const removeBuiltin = registry.register(
    {
      name: EMPTY_STATE_SLOT as string,
      id: 'builtin-empty-state',
      owner: '@agnes/web-empty-state',
      priority: 0,
      children: EMPTY_STATE_DSH_CHILDREN,
    },
    () => createElement(EmptyStateBuiltin, translate ? { t: translate } : {}),
  )
  container.replaceChildren()
  const root: AntdRoot = createAntdRoot(container)
  const providerProps = {
    registry,
    ...(services.session ? { session: services.session } : {}),
    ...(services.locale ? { locale: services.locale } : {}),
  }
  root.render(
    createElement(SlotsProvider, providerProps, createElement(SlotOutlet, { name: EMPTY_STATE_SLOT })),
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
