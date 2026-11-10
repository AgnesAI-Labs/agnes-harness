import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openCommunityDiscovery } from '../src/packages/community-discovery.js'
import { COMMUNITY_INDEX_URL } from '../src/packages/community-index.js'

const directories: string[] = []
const owners: Awaited<ReturnType<typeof openCommunityDiscovery>>[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close()
  vi.useRealTimers()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const entry = (url = 'https://github.com/example/plugin-1', name = '@example/plugin') => ({
  name,
  title: { en: 'Plugin', 'zh-cn': '插件' },
  description: { en: '<script>not markup</script>', 'zh-cn': '简介' },
  author: 'Example Author',
  repository: { url },
  versions: [{ version: '1.0.0', source: { type: 'git', url, commit: 'a'.repeat(40) } }],
})
const index = (plugins: unknown[] = [entry()]) => ({ format: 1, plugins })
async function setup(fetcher: typeof fetch = async () => Response.json(index())) {
  const directory = await mkdtemp(join(tmpdir(), 'agh-community-'))
  directories.push(directory)
  const network = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe(COMMUNITY_INDEX_URL)
    expect(init?.redirect).toBe('error')
    return fetcher(url, init)
  })
  const owner = await openCommunityDiscovery({ directory, fetch: network, random: () => 0 })
  owners.push(owner)
  return { owner, directory, network }
}

it('serves clones without networking and refreshes independently, persisting the index across restart', async () => {
  vi.useFakeTimers()
  const { owner, directory, network } = await setup()
  owner.read()
  expect(network).not.toHaveBeenCalled()
  owner.start()
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('ready'))
  const snapshot = owner.read()
  expect(snapshot.items).toMatchObject([
    {
      id: '@example/plugin',
      name: '@example/plugin',
      fullName: 'example/plugin-1',
      author: 'Example Author',
      summary: { en: '<script>not markup</script>', 'zh-cn': '简介' },
      versions: [
        {
          version: '1.0.0',
          source: { type: 'git', ref: `git:https://github.com/example/plugin-1.git#${'a'.repeat(40)}` },
        },
      ],
    },
  ])
  expect(snapshot.items[0]).not.toHaveProperty('stars')
  snapshot.items.length = 0
  expect(owner.read().items).toHaveLength(1)
  const recorded = JSON.parse(await readFile(join(directory, 'community-discovery-cache.json'), 'utf8'))
  expect(recorded.version).toBe(3)
  await owner.close()
  const reloaded = await openCommunityDiscovery({ directory, fetch: network, random: () => 0 })
  owners.push(reloaded)
  expect(reloaded.read().lastSuccessAt).toBe(snapshot.lastSuccessAt)
  expect(reloaded.read().items).toHaveLength(1)
  const before = network.mock.calls.length
  reloaded.start()
  await vi.advanceTimersByTimeAsync(1000)
  expect(network.mock.calls).toHaveLength(before)
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(network.mock.calls.length).toBeGreaterThan(before))
})

it('retains the previous complete snapshot on failure and respects server retry delay', async () => {
  vi.useFakeTimers()
  let limited = false
  const { owner, network } = await setup(async () =>
    limited ? new Response('', { status: 429, headers: { 'retry-after': '3600' } }) : Response.json(index()),
  )
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('ready'))
  const original = owner.read()
  limited = true
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('failed'))
  expect(owner.read()).toMatchObject({
    items: original.items,
    lastSuccessAt: original.lastSuccessAt,
    error: 'rate-limit',
  })
  const before = network.mock.calls.length
  await vi.advanceTimersByTimeAsync(30 * 60_000)
  expect(network.mock.calls).toHaveLength(before)
  await owner.close()
  await vi.advanceTimersByTimeAsync(24 * 3600_000)
  expect(network.mock.calls).toHaveLength(before)
})

