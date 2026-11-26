import type { ApplicationState, AppServerParams } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { requirePresentationReload } from '../app-notices.js'
import { projectApplication } from '../application.js'
import type { ClaimResolver } from '../client-modules/boot.js'
import { readyRosterModules } from '../client-modules/reconcile/roster.js'
import type { RosterSource } from '../client-modules/reconcile.js'

/** The workbench receives execution authority only from its selected backend's current roster. */
export function createBrowserClientRoster(
  client: {
    clientModules: Pick<Client['clientModules'], 'list'>
    request(
      method: '_agnes/v1/applications.get',
      params: AppServerParams<'_agnes/v1/applications.get'>,
    ): Promise<ApplicationState>
  },
  scope: () => { profile: string; sessionId: string | undefined; generation: number },
) {
  const listeners = new Set<() => void>()
  const extIds = new Map<string, string[]>()
  let online = false
  let connectionEpoch = 0
  const source: RosterSource = {
    identity() {
      const { profile, sessionId, generation } = scope()
      return JSON.stringify([profile, sessionId, generation, connectionEpoch])
    },
    reloadRequired: requirePresentationReload,
    commit(roster) {
      projectApplication(roster.application)
      extIds.clear()
      for (const mod of roster.modules) if (mod.rowId) extIds.set(mod.rowId, mod.extIds)
      for (const listener of listeners) listener()
    },
    async list() {
      const { profile, sessionId } = scope()
      if (!profile) return { revision: '', modules: [], statuses: [] }
      if (!online) throw new Error('Client module roster unavailable')
      const [roster, application] = await Promise.all([
        client.clientModules.list(profile, sessionId),
        client.request('_agnes/v1/applications.get', { profile }).catch(() => undefined),
      ])
      const modules = readyRosterModules(roster.rows ?? [], profile).filter(
        ({ documentAdmission }) =>
          documentAdmission.kind === 'release' ||
          documentAdmission.presentationRevision === application?.revision,
      )
      return {
        ...(application && modules.length ? { application } : {}),
        revision: roster.revision,
        modules,
        statuses: roster.statuses,
        ...(roster.rowAliases === undefined ? {} : { rowAliases: roster.rowAliases }),
      }
    },
  }
  const claim: ClaimResolver = (entry, extId) =>
    entry.owner !== undefined && (extIds.get(entry.owner)?.includes(extId) ?? false)
  return {
    source,
    claim,
    setOnline(value: boolean): boolean {
      if (value === online) return false
      online = value
      connectionEpoch++
      if (!online) for (const listener of listeners) listener()
      return true
    },
    presentation: {
      async listComponents(sessionId: string) {
        const { profile, generation } = scope()
        if (!profile || !online) return []
        const epoch = connectionEpoch
        const { rows } = await client.clientModules.list(profile, sessionId)
        const current = scope()
        if (profile !== current.profile || generation !== current.generation || epoch !== connectionEpoch)
          return []
        return (rows ?? []).filter((row) => row.binding?.profileId === profile)
      },
      subscribeComponents(listener: () => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
  }
}
