import type { UiExtensionContext } from '@agnes/web-client'
import { Button, Icon } from '@agnes/web-ui'
import type { HomePageData } from './host.js'
import { HomePageFrame, HomePageSection } from './page-frame.js'

/** Plugins, skills and MCP servers; the management surface still lives in settings. */
export function PluginsPage({ context }: { context: UiExtensionContext }) {
  const data = context.data as HomePageData
  return (
    <HomePageFrame
      id="plugins"
      title={context.t('home.entry.plugins')}
      description={context.t('home.plugins.description')}
    >
      <HomePageSection>
        <div className="home-page-card home-page-row">
          <span className="home-page-row-tile" aria-hidden="true">
            <Icon name="plug" />
          </span>
          <span className="home-page-row-copy">
            <strong>{context.t('home.plugins.manage')}</strong>
            <span>{context.t('home.plugins.manageHelp')}</span>
          </span>
          <Button data-testid="home-plugins-manage" onClick={() => data.openSettings('plugins')}>
            {context.t('home.plugins.open')}
          </Button>
        </div>
      </HomePageSection>
    </HomePageFrame>
  )
}
