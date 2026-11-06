import type { ChannelManifest } from '@agnes/protocol'

/** Names are presentation only; provider and instance identities stay language independent. */
export function channelName(
  manifest: Pick<ChannelManifest, 'displayName' | 'displayNames' | 'id'>,
  zh: boolean,
) {
  return manifest.displayNames?.[zh ? 'zh-CN' : 'en'] || manifest.displayName || manifest.id
}
