import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import { createResourceControlService, createSkillResourceStore } from '@agnes/resource-control-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemorySessionWorkspaces } from '../src/storage/lister.js'
import { MemoryWorkspaceStore, WorkspaceCatalog } from '../src/storage/workspaces.js'
import {
  createSkillWatcher,
  isSkillChange,
  refreshThroughService,
  type SkillRefreshTarget,
  startSkillWatcher,
  type WatchFn,
  watchedPath,
} from '../src/supervisor/skill-watcher.js'

type FakeHandle = {
  path: string
  recursive: boolean
  emit(file: string | null): void
  fail(error: unknown): void
  closed: boolean
}

function fakeFs(initial: string[] = []) {
  const existing = new Set(initial)
  const handles: FakeHandle[] = []
  const watch: WatchFn = (path, recursive, onEvent, onError) => {
    const handle: FakeHandle = {
      path,
      recursive,
      closed: false,
      emit: (file) => {
        if (!handle.closed) onEvent(file)
      },
      fail: (error) => {
        if (!handle.closed) onError(error)
      },
    }
    handles.push(handle)
    return {
      close: () => {
        handle.closed = true
      },
    }
  }
  const live = (path: string) => handles.filter((handle) => handle.path === path && !handle.closed)
  return { existing, handles, watch, exists: (path: string) => existing.has(path), live }
}

