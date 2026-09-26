import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  inheritFreshSession,
  readComposerMemoryFile,
  writeComposerMemoryFile,
} from '../src/composer-memory.js'

function sessionDouble(): Session & {
  setModel: ReturnType<typeof vi.fn>
  setYolo: ReturnType<typeof vi.fn>
} {
  const setModel = vi.fn(async () => ({ effectiveFromSeq: 1 }))
  const setYolo = vi.fn(async () => ({ effectiveFromSeq: 2 }))
  return {
    setModel,
    setYolo,
    client: {
      apis: async () => ({
        profile: {
          models: [
            { route: 'deepseek', id: 'deepseek-v4-flash' },
            { route: 'deepseek', id: 'deepseek-v4-pro' },
          ],
        },
      }),
      config: {
        get: async () => ({
          provider: { id: 'deepseek', route: 'deepseek', model: 'deepseek-v4-flash' },
        }),
      },
    },
  } as unknown as Session & { setModel: ReturnType<typeof vi.fn>; setYolo: ReturnType<typeof vi.fn> }
}

describe('TUI composer memory', () => {
  it('stores the last choice privately and applies it to a fresh session', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agh-composer-')), 'composer-selection.json')
    writeComposerMemoryFile(path, {
      model: { route: 'deepseek', id: 'deepseek-v4-pro', thinking: 'medium' },
    })
    writeComposerMemoryFile(path, { permission: 'full' })
    // Windows has no POSIX permission bits (Node reports 0o666 for any writable file); the file
    // there relies on the per-user profile directory's access list.
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readComposerMemoryFile(path)).toEqual({
      model: { route: 'deepseek', id: 'deepseek-v4-pro', thinking: 'medium' },
      permission: 'full',
    })

    const session = sessionDouble()
    const inherited = await inheritFreshSession(session, path)
    expect(session.setModel).toHaveBeenCalledWith({
      slot: 'primary',
      route: 'deepseek',
      model: 'deepseek-v4-pro',
      thinking: 'medium',
    })
    expect(session.setYolo).toHaveBeenCalledWith(true)
    expect(inherited).toEqual({
      modelId: 'deepseek-v4-pro',
      notice: '新会话使用 deepseek/deepseek-v4-pro · medium · 完全权限',
    })
  })

  it('uses the account default when the remembered model is gone and keeps an explicit launch model', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'agh-composer-')), 'composer-selection.json')
    writeComposerMemoryFile(path, { model: { route: 'deepseek', id: 'retired' }, permission: 'workspace' })
    const session = sessionDouble()
    const inherited = await inheritFreshSession(session, path, {
      slot: 'primary',
      route: 'deepseek',
      model: 'deepseek-v4-flash',
    })
    expect(session.setModel).toHaveBeenCalledTimes(1)
    expect(session.setModel).toHaveBeenCalledWith({
      slot: 'primary',
      route: 'deepseek',
      model: 'deepseek-v4-flash',
    })
    expect(session.setYolo).not.toHaveBeenCalled()
    expect(readComposerMemoryFile(path)?.model).toEqual({ route: 'deepseek', id: 'deepseek-v4-flash' })
    expect(inherited.modelId).toBe('deepseek-v4-flash')
  })

  it('does nothing when no preference file is configured', async () => {
    const session = sessionDouble()
    await expect(inheritFreshSession(session, undefined)).resolves.toEqual({})
    expect(session.setModel).not.toHaveBeenCalled()
  })
})
