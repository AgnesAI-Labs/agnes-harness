import type { NodeClient } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import type { ParsedArgs } from '../types.js'
import { oneLine } from './sessions-manage.js'

type IO = { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }
type Meta = {
  id: string
  label: string
  kind: string
  createdAt: string
  references: Array<{ kind: string; profile: string; configId: string }>
}

/**
 * Metadata only. Rebuilt field by field, never spread, so a value or secret the daemon should never
 * send (but might) cannot reach stdout, text or --json.
 */
const metadata = (m: Meta): Meta => ({
  id: m.id,
  label: m.label,
  kind: m.kind,
  createdAt: m.createdAt,
  references: (m.references ?? []).map((r) => ({ kind: r.kind, profile: r.profile, configId: r.configId })),
})

const line = (m: Meta): string =>
  [
    oneLine(m.id),
    oneLine(m.label),
    oneLine(m.kind),
    oneLine(m.createdAt),
    m.references.length
      ? `used by ${m.references.map((r) => `${oneLine(r.kind)}:${oneLine(r.configId)}`).join(',')}`
      : 'unused',
  ].join('\t')

/**
 * `agh credentials list | rename <id> <name> | delete <id> [--yes]`: generic API-key credentials through
 * the admin-tier admin.credentials.* RPCs. Creating or changing a value is `agh config`'s wizard, not a
 * command-line argument, so no secret enters shell history. Daemon refusals propagate as they come.
 */
export async function credentialsCommand(p: ParsedArgs, client: NodeClient, io: IO): Promise<number> {
  const [action = 'list', id, ...rest] = p.positional
  const out = (value: unknown, text: string) => io.stdout.write(p.json ? `${JSON.stringify(value)}\n` : text)
  const list = async (): Promise<Meta[]> => (await client.credentials.list()).items.map(metadata)

  if (action === 'list') {
    if (id !== undefined) throw new UsageError('credentials list takes no arguments')
    const items = await list()
    out({ items }, items.length ? `${items.map(line).join('\n')}\n` : 'no credentials\n')
    return ExitCode.OK
  }
  if (action === 'rename') {
    const label = rest.join(' ')
    if (!id || !label) throw new UsageError('credentials rename expects <id> <name...>')
    const renamed = metadata(await client.credentials.rename({ id, label }))
    out(renamed, `renamed ${line(renamed)}\n`)
    return ExitCode.OK
  }
  if (action === 'delete') {
    if (!id || rest.length) throw new UsageError('credentials delete expects <id> [--yes [--force]]')
    if (p.force && !p.yes) throw new UsageError('--force needs --yes')
    if (!p.yes) {
      const found = (await list()).find((m) => m.id === id)
      if (!found) {
        io.stderr.write(`refused: no credential ${oneLine(id)}\n`)
        return ExitCode.ERROR
      }
      out(
        { wouldDelete: found },
        `would delete ${line(found)}\nnothing was deleted; add --yes to delete${found.references.length ? ' (still referenced: also needs --force)' : ''}\n`,
      )
      return ExitCode.OK
    }
    await client.credentials.delete(p.force ? { id, force: true, confirm: true } : { id })
    out({ deleted: id }, `deleted ${oneLine(id)}\n`)
    return ExitCode.OK
  }
  throw new UsageError('credentials expects list, rename <id> <name...> or delete <id> [--yes]')
}
