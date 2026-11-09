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
async function setup(fetcher: typeof fetch, indexFetcher: typeof fetch = async () => Response.json(index())) {
  const directory = await mkdtemp(join(tmpdir(), 'agh-community-'))
  directories.push(directory)
  const network = vi.fn<typeof fetch>((url, init) =>
    String(url) === COMMUNITY_INDEX_URL ? indexFetcher(url, init) : fetcher(url, init),
  )
  const owner = await openCommunityDiscovery({ directory, fetch: network, random: () => 0 })
  owners.push(owner)
  return { owner, directory, network }
}
const entry = (url = 'https://github.com/example/plugin-1') => ({
  name: '@example/plugin',
  repository: { url },
  versions: [{ version: '1.0.0', source: { type: 'git', url, commit: 'a'.repeat(40) } }],
})
const index = (plugins = [entry()]) => ({ format: 1, plugins })
const repo = (id = 1) => ({
  id,
  full_name: `example/plugin-${id}`,
  private: false,
  description: '<script>not markup</script>',
  topics: ['agh-plugin', 'memory'],
  stargazers_count: 20,
  forks_count: 2,
  open_issues_count: 1,
  pushed_at: '2026-01-01T00:00:00Z',
})
const result = (items = [repo()], total_count = items.length) =>
  Response.json({ items, total_count, incomplete_results: false })

it('serves clones without networking and refreshes independently, persisting a deduplicated cache across restart', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => result())
  const { owner, directory, network } = await setup(fetcher)
  expect(owner.read().state).toBe('pending')
  owner.read()
  owner.read()
  expect(network).not.toHaveBeenCalled()
  owner.start()
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('ready'))
  const snapshot = owner.read()
  expect(snapshot.items).toMatchObject([
    { id: 1, fullName: 'example/plugin-1', topics: ['agh-plugin', 'memory'], ecosystem: 'agh' },
  ])
  snapshot.items.length = 0
  expect(owner.read().items).toHaveLength(1)
  expect(fetcher.mock.calls.every(([url]) => String(url).includes('is%3Apublic'))).toBe(true)
  const recorded = JSON.parse(await readFile(join(directory, 'community-discovery-cache.json'), 'utf8'))
  expect(recorded.snapshot.items).toHaveLength(1)
  await owner.close()
  const reloaded = await openCommunityDiscovery({ directory, fetch: network, random: () => 0 })
  owners.push(reloaded)
  expect(reloaded.read().lastSuccessAt).toBe(snapshot.lastSuccessAt)
  expect(reloaded.read().items).toHaveLength(1)
  const before = fetcher.mock.calls.length
  reloaded.start()
  await vi.advanceTimersByTimeAsync(1000)
  expect(fetcher.mock.calls).toHaveLength(before)
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(reloaded.read().state).toBe('ready'))
  expect(fetcher.mock.calls.length).toBeGreaterThan(before)
})

it('retains the previous snapshot on a later page failure and respects server retry delay', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => result())
  const { owner } = await setup(fetcher)
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('ready'))
  const original = owner.read()
  fetcher.mockImplementation(async (url) =>
    new URL(String(url)).searchParams.get('page') === '1'
      ? result(
          Array.from({ length: 100 }, (_, id) => repo(id + 10)),
          200,
        )
      : new Response('', { status: 429, headers: { 'retry-after': '3600' } }),
  )
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('failed'))
  expect(owner.read()).toMatchObject({
    items: original.items,
    lastSuccessAt: original.lastSuccessAt,
    error: 'rate-limit',
  })
  const before = fetcher.mock.calls.length
  await vi.advanceTimersByTimeAsync(30 * 60_000)
  expect(fetcher.mock.calls).toHaveLength(before)
  await owner.close()
  await vi.advanceTimersByTimeAsync(24 * 3600_000)
  expect(fetcher.mock.calls).toHaveLength(before)
})

