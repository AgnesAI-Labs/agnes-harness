import type { PluginTreeArtifact, PluginTreeView } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import { newPackageCommandId } from '../tui/package-admin.js'
import type { ParsedArgs } from '../types.js'
import { oneLine } from './sessions-manage.js'
import { readJson } from './triggers.js'

const yn = (b: boolean | undefined): string => (b ? 'yes' : 'no')

function treeLines(v: PluginTreeView): string[] {
  return [
    `actual ${yn(v.actual)}\tpending ${yn(v.pending)}\tdesired ${oneLine(v.desiredDigest ?? 'none')}`,
    ...(v.workerGeneration !== undefined ? [`worker generation ${v.workerGeneration}`] : []),
    ...(v.reportOk !== undefined
      ? [`report ${v.reportOk ? 'ok' : `failed${v.failurePhase ? ` at ${oneLine(v.failurePhase)}` : ''}`}`]
      : []),
    ...(v.identity
      ? [
          `tree ${oneLine(v.identity.treeHash)}\tresources ${oneLine(v.identity.resourceRevision)}\tcomposite ${oneLine(v.identity.compositeRevision)}`,
        ]
      : []),
  ]
}

/** An artifact as `tree show --json` prints it, or the whole view whose `desired` holds it. */
function artifactFrom(source: string): PluginTreeArtifact {
  const raw = readJson(source, 'the artifact')
  const candidate = (raw as { desired?: unknown } | null)?.desired ?? raw
  const a = candidate as Partial<PluginTreeArtifact> | null
  if (
    !a ||
    typeof a !== 'object' ||
    a.encoding !== 'base64' ||
    typeof a.canonicalBase64 !== 'string' ||
    typeof a.digest !== 'string' ||
    typeof a.identity !== 'object' ||
    a.identity === null
  )
    throw new UsageError('the artifact must be a plugin tree artifact (agh plugins tree show --json)')
  return a as PluginTreeArtifact
}

/** `agh plugins tree [list]|show|apply|rollback` and `agh plugins generations`. */
export async function pluginTreeCommand(
  p: ParsedArgs,
  client: NodeClient,
  write: (t: string) => void,
): Promise<number> {
  const [head, action, ...extra] = p.positional
  const profile = p.profile ?? 'local-dev'
  const out = (value: unknown, text: string) => write(p.json ? `${JSON.stringify(value)}\n` : text)
  if (head === 'generations') {
    if (action !== undefined) throw new UsageError('usage: agh plugins generations [--json]')
    const g = await client.packages.generations({ profile })
    const lines = [`current ${oneLine(g.currentGenerationId ?? 'none')}`]
    for (const x of g.generations)
      lines.push(
        `${oneLine(x.id)}\t${x.state}\tsessions ${x.openSessions}/${x.boundSessions}\t${x.live ? 'live' : 'not live'}\t${x.packages.map((k) => oneLine(`${k.id}@${k.version}`)).join(',')}${x.error ? `\terror ${oneLine(x.error)}` : ''}`,
      )
    for (const x of g.plugins)
      lines.push(
        `plugin ${oneLine(x.id)}\t${x.state}\tbound ${x.boundSessions}\tdraining ${x.drainingSessions}${x.error ? `\terror ${oneLine(x.error)}` : ''}`,
      )
    for (const b of g.blocked ?? []) lines.push(`blocked ${oneLine(b.file)}\t${oneLine(b.reason)}`)
    out(g, `${lines.join('\n')}\n`)
    return ExitCode.OK
  }
  const verb = action ?? 'list'
  const usage =
    'usage: agh plugins tree [list] | show | apply --file <artifact|-> [--yes] | rollback [--yes] [--json]'
  if (extra.length || !['list', 'show', 'apply', 'rollback'].includes(verb)) throw new UsageError(usage)
  if (verb === 'list' || verb === 'show') {
    const v = await (verb === 'list' ? client.packages.tree.list : client.packages.tree.get)({ profile })
    out(v, `${treeLines(v).join('\n')}\n`)
    return ExitCode.OK
  }
  const base = async () => ({
    profile,
    clientId: await client.clientId(),
    commandId: newPackageCommandId(`tree-${verb}`),
  })
  if (verb === 'apply') {
    if (!p.file) throw new UsageError('tree apply needs --file <artifact|->')
    const artifact = artifactFrom(p.file)
    if (!p.yes) {
      out(
        { wouldApply: artifact.digest, applied: false },
        `Would apply plugin tree ${oneLine(artifact.digest)} (tree ${oneLine(artifact.identity.treeHash)}, composite ${oneLine(artifact.identity.compositeRevision)}). Nothing was sent; add --yes to apply.\n`,
      )
      return ExitCode.OK
    }
    const r = await client.packages.tree.apply({ ...(await base()), artifact })
    out(r, `applied ${oneLine(r.desiredDigest)}\t${r.pending ? 'pending' : 'converged'}\n`)
    return ExitCode.OK
  }
  if (!p.yes) {
    out(
      { wouldRollback: true, applied: false },
      'Would roll the desired plugin tree back to its previous version. Nothing was sent; add --yes to roll back.\n',
    )
    return ExitCode.OK
  }
  const r = await client.packages.tree.rollback(await base())
  out(r, r.rolledBack ? `rolled back to ${oneLine(r.desiredDigest ?? 'none')}\n` : 'nothing to roll back\n')
  return r.rolledBack ? ExitCode.OK : ExitCode.ERROR
}
