import type { WorkspaceListResult } from '@agnes/protocol'
import { CredentialsApi } from '@agnes/resource-control-web/credentials-api'
import { type RefinementSettingsApi, RefinementSettingsPanel } from '@agnes/web-admin/settings/refinement'
import type { UiExtensionContext } from '@agnes/web-client'
import { useMemo } from 'react'
import type { HomePageData } from './host.js'
import { HomePageFrame } from './page-frame.js'

export function RsiPage({ context }: { context: UiExtensionContext }) {
  const data = context.data as HomePageData
  const api = useMemo<RefinementSettingsApi>(
    () => ({
      read: () => data.call('_agnes/v1/refinement.get', {}),
      models: () => data.call('_agnes/v1/refinement.models', {}),
      // Credential writes go through the Web admin endpoint, which refuses to delete a key in use.
      createKey: async (label, value) => (await new CredentialsApi().create(label, value)).id,
      deleteKey: (id) => new CredentialsApi().delete({ id }),
      save: (settings, expectedRevision) =>
        data.call('_agnes/v1/refinement.save', { settings, expectedRevision }),
      savedSkills: {
        workspaces: async () => (await data.call<WorkspaceListResult>('_agnes/v1/workspace.list', {})).items,
        skills: (input) => data.call('_agnes/v1/refinement.skills', input),
      },
    }),
    [data],
  )
  return (
    <HomePageFrame
      id="rsi"
      title={context.t('home.entry.rsi')}
      description={context.t('home.rsi.description')}
    >
      <RefinementSettingsPanel api={api} />
    </HomePageFrame>
  )
}
