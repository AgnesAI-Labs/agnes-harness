import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ownsRow } from '@agnes/daemon-foundation/composite-desired'
import type { CompositeTargetStore } from '@agnes/daemon-foundation/storage/composite-target-store'
import { compilePluginConfig, DEFAULT_PLUGIN_CONFIG_RELOAD, redactPluginConfig } from '@agnes/extension-api'
import { type PackageManager, parseAgnesPluginEntries } from '@agnes/package-manager'
import {
  buildRuntimeTarget,
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
  type RuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import {
  type JsonValue,
  jcs,
  type PluginConfigEntry,
  type PluginConfigGetParams,
  type PluginConfigSaveParams,
  type PluginConfigSaveResult,
  type PluginConfigSnapshot,
  type PluginConfigValidateParams,
} from '@agnes/protocol'
import type { PackageAdminAuthority } from './permissions.js'
import type { PackageProfileDirectory } from './project.js'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Plugin failures are untrusted text. Never echo configuration values or secret references. */
function refusalReason(error: Error, values: readonly unknown[]): string {
  let message = error.message.split('\n')[0] ?? ''
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(strings)
        : []
  for (const value of values
    .flatMap(strings)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    message = message.split(value).join('[redacted]')
  return (
    message
      .replace(/secret:\/\/[^\s"'<>]+/gi, '[redacted]')
      .replace(/(?:Bearer\s+\S+|(?:password|token|credential|api[_-]?key)\s*[:=]\s*\S+)/gi, '[redacted]')
      .replace(/(?:\/[^\s]+|[A-Za-z]:\\[^\s]+)/g, '[redacted]')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove C0/DEL from untrusted plugin refusal text.
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .slice(0, 512)
  )
}

/** Runtime generation publication owns hot apply; this controller owns validation, CAS and facts. */
export class PluginConfiguration {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly options: {
      manager: PackageManager
      profileDirectory: PackageProfileDirectory
      store(): CompositeTargetStore | undefined
      publish(artifact: RuntimeTargetArtifact, liveConfig?: boolean): Promise<void>
      clock(): string
      acknowledgementTimeoutMs?: number
    },
  ) {}

  async get(input: PluginConfigGetParams): Promise<PluginConfigSnapshot> {
    const directory = await this.options.profileDirectory(input.profile)
    const inventory = await this.options.manager.inventory(directory)
    const pkg = inventory.packages.find((pkg) => pkg.id === input.id)
    if (!pkg?.directory) throw new Error('E_PACKAGE_STATE')
    const manifest = JSON.parse(await readFile(join(pkg.directory, 'package.json'), 'utf8')) as {
      agnes?: { plugins?: unknown }
    }
    const entries = parseAgnesPluginEntries(pkg.id, manifest.agnes?.plugins)
    const store = this.options.store()
    const artifact = store?.desired()
    if (!artifact || !store) throw new Error('E_PACKAGE_STATE')
    const target = decodeRuntimeTargetArtifact(artifact)
    const rows = [
      ...target.tree.rows,
      ...Object.values(target.resource.rows).flatMap((row) => (row ? [row] : [])),
    ]
    return {
      revision: artifact.digest,
      entries: entries.map((entry): PluginConfigEntry => {
        const row = rows.find((row) => row.id === entry.id && ownsRow(row.plugin, pkg.id))
        const saved = store.configAudit.value(pkg.id, entry.id)
        const value = row?.config !== undefined ? row.config : saved !== undefined ? saved : entry.config
        return {
          rowId: entry.id,
          schema: (entry.configSchema ?? true) as JsonValue,
          value: (value === undefined ? {} : value) as JsonValue,
          reload: entry.configReload ?? DEFAULT_PLUGIN_CONFIG_RELOAD,
        }
      }),
      audit: store.configAudit.facts(entries.map((entry) => entry.id)),
    }
  }

  async validate(input: PluginConfigValidateParams) {
    const snapshot = await this.get(input)
    const entry = snapshot.entries.find((entry) => entry.rowId === input.rowId)
    if (!entry) throw new Error('E_PACKAGE_STATE')
    return { issues: compilePluginConfig(entry.schema as boolean | Record<string, unknown>)(input.value) }
  }

  save(input: PluginConfigSaveParams, authority: PackageAdminAuthority): Promise<PluginConfigSaveResult> {
    const owned = structuredClone(input)
    const task = this.tail.then(() => this.saveNow(owned, authority))
    this.tail = task.catch(() => undefined)
    // A timed-out response does not cancel or release the serialized publication. Its late receipt
    // must still decide whether the staged audit and value can commit before another save starts.
    let timer: ReturnType<typeof setTimeout> | undefined
    const pending = new Promise<PluginConfigSaveResult>((resolve, reject) => {
      timer = setTimeout(() => {
        void this.get(owned).then((snapshot) => {
          const reload =
            snapshot.entries.find((entry) => entry.rowId === owned.rowId)?.reload ??
            DEFAULT_PLUGIN_CONFIG_RELOAD
          // Next-session does not apply to existing workers and keeps its original save contract.
          if (reload !== 'live') {
            resolve(task)
            return
          }
          resolve({
            ok: false,
            reason: 'pending',
            revision: snapshot.revision,
            reload,
            issues: [],
          })
        }, reject)
      }, this.options.acknowledgementTimeoutMs ?? 10_000)
    })
    return Promise.race([task, pending]).finally(() => clearTimeout(timer))
  }

  private async saveNow(
    input: PluginConfigSaveParams,
    authority: PackageAdminAuthority,
  ): Promise<PluginConfigSaveResult> {
    const snapshot = await this.get(input)
    const entry = snapshot.entries.find((entry) => entry.rowId === input.rowId)
    if (!entry) throw new Error('E_PACKAGE_STATE')
    const result = (
      reason: PluginConfigSaveResult['reason'],
      issues: PluginConfigSaveResult['issues'] = [],
    ): PluginConfigSaveResult => ({
      ok: reason === 'saved',
      revision: this.options.store()?.desired()?.digest ?? snapshot.revision,
      reload: entry.reload,
      reason,
      issues,
    })
    if (snapshot.revision !== input.expectedRevision) return result('conflict')
    const issues = compilePluginConfig(entry.schema as boolean | Record<string, unknown>)(input.value)
    if (issues.length) return result('invalid', [...issues])
    const store = this.options.store()
    const prior = store?.desired()
    if (!store || !prior || prior.digest !== input.expectedRevision) return result('conflict')
    const target = decodeRuntimeTargetArtifact(prior)
    const resourceRows = Object.values(target.resource.rows).flatMap((row) => (row ? [row] : []))
    const allRows = [...target.tree.rows, ...resourceRows]
    const currentRow = allRows.find((row) => row.id === entry.rowId)
    if (currentRow && !ownsRow(currentRow.plugin, input.id)) return result('refused')
    if (jcs(entry.value) === jcs(input.value)) return result('saved')
    const rows = allRows.map((row) =>
      row.id === entry.rowId ? { ...row, config: input.value, configReload: entry.reload } : row,
    )
    const next = encodeRuntimeTargetArtifact(
      buildRuntimeTarget({
        rows,
        resources: target.resource.resources,
        resourceRevision: resourceRows.some((row) => row.id === entry.rowId)
          ? digest({ previous: target.resource.target.resourceRevision, rows })
          : target.resource.target.resourceRevision,
        compositeRevision: digest({
          previous: prior.digest,
          tree: rows,
          resource: target.resource.target.resourceRevision,
          configuration: { packageId: input.id, rowId: entry.rowId, value: input.value },
        }),
      }),
    )
    if (next.digest === prior.digest) return result('saved')
    store.configAudit.stage(
      prior.digest,
      next.digest,
      `${authority.clientId}:${input.commandId}`,
      {
        who: authority.principalId,
        when: this.options.clock(),
        rowId: entry.rowId,
        revision: next.digest,
        before: redactPluginConfig(entry.value) as JsonValue,
        after: redactPluginConfig(input.value) as JsonValue,
      },
      { packageId: input.id, rowId: entry.rowId, value: input.value },
    )
    try {
      await this.options.publish(
        next,
        entry.reload === 'live' && currentRow !== undefined && !currentRow.disabled,
      )
      if (store.desired()?.digest !== next.digest) return result('refused')
      return result('saved')
    } catch (error) {
      if (store.desired()?.digest !== prior.digest) return result('conflict')
      if (error instanceof Error && error.name === 'PluginConfigRefused')
        return { ...result('refused'), refusalReason: refusalReason(error, [entry.value, input.value]) }
      return result(
        error instanceof Error && error.message === 'E_RUNTIME_TARGET_OUTCOME_UNKNOWN'
          ? 'pending'
          : 'refused',
      )
    } finally {
      store.configAudit.clear()
    }
  }
}
