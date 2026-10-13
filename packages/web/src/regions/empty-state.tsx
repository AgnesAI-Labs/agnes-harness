import { resolvePluginMetadata } from '@agnes/protocol'
import {
  homeNavigation,
  type LocaleService,
  type SessionService,
  SlotOutlet,
  type SlotRegistry,
  SlotsProvider,
} from '@agnes/web-client'
import type { AntdRoot } from '@agnes/web-ui'
import { Button, createRegionRenderer, useDocumentLanguage } from '@agnes/web-ui'
import { Prompts, Welcome, XProvider } from '@agnes/web-ui/x'
import { type ReactElement, useEffect, useRef, useSyncExternalStore } from 'react'
import { businessAgentSuggestions } from '../pages/business-agents.js'
import { EMPTY_STATE_DSH_CHILDREN, EMPTY_STATE_SLOT, type EmptyStateRegionMount } from './contracts.js'

const APP_BRAND = 'Agnes Harness'

type EmptyStateText = (key: string, vars?: Readonly<Record<string, string | number>>) => string

/** Up to three business agents to start from; a click runs one-click start for that agent on its page. */
function BusinessAgentSuggestions({
  t,
  source,
}: {
  t: EmptyStateText
  source: typeof businessAgentSuggestions
}): ReactElement | null {
  const { featured, total } = useSyncExternalStore(source.subscribe, source.getSnapshot)
  const locale = useDocumentLanguage() === 'zh-CN' ? 'zh-CN' : 'en'
  if (!featured.length) return null
  return (
    <div className={'empty-state-agents'} data-testid={'agent-suggestions'}>
      <div className={'empty-state-agent-grid'}>
        {featured.map((row, index) => {
          const purpose = resolvePluginMetadata(row.metadata, locale)
          const name = purpose?.displayName ?? row.id.split('/').at(-1) ?? row.id
          const line = purpose?.samplePrompt ?? purpose?.summary
          return (
            <Button
              key={row.id}
              appearance={'ghost'}
              htmlType={'button'}
              className={'empty-state-agent'}
              data-testid={'agent-suggestion'}
              data-package={row.id}
              onClick={() => homeNavigation.open('agents', { focus: row.id, start: true })}
            >
              <span className={'empty-state-agent-heading'}>
                <span className={'empty-state-agent-tile'} data-tone={index % 3} aria-hidden={'true'}>
                  {Array.from(name.trim())[0]?.toLocaleUpperCase()}
                </span>
                <span className={'empty-state-agent-name'}>{name}</span>
              </span>
              {line && <span className={'empty-state-agent-line'}>{line}</span>}
            </Button>
          )
        })}
      </div>
      <p className={'empty-state-agents-note'}>
        {t('home.suggestions.note')}{' '}
        <Button
          appearance={'ghost'}
          size={'small'}
          htmlType={'button'}
          className={'empty-state-agents-all'}
          data-testid={'agent-suggestions-all'}
          onClick={() => homeNavigation.open('agents')}
        >
          {t('home.suggestions.all', { count: total })}
        </Button>
      </p>
    </div>
  )
}

export function EmptyStateBuiltin({
  t = (key) => key,
  suggestions = businessAgentSuggestions,
}: {
  t?: EmptyStateText
  /** The business agents to suggest; the page's catalog unless a host supplies its own. */
  suggestions?: typeof businessAgentSuggestions
}): ReactElement {
  const host = useRef<HTMLDivElement>(null)
  const agents = useSyncExternalStore(suggestions.subscribe, suggestions.getSnapshot)
  useEffect(() => {
    void suggestions.refresh()
  }, [suggestions])
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
        <BusinessAgentSuggestions t={t} source={suggestions} />
        {/* Without a catalog of business agents the plain task suggestions stay. */}
        {agents.featured.length === 0 && (
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
        )}
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
