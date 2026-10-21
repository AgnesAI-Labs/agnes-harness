import { HostError } from '@agnes/host-common/errors'
import type { ExtensionStatus } from '@agnes/host-extensions/ext-host/index'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import { skillRowRevision, withSkillRows } from '@agnes/host-providers/assemble/skill-row'
import type { EntryRow } from '@agnes/plugin-runtime/host'
import type { BootRows } from './boot-rows.js'
import type { AssemblyContext } from './context.js'
import type { ExtensionHost } from './extension-host.js'
import type { mountExtensionRows } from './extension-rows.js'
import type { SkillState } from './skills.js'

/**
 * Replaces the Skill generation the live-resource rows read, rolling every row and the Skill
 * state back if any consumer fails to load, and the one reload entry point built on it.
 */
export function createSkillRefresh(
  ctx: AssemblyContext,
  input: Readonly<{
    skillState: SkillState
    bootRows: BootRows
    host: ExtensionHost
    rows: Awaited<ReturnType<typeof mountExtensionRows>>
  }>,
) {
  const { skillState, bootRows, host, rows } = input
  const { builtin } = bootRows
  const { builtinRows } = host
  const { extensionRows, prepareExtensionRow, preparedExtensionInputs } = rows
  let skillRefreshTail: Promise<void> = Promise.resolve()
  let skillRetry = 0
  const refreshSkillRow = (fresh: SkillRuntimeInput | undefined): Promise<void> => {
    fresh = skillState.bind(fresh)
    const task = skillRefreshTail.then(async () => {
      const previousRows = extensionRows.current()
      const consumers = previousRows.filter((row) => row.liveResources?.includes('skills'))
      const revision = skillRowRevision(fresh)
      const statusFor = (row: EntryRow) =>
        builtinRows.statusEntries().find(({ status }) => status.id === row.id.slice('ext:'.length))?.status
      const changed = consumers.filter(
        (row) =>
          !row.disabled &&
          (!statusFor(row)?.loaded ||
            (row.liveResourceRevision !== revision &&
              !row.liveResourceRevision?.startsWith(`${revision}:retry`))),
      )
      const oldInput = skillState.active
      const oldPrepared = new Map(preparedExtensionInputs)
      const oldClaims = builtin.claims
      try {
        const replacements = new Map(
          changed.map((row) => {
            const extensionId = row.id.slice('ext:'.length)
            return [
              row.id,
              prepareExtensionRow({
                ...oldPrepared.get(extensionId),
                extensionId,
                entryRevision: row.entryRevision,
                liveResourceRevision:
                  row.liveResourceRevision === revision ? `${revision}:retry${++skillRetry}` : revision,
                ...(row.config === undefined ? {} : { config: row.config }),
                disabled: row.disabled,
                skillResources: fresh,
              }),
            ]
          }),
        )
        if (changed.length) await extensionRows.apply(withSkillRows(previousRows, [...replacements.values()]))
        for (const row of changed) {
          const status = statusFor(row)
          if (!status?.loaded)
            throw new HostError('E_EXT_LOAD', 'Live resource consumer failed to load', {
              detail: { id: row.id, ...(status?.error ? { error: status.error.code } : {}) },
            })
        }
        skillState.active = fresh
        skillState.preload = fresh
      } catch (error) {
        try {
          builtin.claims = oldClaims
          preparedExtensionInputs.clear()
          for (const [id, input] of oldPrepared) preparedExtensionInputs.set(id, input)
          await extensionRows.apply(previousRows)
          skillState.active = oldInput
          skillState.preload = oldInput
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], 'Live resource refresh recovery required')
        }
        throw error
      }
    })
    skillRefreshTail = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }
  // ==== end ext: rows ====
  const reloadEcosystemExtension = async (
    id: string,
    freshInit: Readonly<{ skillResources?: SkillRuntimeInput }>,
  ): Promise<ExtensionStatus> => {
    if (
      extensionRows.current().some((row) => row.id === `ext:${id}` && row.liveResources?.includes('skills'))
    ) {
      await refreshSkillRow(freshInit.skillResources)
      const status = builtinRows.statusEntries().find(({ status }) => status.id === id)?.status
      if (!status) throw new HostError('E_EXT_LOAD', 'Skills row has no status')
      return status
    }
    throw new HostError('E_EXT_LOAD', `${id} is not a reloadable bundled ecosystem extension`, {
      detail: { id },
    })
  }
  return { refreshSkillRow, reloadEcosystemExtension }
}
