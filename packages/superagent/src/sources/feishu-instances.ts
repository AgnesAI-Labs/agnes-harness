/**
 * The running AGH channel instances the Feishu Source can be set to, read as the Channels page reads them: the channel
 * catalog names each channel plugin (its row id and display name), and each plugin's `channel.configuration` and
 * `channel.check` services list its instances and whether the owner paired a direct chat or bound a session there.
 */
import type { Choice } from './kind.js'

/** An owner-level local call of the daemon, as the bundled app's SDK client makes it. */
export type OwnerCall = <T>(method: string, params: unknown) => Promise<T>

type Provider = { extension?: unknown; rowId?: unknown; manifest?: { displayName?: unknown; id?: unknown } }
type Configured = { output?: { instances?: { id?: unknown }[] } }
type Checked = { output?: { instances?: { id?: unknown; pairings?: unknown[]; bindings?: unknown[] }[] } }

/** Why an instance the owner uses cannot be claimed whole. */
export const OWNER_BUSY = {
  zh: '主人在用（已配对私聊或绑定会话），不能整个认领',
  en: "The owner's (a paired direct chat or a bound session); cannot be claimed whole",
}
const MAX_PROVIDERS = 32

/**
 * Lists every instance of every channel plugin as `<row id>/<instance id>`, labelled with the plugin's display name and
 * the instance id. An instance with an owner pairing or a bound session is marked busy. A plugin whose services refuse
 * is left out; a refused catalog throws, so the caller keeps the choices it has.
 */
export async function listInstances(call: OwnerCall): Promise<Choice[]> {
  const { providers } = await call<{ providers: Provider[] }>('_agnes/v1/channels.catalog', {})
  const scoped = <T>(extension: string, service: string) =>
    call<T>('_agnes/v1/extension.callScoped', { extension, service: `channel.${service}`, input: {} })
  const rows = await Promise.all(
    (Array.isArray(providers) ? providers : []).slice(0, MAX_PROVIDERS).map(async (provider) => {
      const { extension, rowId } = provider
      if (typeof extension !== 'string' || typeof rowId !== 'string') return []
      const name = provider.manifest?.displayName
      const plugin = typeof name === 'string' && name ? name : rowId
      try {
        const [configured, checked] = await Promise.all([
          scoped<Configured>(extension, 'configuration'),
          scoped<Checked>(extension, 'check').catch(() => undefined),
        ])
        return (configured.output?.instances ?? []).flatMap((instance): Choice[] => {
          if (typeof instance.id !== 'string') return []
          const health = checked?.output?.instances?.find((row) => row.id === instance.id)
          const used = (health?.pairings?.length ?? 0) > 0 || (health?.bindings?.length ?? 0) > 0
          return [
            {
              value: `${rowId}/${instance.id}`,
              label: `${plugin} · ${instance.id}`,
              ...(used ? { busy: OWNER_BUSY } : {}),
            },
          ]
        })
      } catch {
        return []
      }
    }),
  )
  return rows.flat().sort((a, b) => a.label.localeCompare(b.label))
}