it.each([
  'disabled',
  'invalid',
  'legacy-topic',
  'legacy-disabled',
  'corrupt-cache',
  'legacy-cache',
  'empty',
  'storage',
] as const)('handles %s without executing repository code', async (mode) => {
  vi.useFakeTimers()
  const { owner: unused, directory } = await setup()
  await unused.close()
  const config =
    mode === 'disabled'
      ? { enabled: false }
      : mode === 'invalid'
        ? { topics: ['secret-topic'] }
        : mode === 'legacy-topic' || mode === 'legacy-disabled'
          ? { enabled: mode !== 'legacy-disabled', topics: ['agh-plugin', 'dsh-plugin'] }
          : undefined
  if (config) await writeFile(join(directory, 'community-discovery.json'), JSON.stringify(config))
  if (mode === 'corrupt-cache') await writeFile(join(directory, 'community-discovery-cache.json'), 'not JSON')
  if (mode === 'legacy-cache')
    await writeFile(
      join(directory, 'community-discovery-cache.json'),
      JSON.stringify({
        version: 2,
        fingerprint: 'agh-plugin',
        snapshot: { ...unused.read(), items: [{ id: 1, fullName: 'unlisted/plugin', description: '' }] },
      }),
    )
  if (mode === 'storage') await mkdir(join(directory, 'community-discovery-cache.json'))
  const network = vi.fn<typeof fetch>(async () => Response.json(index(mode === 'empty' ? [] : undefined)))
  const owner = await openCommunityDiscovery({ directory, fetch: network, random: () => 0 })
  owners.push(owner)
  expect(owner.read().items).toEqual([])
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  if (['disabled', 'invalid', 'legacy-disabled'].includes(mode)) {
    expect(network).not.toHaveBeenCalled()
    expect(owner.read()).toMatchObject({
      state: 'disabled',
      error: mode === 'invalid' ? 'configuration' : null,
    })
  } else {
    await vi.waitFor(() => expect(owner.read().state).toBe(mode === 'storage' ? 'failed' : 'ready'))
    if (mode === 'empty' || mode === 'storage') expect(owner.read().items).toEqual([])
    else expect(owner.read().items).toHaveLength(1)
    if (config)
      expect(JSON.parse(await readFile(join(directory, 'community-discovery.json'), 'utf8'))).toEqual(config)
  }
})

it.each(['network', 'rate-limit', 'oversized', 'bad-json'] as const)(
  'fails closed without a cache when the index has a %s failure',
  async (failure) => {
    vi.useFakeTimers()
    let limitedAt = 0
    const { owner } = await setup(async () => {
      if (failure === 'network') return new Response('', { status: 503 })
      if (failure === 'rate-limit') {
        limitedAt = Date.now()
        return new Response('', { status: 429, headers: { 'retry-after': '3600' } })
      }
      return new Response(failure === 'oversized' ? 'x'.repeat(2 * 1024 * 1024 + 1) : 'not JSON')
    })
    owner.start()
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.waitFor(() => expect(owner.read().state).toBe('failed'))
    expect(owner.read()).toMatchObject({
      items: [],
      lastSuccessAt: null,
      error: ['oversized', 'bad-json'].includes(failure) ? 'invalid-data' : failure,
    })
    if (failure === 'rate-limit')
      expect(Date.parse(owner.read().nextAttemptAt ?? '')).toBeGreaterThanOrEqual(limitedAt + 3600_000)
  },
)

it('cancels an in-flight index response and never publishes after the owner closes', async () => {
  vi.useFakeTimers()
  let cancelled = false
  const { owner, directory } = await setup(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            cancelled = true
            reject(init.signal?.reason)
          },
          { once: true },
        )
      }),
  )
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(owner.read().state).toBe('syncing')
  await owner.close()
  expect(cancelled).toBe(true)
  expect(owner.read().lastSuccessAt).toBeNull()
  await expect(readFile(join(directory, 'community-discovery-cache.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

it('includes every indexed package without topics or a 200/400/1000-entry cutoff and refreshes removals', async () => {
  vi.useFakeTimers()
  let listed = Array.from({ length: 1101 }, (_, i) =>
    entry(`https://github.com/example/plugin-${i}`, `@example/plugin-${i}`),
  )
  const { owner } = await setup(async () => Response.json(index(listed)))
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('ready'))
  expect(owner.read().items).toHaveLength(1101)
  expect(owner.read().totalReported).toBe(1101)
  listed = [entry('https://github.com/Example/plugin-1.git/')]
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(owner.read().items).toHaveLength(1))
  expect(owner.read().items[0]?.fullName).toBe('example/plugin-1')
  listed = []
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(owner.read()).toMatchObject({ totalReported: 0, items: [] }))
})

it.each([
  { format: 2, plugins: [entry()] },
  { format: 1 },
  index([entry('https://github.com.attacker.example/example/plugin-1')]),
  index([entry('https://github.com/example/plugin-1?other=1')]),
  index([entry('https://user:password@github.com/example/plugin-1')]),
  index([entry(), entry()]),
  index([{ ...entry(), versions: [] }]),
  index([{ ...entry(), author: { name: 'unsupported' } }]),
  index([{ ...entry(), description: { en: 42 } }]),
  index([
    {
      ...entry(),
      versions: [
        {
          version: '1.0.0',
          source: { type: 'git', url: 'https://github.com/other/plugin', commit: 'a'.repeat(40) },
        },
      ],
    },
  ]),
  index([
    {
      ...entry(),
      versions: [
        {
          version: '1.0.0',
          source: { type: 'git', url: 'https://github.com/example/plugin-1', commit: 'main' },
        },
      ],
    },
  ]),
])('refuses malformed index data without publishing a partial list: %j', async (body) => {
  vi.useFakeTimers()
  const { owner } = await setup(async () => Response.json(body))
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('failed'))
  expect(owner.read()).toMatchObject({ error: 'invalid-data', lastSuccessAt: null, items: [] })
})