function recorder() {
  const calls: SkillRefreshTarget[] = []
  let release: (() => void) | undefined
  let hold = false
  const refresh = async (target: SkillRefreshTarget) => {
    calls.push(target)
    if (hold) await new Promise<void>((resolve) => (release = resolve))
  }
  return {
    calls,
    refresh,
    holdNext: () => {
      hold = true
    },
    releaseNow: () => {
      hold = false
      release?.()
    },
  }
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

describe('watchedPath', () => {
  it('hands the platform watcher the long spelling of a Windows path and POSIX paths as given', () => {
    const expand = (path: string) => path.replace('RUNNER~1', 'runneradmin')
    expect(watchedPath('C:\\Users\\RUNNER~1\\home\\skills', true, expand)).toBe(
      'C:\\Users\\runneradmin\\home\\skills',
    )
    expect(watchedPath('/srv/agh/skills', false, expand)).toBe('/srv/agh/skills')
    const missing = () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
    expect(watchedPath('C:\\gone', true, missing)).toBe('C:\\gone')
  })
})

describe('isSkillChange', () => {
  it('accepts Skill entries and attachments but not dot folders, node_modules, or deep paths', () => {
    expect(isSkillChange(null)).toBe(true)
    expect(isSkillChange('demo')).toBe(true)
    expect(isSkillChange('solo.md')).toBe(true)
    expect(isSkillChange('demo/SKILL.md')).toBe(true)
    expect(isSkillChange('demo/reference.md')).toBe(true)
    expect(isSkillChange('demo/templates/a/b/c.md')).toBe(true)
    expect(isSkillChange(join('demo', 'scripts', 'run.py'))).toBe(true)
    expect(isSkillChange('.DS_Store')).toBe(false)
    expect(isSkillChange('demo/.git/HEAD')).toBe(false)
    expect(isSkillChange('demo/node_modules/x/index.md')).toBe(false)
    expect(isSkillChange('demo/assets/a/b/c/d/e.png')).toBe(false)
  })
})

describe('createSkillWatcher', () => {
  it('coalesces a burst of changes into one refresh of that target', async () => {
    const fs = fakeFs(['/u'])
    const rec = recorder()
    const watcher = createSkillWatcher({
      refresh: rec.refresh,
      debounceMs: 20,
      watch: fs.watch,
      exists: fs.exists,
    })
    watcher.watchRoot({ rootKey: 'user-agnes' }, '/u')
    const [handle] = fs.live('/u')
    expect(handle?.recursive).toBe(true)
    handle?.emit('demo/SKILL.md')
    handle?.emit('demo/SKILL.md')
    handle?.emit('demo/references/a.md')
    await settle()
    expect(rec.calls).toEqual([{ rootKey: 'user-agnes' }])
    await watcher.close()
  })

  it('ignores changes that cannot alter a Skill revision', async () => {
    const fs = fakeFs(['/u'])
    const rec = recorder()
    const watcher = createSkillWatcher({
      refresh: rec.refresh,
      debounceMs: 10,
      watch: fs.watch,
      exists: fs.exists,
    })
    watcher.watchRoot({ rootKey: 'user-agnes' }, '/u')
    fs.live('/u')[0]?.emit('demo/.git/HEAD')
    await settle()
    expect(rec.calls).toEqual([])
    await watcher.close()
  })

  it('runs exactly one follow-up refresh for changes seen while a refresh is running', async () => {
    const fs = fakeFs(['/u'])
    const rec = recorder()
    const watcher = createSkillWatcher({
      refresh: rec.refresh,
      debounceMs: 10,
      watch: fs.watch,
      exists: fs.exists,
    })
    watcher.watchRoot({ rootKey: 'user-agnes' }, '/u')
    const handle = fs.live('/u')[0]
    rec.holdNext()
    handle?.emit('demo/SKILL.md')
    await settle(40)
    expect(rec.calls).toHaveLength(1)
    handle?.emit('demo/SKILL.md')
    handle?.emit('other/SKILL.md')
    await settle(40)
    expect(rec.calls).toHaveLength(1)
    rec.releaseNow()
    await settle(60)
    expect(rec.calls).toHaveLength(2)
    await watcher.close()
  })

  it('watches the nearest existing ancestor until the Skill root appears, then refreshes', async () => {
    const fs = fakeFs(['/ws'])
    const rec = recorder()
    const watcher = createSkillWatcher({
      refresh: rec.refresh,
      debounceMs: 10,
      watch: fs.watch,
      exists: fs.exists,
    })
    watcher.watchWorkspace('w1', '/ws/.agnes/skills')
    const ancestor = fs.live('/ws')[0]
    expect(ancestor?.recursive).toBe(false)
    fs.existing.add('/ws/.agnes')
    ancestor?.emit('.agnes')
    expect(fs.live('/ws/.agnes')).toHaveLength(1)
    fs.existing.add('/ws/.agnes/skills')
    fs.live('/ws/.agnes')[0]?.emit('skills')
    expect(fs.live('/ws/.agnes/skills')[0]?.recursive).toBe(true)
    await settle()
    expect(rec.calls).toEqual([{ rootKey: 'workspace-agnes', workspaceId: 'w1' }])
    await watcher.close()
  })

  it('falls back to the ancestor and refreshes when the Skill root is deleted', async () => {
    const fs = fakeFs(['/u', '/'])
    const rec = recorder()
    const watcher = createSkillWatcher({
      refresh: rec.refresh,
      debounceMs: 10,
      watch: fs.watch,
      exists: fs.exists,
    })
    watcher.watchRoot({ rootKey: 'user-agnes' }, '/u')
    const root = fs.live('/u')[0]
    fs.existing.delete('/u')
    root?.emit(null)
    expect(root?.closed).toBe(true)
    expect(fs.live('/')[0]?.recursive).toBe(false)
    await settle()
    expect(rec.calls).toEqual([{ rootKey: 'user-agnes' }])
    await watcher.close()
  })

  it('re-arms after a watcher error', async () => {
    const fs = fakeFs(['/u'])
    const rec = recorder()
    const warn = vi.fn()
    const watcher = createSkillWatcher({
      refresh: rec.refresh,
      debounceMs: 10,
      retryMs: 10,
      watch: fs.watch,
      exists: fs.exists,
      log: { warn },
    })
    watcher.watchRoot({ rootKey: 'user-agnes' }, '/u')
    const first = fs.live('/u')[0]
    first?.fail(new Error('EMFILE'))
    expect(first?.closed).toBe(true)
    expect(warn).toHaveBeenCalled()
    await settle(40)
    expect(fs.live('/u')).toHaveLength(1)
    await watcher.close()
  })

  it('refreshes a workspace when first watched, evicts the least recently bound, and refreshes it on return', async () => {
    const fs = fakeFs(['/a', '/b', '/c'])
    const rec = recorder()
    const watcher = createSkillWatcher({
      refresh: rec.refresh,
      debounceMs: 10,
      maxWorkspaces: 2,
      watch: fs.watch,
      exists: fs.exists,
    })
    watcher.watchWorkspace('a', '/a')
    watcher.watchWorkspace('b', '/b')
    watcher.watchWorkspace('a', '/a')
    watcher.watchWorkspace('c', '/c')
    expect(fs.live('/b')).toHaveLength(0)
    expect(fs.live('/a')).toHaveLength(1)
    await settle()
    expect(rec.calls.map((call) => call.workspaceId)).toEqual(['a', 'b', 'c'])
    rec.calls.length = 0
    watcher.watchWorkspace('b', '/b')
    await settle()
    expect(rec.calls).toEqual([{ rootKey: 'workspace-agnes', workspaceId: 'b' }])
    await watcher.close()
  })

  it('watches every project directory of a workspace under one refresh target', async () => {
    const fs = fakeFs(['/ws/.agh/skills', '/ws/.claude/skills', '/ws'])
    const rec = recorder()
    const watcher = createSkillWatcher({
      refresh: rec.refresh,
      debounceMs: 10,
      watch: fs.watch,
      exists: fs.exists,
    })
    watcher.watchWorkspace('w1', ['/ws/.agh/skills', '/ws/.agents/skills', '/ws/.claude/skills'], {
      refresh: false,
    })
    expect(fs.live('/ws/.agh/skills')).toHaveLength(1)
    expect(fs.live('/ws/.claude/skills')).toHaveLength(1)
    fs.live('/ws/.claude/skills')[0]?.emit('new/SKILL.md')
    await settle()
    expect(rec.calls).toEqual([{ rootKey: 'workspace-agnes', workspaceId: 'w1' }])
    await watcher.close()
    expect(fs.handles.every((handle) => handle.closed)).toBe(true)
  })

  it('also watches the targets of linked user Skills and drops them when the link goes away', async () => {
    const fs = fakeFs(['/u'])
    const rec = recorder()
    let links = [
      { path: '/elsewhere/linked', dir: true },
      { path: '/elsewhere/solo.md', dir: false },
    ]
    const watcher = createSkillWatcher({
      refresh: rec.refresh,
      debounceMs: 10,
      watch: fs.watch,
      exists: fs.exists,
      links: () => links,
    })
    watcher.watchRoot({ rootKey: 'user-claude' }, '/u', { followLinks: true })
    expect(fs.live('/elsewhere/linked')[0]?.recursive).toBe(true)
    expect(fs.live('/elsewhere/solo.md')[0]?.recursive).toBe(false)
    fs.live('/elsewhere/linked')[0]?.emit('.git/HEAD')
    await settle()
    expect(rec.calls).toEqual([])
    fs.live('/elsewhere/linked')[0]?.emit('SKILL.md')
    await settle()
    expect(rec.calls).toEqual([{ rootKey: 'user-claude' }])
    links = []
    fs.live('/u')[0]?.emit('linked')
    expect(fs.live('/elsewhere/linked')).toHaveLength(0)
    expect(fs.live('/elsewhere/solo.md')).toHaveLength(0)
    await watcher.close()
  })

  it('drops pending refreshes and closes every handle on close', async () => {
    const fs = fakeFs(['/u'])
    const rec = recorder()
    const watcher = createSkillWatcher({
      refresh: rec.refresh,
      debounceMs: 20,
      watch: fs.watch,
      exists: fs.exists,
    })
    watcher.watchRoot({ rootKey: 'user-agnes' }, '/u')
    fs.live('/u')[0]?.emit('demo/SKILL.md')
    await watcher.close()
    await settle()
    expect(rec.calls).toEqual([])
    expect(fs.handles.every((handle) => handle.closed)).toBe(true)
    watcher.watchRoot({ rootKey: 'user-agents' }, '/u')
    expect(fs.live('/u')).toHaveLength(0)
  })
})

describe('refreshThroughService', () => {
  let directory = ''
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = ''
  })

  it('submits a schema-valid refresh as the watcher principal and waits for it to finish', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skill-watcher-service-'))
    const workspaceId = createHash('sha256').update('/ws').digest('hex')
    const seen: Array<{ rootKey?: string; workspaceId?: string }> = []
    let finish: (() => void) | undefined
    const service = createResourceControlService(
      createSkillResourceStore({
        directory,
        scope: { allowedProfiles: ['p'] },
        adapter: {
          refresh: async ({ rootKey, workspaceId }) => {
            seen.push({ ...(rootKey ? { rootKey } : {}), ...(workspaceId ? { workspaceId } : {}) })
            await new Promise<void>((resolve) => (finish = resolve))
            return { candidates: [], failedRoots: [], roots: [] }
          },
          reconcile: async () => [],
        },
      }),
    )
    const refresh = refreshThroughService(service, 'p', { pollMs: 5 })
    let done = false
    const running = refresh({ rootKey: 'workspace-agnes', workspaceId }, new AbortController().signal).then(
      () => {
        done = true
      },
    )
    await vi.waitFor(() => expect(seen).toEqual([{ rootKey: 'workspace-agnes', workspaceId }]))
    await settle(30)
    expect(done).toBe(false)
    finish?.()
    await running
    expect(done).toBe(true)
  })

  it('returns early when aborted while the refresh is still running', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agnes-skill-watcher-abort-'))
    let finish: (() => void) | undefined
    const service = createResourceControlService(
      createSkillResourceStore({
        directory,
        scope: { allowedProfiles: ['p'] },
        adapter: {
          refresh: async () => {
            await new Promise<void>((resolve) => (finish = resolve))
            return { candidates: [], failedRoots: [], roots: [] }
          },
          reconcile: async () => [],
        },
      }),
    )
    const controller = new AbortController()
    const running = refreshThroughService(service, 'p', { pollMs: 5 })(
      { rootKey: 'user-agnes' },
      controller.signal,
    )
    await vi.waitFor(() => expect(finish).toBeDefined())
    controller.abort()
    await expect(running).resolves.toBeUndefined()
    // Let the store finish its own journal writes before the directory is removed.
    finish?.()
    await settle(100)
  })
})

