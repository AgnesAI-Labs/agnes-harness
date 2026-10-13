import type { PackageInstalledDescriptor } from '@agnes/protocol'
import { OfficialExampleCards } from '@agnes/web-admin/settings/examples'
import { SETTINGS_NAMESPACE, settingsCatalog } from '@agnes/web-admin/settings/locales'
import type { UiExtensionContext } from '@agnes/web-client'
import { useUiText } from '@agnes/web-ui'
import { useEffect, useState } from 'react'
import { canEffect, useHomeAdmin } from './admin-api.js'
import type { HomePageData } from './host.js'
import { HomePageFrame } from './page-frame.js'

/** The business agent (FDE) gallery. */
export function AgentsPage({ context }: { context: UiExtensionContext }) {
  const data = context.data as HomePageData
  const { t } = useUiText(SETTINGS_NAMESPACE, settingsCatalog)
  const admin = useHomeAdmin()
  const [installed, setInstalled] = useState<readonly PackageInstalledDescriptor[]>([])
  useEffect(() => {
    let current = true
    void admin?.api.list().then(
      (result) => {
        if (current) setInstalled(result.packages)
      },
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [admin])
  return (
    <HomePageFrame
      id="agents"
      title={context.t('home.entry.agents')}
      description={context.t('home.agents.description')}
    >
      <OfficialExampleCards
        api={admin?.api}
        canInstall={canEffect(admin, 'packages.install')}
        installed={installed}
        t={t}
        onReview={() => data.openSettings('discover')}
      />
    </HomePageFrame>
  )
}
