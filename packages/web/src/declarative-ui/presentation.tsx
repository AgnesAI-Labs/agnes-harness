import { Button, Icon, type IconName, icons, Menu, type MenuItem, type UiLocale } from '@agnes/web-ui'
import { StaticPluginMarkdown } from '@agnes/web-ui/conversation'
import { useLayoutEffect, useRef, useState } from 'react'
import { requestPluginUiConfiguration } from './configuration.js'
import type { PluginUiCard } from './entries.js'

const labels = {
  en: {
    extensions: 'Extensions',
    bottom: 'Bottom extensions',
    configure: 'Configure',
    back: 'Back',
    unavailable: 'Configuration is unavailable.',
  },
  'zh-CN': {
    extensions: '扩展',
    bottom: '底部扩展',
    configure: '配置',
    back: '返回',
    unavailable: '配置暂不可用。',
  },
}

export function pluginUiLocale(): UiLocale {
  return document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en'
}

export function pluginUiLabels() {
  return labels[pluginUiLocale()]
}

export function pluginUiIcon(name: string | undefined): IconName {
  return name && Object.hasOwn(icons, name) ? (name as IconName) : 'plug'
}

export function pluginUiMenuItems(
  entries: readonly PluginUiCard[],
  open: (entry: PluginUiCard) => void,
  group?: string,
): MenuItem[] {
  const locale = pluginUiLocale()
  return entries.map((entry, index) => {
    const label = entry.title[locale] ?? entry.title.en
    return {
      id: `declarative:${entry.key}`,
      testId: entry.testId,
      label,
      title: label,
      className: 'declarative-ui-menu-item',
      icon: <Icon name={pluginUiIcon(entry.icon)} />,
      ...(group ? { group, ...(index === 0 ? { dividerBefore: true } : {}) } : {}),
      onSelect: () => open(entry),
    }
  })
}

export function PluginUiMenu({
  label,
  items,
  sidebar = false,
}: {
  label: string
  items: readonly MenuItem[]
  sidebar?: boolean
}) {
  return (
    <Menu
      label={label}
      items={items}
      trigger={
        <Button
          appearance="ghost"
          size="small"
          htmlType="button"
          {...(sidebar ? { className: 'home-entry', 'data-testid': 'declarative-ui-sidebar-menu' } : {})}
          aria-label={label}
          icon={<Icon name="plug" />}
        >
          <span className={sidebar ? 'home-entry-label' : undefined}>{label}</span>
        </Button>
      }
    />
  )
}

export function PluginUiContent({ entry, onBack }: { entry: PluginUiCard; onBack(): void }) {
  const locale = pluginUiLocale()
  const t = labels[locale]
  const heading = useRef<HTMLHeadingElement>(null)
  const active = useRef(false)
  const [configure, setConfigure] = useState<'idle' | 'loading' | 'unavailable'>('idle')
  useLayoutEffect(() => {
    active.current = true
    // A session drawer may still be dismissing when the static page is committed.
    const frame = requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }))
    return () => {
      active.current = false
      cancelAnimationFrame(frame)
    }
  }, [])
  const markdownLocale = entry.markdown?.[locale] === undefined ? 'en' : locale
  return (
    <section className="declarative-ui-content" data-testid="declarative-ui-content">
      <Button appearance="ghost" htmlType="button" icon={<Icon name="chevron-left" />} onClick={onBack}>
        {t.back}
      </Button>
      <h2 tabIndex={-1} ref={heading}>
        {entry.title[locale] ?? entry.title.en}
      </h2>
      {entry.markdown && (
        <StaticPluginMarkdown
          source={entry.markdown[markdownLocale] ?? entry.markdown.en}
          locale={markdownLocale}
          inertLinks
        />
      )}
      {entry.configure && (
        <Button
          htmlType="button"
          loading={configure === 'loading'}
          onClick={async () => {
            setConfigure('loading')
            const opened = await requestPluginUiConfiguration(
              entry,
              () => active.current && Boolean(heading.current?.getClientRects().length),
            )
            if (active.current) setConfigure(opened ? 'idle' : 'unavailable')
          }}
        >
          {t.configure}
        </Button>
      )}
      {configure === 'unavailable' && <p role="status">{t.unavailable}</p>}
    </section>
  )
}

export function returnPluginUiFocus(
  trigger: HTMLElement | undefined,
  ...fallbacks: (HTMLElement | null)[]
): void {
  requestAnimationFrame(() => {
    const target = [trigger, ...fallbacks].find(
      (node) =>
        node?.isConnected &&
        node.getClientRects().length &&
        !node.closest('[hidden], [inert]') &&
        getComputedStyle(node).visibility !== 'hidden',
    )
    target?.focus({ preventScroll: true })
  })
}