describe('createSkillWatcher on the real filesystem', () => {
  let directory = ''
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = ''
  })

  it('refreshes after a SKILL.md is written under a watched root', async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'agnes-skill-watcher-fs-')))
    const root = join(directory, 'skills')
    await mkdir(root)
    const rec = recorder()
    const watcher = createSkillWatcher({ refresh: rec.refresh, debounceMs: 50 })
    watcher.watchRoot({ rootKey: 'user-agnes' }, root)
    await settle(100)
    await mkdir(join(root, 'demo'))
    await writeFile(join(root, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\nbody\n')
    await vi.waitFor(() => expect(rec.calls).toEqual([{ rootKey: 'user-agnes' }]), { timeout: 5000 })
    await watcher.close()
  })

  it('refreshes a bound workspace through the resource service when a Skill appears in it', async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'agnes-skill-watcher-ws-')))
    const home = join(directory, 'home')
    const workspace = join(directory, 'ws')
    const store = join(directory, 'rc')
    await Promise.all([mkdir(home), mkdir(workspace), mkdir(store)])
    const seen: Array<{ rootKey?: string; workspaceId?: string }> = []
    const service = createResourceControlService(
      createSkillResourceStore({
        directory: store,
        scope: { allowedProfiles: ['p'] },
        adapter: {
          refresh: async ({ rootKey, workspaceId }) => {
            seen.push({ ...(rootKey ? { rootKey } : {}), ...(workspaceId ? { workspaceId } : {}) })
            return { candidates: [], failedRoots: [], roots: [] }
          },
          reconcile: async () => [],
        },
      }),
    )
    const catalog = new WorkspaceCatalog(
      new MemoryWorkspaceStore(),
      new MemorySessionWorkspaces(),
      async (path) => ({ path, name: 'ws' }),
    )
    const watcher = await startSkillWatcher({ service, profile: 'p', catalog, env: { HOME: home } })
    await catalog.add(workspace)
    await catalog.authorizeAndBind('session', workspace)
    const workspaceId = createHash('sha256').update(workspace, 'utf8').digest('hex')
    // Without a default workspace the user roots are refreshed once each at start, and a newly
    // bound workspace once when first watched.
    await vi.waitFor(() => expect(seen).toContainEqual({ rootKey: 'workspace-agnes', workspaceId }), {
      timeout: 8000,
    })
    expect(seen).toContainEqual({ rootKey: 'user-claude' })
    await settle(300)
    seen.length = 0
    await mkdir(join(workspace, AGH_DIR, 'skills', 'demo'), { recursive: true })
    await writeFile(
      join(workspace, AGH_DIR, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: d\n---\nbody\n',
    )
    await vi.waitFor(() => expect(seen).toContainEqual({ rootKey: 'workspace-agnes', workspaceId }), {
      timeout: 8000,
    })
    expect(seen.every((call) => call.rootKey === 'workspace-agnes')).toBe(true)
    await watcher.close()
  })

  it('refreshes package Skills once a package operation of this profile settles', async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'agnes-skill-watcher-pkg-')))
    const store = join(directory, 'rc')
    await mkdir(store)
    const seen: Array<string | undefined> = []
    const service = createResourceControlService(
      createSkillResourceStore({
        directory: store,
        scope: { allowedProfiles: ['p'] },
        adapter: {
          refresh: async ({ rootKey }) => {
            seen.push(rootKey)
            return { candidates: [], failedRoots: [], roots: [] }
          },
          reconcile: async () => [],
        },
      }),
    )
    let listener: ((operation: { profile: string; operation: string; state: string }) => void) | undefined
    const packages = {
      subscribe: (next: typeof listener) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
    }
    const catalog = new WorkspaceCatalog(
      new MemoryWorkspaceStore(),
      new MemorySessionWorkspaces(),
      async (path) => ({ path, name: 'ws' }),
    )
    const watcher = await startSkillWatcher({
      service,
      profile: 'p',
      catalog,
      packages,
      env: { HOME: join(directory, 'home') },
    })
    const emit = (operation: string, state: string, profile = 'p') =>
      listener?.({ profile, operation, state })
    await vi.waitFor(() => expect(seen).toHaveLength(4))
    expect(seen).not.toContain('package')
    seen.length = 0

    for (const state of ['received', 'installing', 'switching', 'cancelled']) emit('install', state)
    emit('inspect', 'completed')
    emit('install', 'completed', 'other-profile')
    await settle(400)
    expect(seen).toEqual([])

    emit('install', 'completed')
    await vi.waitFor(() => expect(seen).toEqual(['package']))
    emit('enable', 'failed')
    await vi.waitFor(() => expect(seen).toEqual(['package', 'package']))
    emit('update', 'rolled-back')
    await vi.waitFor(() => expect(seen).toEqual(['package', 'package', 'package']))

    await watcher.close()
    expect(listener).toBeUndefined()
  })
})

