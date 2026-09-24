import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SlotName, ThinkingLevel } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import {
  accountDefaultModel,
  type ComposerMemory,
  type ComposerModelRef,
  mergeComposerMemory,
  parseComposerMemory,
  resolveNewSessionSelection,
} from '@agnes/sdk/composer-selection'

export function readComposerMemoryFile(path: string | undefined): ComposerMemory | undefined {
  if (!path) return undefined
  try {
    return parseComposerMemory(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch {
    return undefined
  }
}

export function writeComposerMemoryFile(path: string | undefined, update: ComposerMemory): void {
  if (!path) return
  try {
    const next = mergeComposerMemory(readComposerMemoryFile(path), update)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(next)}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
  } catch {
    // The session change already succeeded. A preference file must not fail the command.
  }
}

export async function inheritFreshSession(
  session: Session,
  path: string | undefined,
  explicit?: { slot: SlotName; route: string; model: string; thinking?: ThinkingLevel },
): Promise<{ modelId?: string; notice?: string }> {
  if (explicit) {
    await session.setModel(explicit)
    writeComposerMemoryFile(path, {
      model: {
        route: explicit.route,
        id: explicit.model,
        ...(explicit.thinking ? { thinking: explicit.thinking } : {}),
      },
    })
  }
  if (!path) return explicit ? { modelId: explicit.model } : {}
  try {
    const remembered = readComposerMemoryFile(path)
    const listed = (await session.client.apis()).profile.models ?? []
    const models: ComposerModelRef[] = listed.map(({ route, id }) => ({ route, id }))
    const snapshot = await session.client.config.get()
    const accountDefault = accountDefaultModel(models, snapshot.provider)
    const resolved = resolveNewSessionSelection({
      remembered,
      models,
      ...(accountDefault ? { accountDefault } : {}),
    })
    const model = explicit ? { route: explicit.route, id: explicit.model } : resolved.model
    if (!explicit && model)
      await session.setModel({
        slot: 'primary',
        route: model.route,
        model: model.id,
        ...(model.thinking ? { thinking: model.thinking } : {}),
      })
    if (resolved.permission === 'full') await session.setYolo(true)
    const notice = [
      model ? `${model.route}/${model.id}${model.thinking ? ` · ${model.thinking}` : ''}` : undefined,
      resolved.permission === 'full' ? '完全权限' : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(' · ')
    return { ...(model ? { modelId: model.id } : {}), ...(notice ? { notice: `新会话使用 ${notice}` } : {}) }
  } catch {
    return explicit ? { modelId: explicit.model } : {}
  }
}
