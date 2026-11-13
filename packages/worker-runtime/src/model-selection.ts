import type { Host, HostSession } from '@agnes/host'

/** A running worker may predate a newly published provider-owned model. Refresh, then validate. */
export async function selectSessionModel(
  host: Host,
  session: HostSession,
  selection: Parameters<HostSession['setModel']>[0],
) {
  if (
    host.provider &&
    !host.provider.models().some((model) => model.route === selection.route && model.id === selection.model)
  )
    await host.applyModelProfile(host.profile)
  host.validateModelSwitch(selection, session.key)
  return { effectiveFromSeq: await session.setModel(selection) }
}