it.each([
  'disabled',
  'invalid',
  'legacy-topic',
  'corrupt-cache',
  'legacy-cache',
  'empty',
  'invalid-response',
  'incomplete',
  'oversized',
  'bad-json',
  'storage',
] as const)('handles %s without executing repository code', async (mode) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
    if (mode === 'invalid-response')
      return Response.json({ items: [{ ...repo(), private: true }], total_count: 1 })
    if (mode === 'incomplete')
      return Response.json({ items: [repo()], total_count: 1, incomplete_results: true })
    if (mode === 'oversized') return new Response('x'.repeat(2 * 1024 * 1024 + 1))
    if (mode === 'bad-json') return new Response('not JSON')
    return result([], 0)
  })
  const { owner: unused, directory } = await setup(fetcher)
  await unused.close()
  if (mode === 'disabled') await writeFile(join(directory, 'community-discovery.json'), '{"enabled":false}')
  if (mode === 'invalid')
    await writeFile(join(directory, 'community-discovery.json'), '{"topics":["secret-topic"]}')
  if (mode === 'legacy-topic')
    await writeFile(join(directory, 'community-discovery.json'), '{"topics":["agh-plugin","dsh-plugin"]}')
  if (mode === 'corrupt-cache') await writeFile(join(directory, 'community-discovery-cache.json'), 'not JSON')
  if (mode === 'legacy-cache')
    await writeFile(
      join(directory, 'community-discovery-cache.json'),
      JSON.stringify({
        version: 1,
        fingerprint: 'agh-plugin',
        snapshot: {
          ...unused.read(),
          state: 'ready',
          totalReported: 1,
          lastSuccessAt: new Date().toISOString(),
          items: [
            {
              id: 9,
              fullName: 'unlisted/plugin',
              description: '',
              topics: ['agh-plugin'],
              ecosystem: 'agh',
              stars: 0,
              forks: 0,
              issues: 0,
              language: '',
              license: '',
              pushedAt: null,
            },
          ],
        },
      }),
    )
  if (mode === 'storage') await mkdir(join(directory, 'community-discovery-cache.json'))
  const owner = await openCommunityDiscovery({
    directory,
    fetch: async (url, init) =>
      String(url) === COMMUNITY_INDEX_URL ? Response.json(index()) : fetcher(url, init),
    random: () => 0,
  })
  owners.push(owner)
  expect(owner.read().items).toEqual([])
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  if (mode === 'disabled' || mode === 'invalid' || mode === 'legacy-topic') {
    expect(fetcher).not.toHaveBeenCalled()
    expect(owner.read().state).toBe('disabled')
  } else {
    const failed = ['invalid-response', 'incomplete', 'oversized', 'bad-json', 'storage'].includes(mode)
    await vi.waitFor(() => expect(owner.read().state).toBe(failed ? 'failed' : 'ready'))
    expect(owner.read().items).toEqual([])
    if (failed) expect(owner.read().error).toBe(mode === 'storage' ? 'storage' : 'invalid-data')
  }
})

it.each(['network', 'rate-limit', 'oversized', 'bad-json'] as const)(
  'fails closed without an approved cache when the index has a %s failure',
  async (failure) => {
    vi.useFakeTimers()
    let limitedAt = 0
    const { owner } = await setup(
      async () => result(),
      async (_url, init) => {
        expect(init?.redirect).toBe('error')
        if (failure === 'network') return new Response('', { status: 503 })
        if (failure === 'rate-limit') {
          limitedAt = Date.now()
          return new Response('', { status: 429, headers: { 'retry-after': '3600' } })
        }
        return new Response(failure === 'oversized' ? 'x'.repeat(2 * 1024 * 1024 + 1) : 'not JSON')
      },
    )
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

it.each(['search', 'index'])(
  'cancels an in-flight %s response and never publishes after the owner closes',
  async (stage) => {
    vi.useFakeTimers()
    let cancelled = false
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
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
    const { owner, directory } = await setup(
      stage === 'search' ? fetcher : async () => result(),
      stage === 'index' ? fetcher : undefined,
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
    await vi.advanceTimersByTimeAsync(24 * 3600_000)
    expect(owner.read().items).toEqual([])
  },
)

it('intersects topic results with the official index, normalizes identities and refreshes removals without promoting publishers', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn<typeof fetch>(async () =>
    result([
      repo(1),
      repo(2),
      { ...repo(3), topics: ['dsh-plugin'] },
      { ...repo(4), full_name: 'EXAMPLE/PLUGIN-4' },
    ]),
  )
  let listed = [
    entry('https://github.com/Example/plugin-1.git/'),
    entry('https://github.com/example/plugin-3'),
    entry('https://github.com/example/plugin-4'),
  ]
  let unavailable = false
  const { owner } = await setup(fetcher, async () =>
    unavailable ? new Response('', { status: 503 }) : Response.json(index(listed)),
  )
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('ready'))
  expect(owner.read()).toMatchObject({
    totalReported: 2,
    items: [
      { fullName: 'example/plugin-1', ecosystem: 'agh' },
      { fullName: 'EXAMPLE/PLUGIN-4', ecosystem: 'agh' },
    ],
  })
  expect(
    fetcher.mock.calls.every(
      ([url]) =>
        new URL(String(url)).searchParams.get('q') === 'topic:agh-plugin archived:false fork:false is:public',
    ),
  ).toBe(true)
  listed = [entry('https://github.com/example/plugin-4')]
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('ready'))
  expect(owner.read().items.map((row) => row.fullName)).toEqual(['EXAMPLE/PLUGIN-4'])
  unavailable = true
  await vi.advanceTimersByTimeAsync(6 * 3600_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('failed'))
  expect(owner.read()).toMatchObject({ error: 'network', items: [{ fullName: 'EXAMPLE/PLUGIN-4' }] })
  unavailable = false
  listed = []
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('ready'))
  expect(owner.read()).toMatchObject({ totalReported: 0, items: [] })
})

it.each([
  { format: 2, plugins: [entry()] },
  { format: 1 },
  index([entry('https://github.com.attacker.example/example/plugin-1')]),
  index([entry('https://github.com/example/plugin-1?other=1')]),
  index([entry('https://user:password@github.com/example/plugin-1')]),
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
  index([{ ...entry(), versions: [] }]),
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
])('never admits topic-only results when the index is malformed: %j', async (body) => {
  vi.useFakeTimers()
  const { owner } = await setup(
    async () => result(),
    async () => Response.json(body),
  )
  owner.start()
  await vi.advanceTimersByTimeAsync(10_000)
  await vi.waitFor(() => expect(owner.read().state).toBe('failed'))
  expect(owner.read()).toMatchObject({ error: 'invalid-data', lastSuccessAt: null, items: [] })
})
