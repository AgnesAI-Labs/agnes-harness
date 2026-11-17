import type { AdminCredentialMetadata } from '@agnes/protocol/gen/app-server'
import { createDocumentLocaleSource, createRegionHost, mountRegion, UiLocaleProvider } from '@agnes/web-ui'
import { CredentialCreate } from './credential-create.js'
import { credentialsCatalog } from './credentials-locale.js'

const mcpDialog = () => document.getElementById('mcp-dialog')
export function mountMcpCredentialCreate(
  control: HTMLSelectElement,
  onCreated: (item: AdminCredentialMetadata) => void,
) {
  const field = control.closest('label')!
  const host = createRegionHost(field.parentElement!, 'div')
  field.after(host)
  const locale = createDocumentLocaleSource({ '@agnes/credentials': credentialsCatalog })
  const dispose = mountRegion(
    host,
    <UiLocaleProvider source={locale.source}>
      <CredentialCreate testId="mcp-credential-create" banner dismissOn={mcpDialog} onCreated={onCreated} />
    </UiLocaleProvider>,
  )
  return () => {
    dispose()
    locale.dispose()
    host.remove()
  }
}