describe('startSkillWatcher at daemon start', () => {
  let directory: string | undefined
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('refreshes every root once, scoped to the default workspace, and no more', async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'agnes-skill-watcher-start-')))
    const workspace = join(directory, 'ws')
    const store = join(directory, 'rc')
    await Promise.all([mkdir(workspace), mkdir(store), mkdir(join(directory, 'home'))])
    const seen: Array<{ rootKey?: string; workspaceId?: string }> = []
    const service = createResourceControlService(
      createSkillResourceStore({
        directory: store,
        scope: { allowedProfiles: ['p'] },
        adapter: {
          refresh: async ({ rootKey, workspaceId }) => {
            seen.push({ ...(rootKey ? { rootKey } : {}), ...(workspaceId ? { workspaceId } : {}) })
            return { candidates: [], failedRoots: [], roots: [] }
          },
          reconcile: async () => [],
        },
      }),
    )
    const catalog = new WorkspaceCatalog(
      new MemoryWorkspaceStore(),
      new MemorySessionWorkspaces(),
      async (path) => ({ path, name: 'ws' }),
    )
    await catalog.add(workspace)
    const watcher = await startSkillWatcher({
      service,
      profile: 'p',
      catalog,
      defaultWorkspaceRoot: workspace,
      env: { HOME: join(directory, 'home') },
    })
    const workspaceId = createHash('sha256').update(workspace, 'utf8').digest('hex')
    await vi.waitFor(() => expect(seen).toEqual([{ workspaceId }]))
    await settle(400)
    expect(seen).toEqual([{ workspaceId }])
    await watcher.close()
  })
})
