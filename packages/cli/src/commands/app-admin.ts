import type { ApplicationPreview, ApplicationState } from '@agnes/protocol'
import type { NodeClient } from '@agnes/sdk'
import { ExitCode, UsageError } from '../errors.js'
import { newPackageCommandId } from '../tui/package-admin.js'
import type { ParsedArgs } from '../types.js'
import { oneLine } from './sessions-manage.js'

const USAGE = 'usage: agh app show | preview <package#app> | adopt <package#app> [--yes] | clear [--json]'

function stateLines(s: ApplicationState): string[] {
  const sel = s.selection
  return [
    `${s.status}\trevision ${s.revision}${s.reason ? `\t${oneLine(s.reason)}` : ''}`,
    sel
      ? `selected ${oneLine(`${sel.packageId}#${sel.applicationId}`)}`
      : 'no application selected (Host default)',
    ...(s.effective ? [`effective ${oneLine(s.effective.id)}`] : []),
    ...s.candidates.map(
      (c) =>
        `candidate ${oneLine(`${c.packageId}#${c.applicationId}`)}\t${oneLine(c.version)}\t${c.available ? 'available' : 'unavailable'}`,
    ),
  ]
}

function previewLines(v: ApplicationPreview): string[] {
  return [
    `${oneLine(`${v.packageId}@${v.version}`)}\tapplication ${oneLine(v.declaration.id)}`,
    `integrity ${oneLine(v.integrity)}\tconsent ${oneLine(v.consentDigest)}`,
    `scope ${oneLine(v.scope)}`,
    `dependencies ${oneLine(JSON.stringify(v.dependencies))}`,
    `replaced roles ${oneLine(JSON.stringify(v.replacedRoles))}`,
    `recovery ${oneLine(v.recovery)}`,
    `warning ${oneLine(v.warning)}`,
  ]
}

/** Split `<package>` or `<package#app>`; the protocol takes the package, the app part is checked against the preview. */
function target(arg: string | undefined): { packageId: string; applicationId?: string } {
  if (!arg) throw new UsageError(USAGE)
  const [packageId, applicationId, ...rest] = arg.split('#')
  if (!packageId || rest.length || applicationId === '') throw new UsageError(USAGE)
  return { packageId, ...(applicationId ? { applicationId } : {}) }
}

/** `agh app show|preview|adopt`; `app clear` stays on the recovery path that needs no plugins. */
export async function appAdminCommand(
  p: ParsedArgs,
  client: NodeClient,
  write: (t: string) => void,
): Promise<number> {
  const args = [...p.rest]
  let json = p.json ?? false
  let yes = p.yes ?? false
  let profile = p.profile ?? 'local-dev'
  const positional: string[] = []
  while (args.length) {
    const a = args.shift() as string
    if (a === '--json') json = true
    else if (a === '--yes') yes = true
    else if (a === '--profile' && args[0]) profile = args.shift() as string
    else if (a.startsWith('--')) throw new UsageError(USAGE)
    else positional.push(a)
  }
  const [action, arg, ...extra] = positional
  const out = (value: unknown, text: string) => write(json ? `${JSON.stringify(value)}\n` : text)
  if (action === 'show' && arg === undefined) {
    const state = await client.call<ApplicationState>('_agnes/v1/applications.get', { profile })
    out(state, `${stateLines(state).join('\n')}\n`)
    return ExitCode.OK
  }
  if ((action !== 'preview' && action !== 'adopt') || extra.length) throw new UsageError(USAGE)
  const { packageId, applicationId } = target(arg)
  const preview = await client.call<ApplicationPreview>('_agnes/v1/applications.preview', {
    profile,
    packageId,
  })
  if (applicationId !== undefined && applicationId !== preview.declaration.id)
    throw new UsageError(
      `package ${oneLine(packageId)} declares application ${oneLine(preview.declaration.id)}, not ${oneLine(applicationId)}`,
    )
  if (action === 'preview') {
    out(preview, `${previewLines(preview).join('\n')}\n`)
    return ExitCode.OK
  }
  if (!yes) {
    out(
      { wouldAdopt: preview, adopted: false },
      `${previewLines(preview).join('\n')}\nWould adopt ${oneLine(`${packageId}#${preview.declaration.id}`)}. Nothing was sent; add --yes to adopt.\n`,
    )
    return ExitCode.OK
  }
  const current = await client.call<ApplicationState>('_agnes/v1/applications.get', { profile })
  const state = await client.call<ApplicationState>('_agnes/v1/applications.adopt', {
    profile,
    packageId,
    expectedRevision: current.revision,
    consentDigest: preview.consentDigest,
    clientId: await client.clientId(),
    commandId: newPackageCommandId('app-adopt'),
  })
  out(
    state,
    `adopted ${oneLine(`${packageId}#${preview.declaration.id}`)}\n${stateLines(state).join('\n')}\n`,
  )
  return ExitCode.OK
}
