import {
  type LocaleService,
  type SessionService,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import type { AntdRoot } from '@agnes/web-ui'
import { Button, createRegionRenderer } from '@agnes/web-ui'
import { Prompts, Welcome, XProvider } from '@agnes/web-ui/x'
import { type ReactElement, useRef } from 'react'
import { EMPTY_STATE_DSH_CHILDREN, EMPTY_STATE_SLOT, type EmptyStateRegionMount } from './contracts.js'

const APP_BRAND = 'Agnes Harness'

export function EmptyStateBuiltin({ t = (key) => key }: { t?: (key: string) => string }): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  return (
    <div ref={host} data-agnes-region-owner={'builtin'} data-agnes-region-unit={'empty-state'}>
      <div className={'conversation-hero-dsh'} data-agnes-conversation-hero={true}>
        <SlotOutlet
          name={'conversation.hero.brand.mark'}
          props={{ owner: { surface: 'conversation.hero' } }}
          hideWhenEmpty={true}
        />
        <SlotOutlet
          name={'conversation.hero.workspace'}
          props={{ owner: { surface: 'conversation.hero' } }}
          hideWhenEmpty={true}
        />
        <SlotOutlet
          name={'conversation.hero.workspace.directoryFlow'}
          props={{ owner: { surface: 'conversation.hero.workspace' } }}
          hideWhenEmpty={true}
        />
        <SlotOutlet
          name={'conversation.hero.agentPreset'}
          props={{ owner: { surface: 'conversation.hero' } }}
          hideWhenEmpty={true}
        />
      </div>
      <XProvider>
        <Welcome
          variant={'borderless'}
          rootClassName={'empty-state-welcome'}
          title={
            // One lockup: the mark and the wordmark on a line. The wordmark is the page heading, and
            // the product's name is never translated.
            <span className={'empty-state-lockup'}>
              <span className={'agnes-mark empty-brand-mark'} aria-hidden={'true'} />
              <span id={'empty-state-title'} className={'empty-state-heading'} translate={'no'}>
                {APP_BRAND}
              </span>
            </span>
          }
          description={<span className={'empty-state-copy'}>{t('app.emptyState.tagline')}</span>}
        />
        <Prompts
          rootClassName={'empty-state-suggestions'}
          data-testid={'task-suggestions'}
          wrap={true}
          // Each prompt is a real button, so it has a name, focus and Enter; its click reaches the item.
          items={['project', 'issue', 'test'].map((suggestion) => ({
            key: suggestion,
            // The description slot renders a paragraph; the label slot would make each prompt a heading.
            description: (
              <Button appearance={'ghost'} size={'small'} htmlType={'button'}>
                {t(`composer.suggestion.${suggestion}`)}
              </Button>
            ),
          }))}
          onItemClick={({ data }) =>
            host.current?.dispatchEvent(
              new CustomEvent('agnes:compose-suggestion', {
                bubbles: true,
                detail: t(`composer.suggestion.${data.key}`),
              }),
            )
          }
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
  const translate = services.locale ? (key: string) => services.locale?.t(key) ?? key : undefined
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
