/** @vitest-environment happy-dom */
import { Context } from '@agnes/cordis'
import { ClientResourceService, SessionService, SlotOutlet, SlotRegistry } from '@agnes/web-client'
import { createElement, StrictMode, useState } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startClientModules } from '../src/client-modules/boot.js'
import { mountRightbarRegion, type RightbarDocument } from '../src/region-slots.js'
import { zhLocaleService } from './helpers/locale.js'

const runtimes: Array<Awaited<ReturnType<typeof startClientModules>>> = []
const owners: Array<{ ctx: Context; mount: ReturnType<typeof mountRightbarRegion> }> = []
afterEach(async () => {
  while (runtimes.length) await runtimes.pop()?.dispose()
  while (owners.length) {
    const owner = owners.pop()
    if (!owner) break
    owner.mount.dispose()
    await owner.ctx.fiber.dispose()
  }
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

function reference(kind: RightbarDocument['kind'], content = 'Loaded', id: string = kind): RightbarDocument {
  const mime = {
    text: 'text/plain',
    code: 'text/plain',
    markdown: 'text/markdown',
    html: 'text/html',
    image: 'image/png',
    pdf: 'application/pdf',
  }[kind]
  return {
    id,
    kind,
    title: 'Document',
    laneId: 'lane',
    artifact: { sha256: 'a'.repeat(64), size: new TextEncoder().encode(content).length, mime },
  }
}
function result(input: { artifact: NonNullable<RightbarDocument['artifact']> }, content: string) {
  return {
    ok: true,
    status: 200,
    artifact: input.artifact,
    contentLength: input.artifact.size,
    acceptRanges: 'bytes',
    etag: `"${input.artifact.sha256}"`,
    base64: btoa(content),
  }
}
async function fixture(
  initial: RightbarDocument,
  call: (method: string, input: never) => Promise<unknown>,
  options: { detached?: boolean; strict?: boolean } = {},
) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const slots = (ctx as unknown as { slots: SlotRegistry }).slots
  const session = new SessionService(ctx, 'session-a')
  const resources = new ClientResourceService(ctx, { call } as never, session)
  const host = document.createElement('aside')
  if (!options.detached) document.body.append(host)
  const mount = mountRightbarRegion(slots, host, { session, resources, document: initial }, zhLocaleService())
  owners.push({ ctx, mount })
  let update: (doc: RightbarDocument) => void = () => {
    throw new Error('owner not mounted')
  }
  function Owner() {
    const [doc, setDoc] = useState(initial)
    update = setDoc
    const outlet = createElement(SlotOutlet, {
      name: 'sidebar.right.tab.document',
      entryKey: doc.kind,
      props: { owner: doc },
    })
    return options.strict ? createElement(StrictMode, {}, outlet) : outlet
  }
  // Real document adapter remains the production registered built-in. Only its upstream owner varies.
  const removeOwner = slots.register(
    { name: 'sidebar.right.pane.tab', key: 'document', id: 'test-owner', owner: 'fixture', priority: -1 },
    Owner,
  )
  await vi.waitFor(() => expect(host.querySelector('[data-rightbar-document-preview]')).toBeTruthy())
  return {
    ctx,
    slots,
    session,
    resources,
    host,
    mount,
    removeOwner,
    update: (doc: RightbarDocument) => flushSync(() => update(doc)),
  }
}

describe('real rightbar document resource boundary', () => {
  it.each([
    ['text', 'Loaded', 'pre', 'Loaded'],
    ['code', '<literal>', 'pre code', '<literal>'],
    ['markdown', '# Heading', 'h1', 'Heading'],
    ['html', '<strong>Safe</strong><img src="https://invalid.test/secret">', 'strong', 'Safe'],
    ['text', '', 'pre', ''],
  ] as const)('decodes %s through the real adapter', async (kind, content, selector, expected) => {
    const call = vi.fn(async (_method, input) => result(input, content))
    const f = await fixture(reference(kind, content), call)
    await vi.waitFor(() => expect(f.host.querySelector(selector)?.textContent).toBe(expected))
    expect(f.host.querySelector('img')).toBeNull()
    expect(
      call.mock.calls.every(
        ([method, input]) =>
          method === '_agnes/v1/artifact.read' && input.sessionId === 'session-a' && input.laneId === 'lane',
      ),
    ).toBe(true)
  })

  it.each([401, 403, 410, 500])('renders safe failure text for status %s', async (status) => {
    const call = vi.fn(async () => ({
      ok: false,
      status,
      code: status === 410 ? 'artifact_reclaimed' : 'synthetic-private-credential/path',
    }))
    const f = await fixture(reference('image'), call)
    await vi.waitFor(() =>
      expect(f.host.querySelector('pre')?.textContent).toBe(
        status === 410 ? '截图已按保留策略清理' : '文档资源暂不可用',
      ),
    )
    expect(f.host.textContent).not.toContain('synthetic-private')
    expect(f.host.querySelector('img, iframe')).toBeNull()
  })

  it('loads PDF with the actual adapter into a titled sandbox and releases it on unmount', async () => {
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pdf')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const call = vi.fn(async (_method, input) => result(input, '%PDF'))
    // A detached DOM verifies the real frame/state; navigation is exercised in the live browser.
    const f = await fixture(reference('pdf', '%PDF'), call, { detached: true })
    await vi.waitFor(() => expect(f.host.querySelector('iframe')?.getAttribute('src')).toBe('blob:pdf'))
    expect(f.host.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
    expect(f.host.querySelector('iframe')?.title).toBe('Document')
    f.mount.dispose()
    expect(revoked).toHaveBeenCalledTimes(created.mock.calls.length)
    expect(f.host.querySelector('iframe')).toBeNull()
  })

  it('balances acquisitions on StrictMode replay and shows empty content without a resource', async () => {
    let serial = 0
    const created = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:strict-${++serial}`)
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const call = vi.fn(async (_method, input) => result(input, 'Loaded'))
    const f = await fixture(reference('image'), call, { strict: true })
    await vi.waitFor(() => expect(f.host.querySelector('img')).toBeTruthy())
    f.update({ id: 'empty', kind: 'text' })
    expect(f.host.querySelector('pre')?.textContent).toBe('')
    f.mount.dispose()
    expect(revoked).toHaveBeenCalledTimes(created.mock.calls.length)
    expect(new Set(revoked.mock.calls.map(([url]) => url)).size).toBe(created.mock.calls.length)
  })

  it('preserves loaded Markdown controls and focus when only the title changes', async () => {
    const content = '# Heading\n\n```js\nconst value = 1\n```'
    const initial = reference('markdown', content)
    const call = vi.fn(async (_method, input) => result(input, content))
    const f = await fixture(initial, call)
    await vi.waitFor(() => expect(f.host.querySelector('.code-copy')).toBeTruthy())
    const button = f.host.querySelector<HTMLButtonElement>('.code-copy')
    button?.focus()
    const reads = call.mock.calls.length
    f.update({ ...initial, title: 'Updated title' })
    expect(f.host.querySelector('.code-copy')).toBe(button)
    expect(document.activeElement).toBe(button)
    expect(f.host.querySelector('[data-document-preview]')?.getAttribute('aria-label')).toBe('Updated title')
    expect(call).toHaveBeenCalledTimes(reads)
  })

  it('rejects late content after a same-host document change and preserves current node identity', async () => {
    const pending: Array<() => void> = []
    const call = vi.fn(
      (_method, input) => new Promise((resolve) => pending.push(() => resolve(result(input, 'Loaded')))),
    )
    const f = await fixture(reference('text'), call)
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0))
    f.update({ id: 'B', kind: 'text', content: 'Current' })
    const node = f.host.querySelector('pre')
    expect(node?.textContent).toBe('Current')
    pending.forEach((finish) => {
      finish()
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(f.host.querySelector('pre')).toBe(node)
    expect(node?.textContent).toBe('Current')
    f.update({ id: 'B', kind: 'text', content: 'Continued' })
    expect(f.host.querySelector('pre')).toBe(node)
    expect(node?.textContent).toBe('Continued')
  })

  it('releases acquired and late image URLs across document/plugin replacement, return, and disposal', async () => {
    const pending: Array<() => void> = []
    let serial = 0
    const created = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:fixture-${++serial}`)
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const call = vi.fn(
      (_method, input) => new Promise((resolve) => pending.push(() => resolve(result(input, 'Loaded')))),
    )
    const f = await fixture(reference('image'), call)
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0))
    pending.splice(0).forEach((finish) => {
      finish()
    })
    await vi.waitFor(() => expect(f.host.querySelector('img')?.getAttribute('src')).toMatch(/^blob:fixture/))
    f.update(reference('image', 'Loaded', 'B'))
    expect(f.host.querySelector('img')).toBeNull()
    expect(revoked).toHaveBeenCalledTimes(created.mock.calls.length)
    const remove = f.slots.register(
      { name: 'sidebar.right.tab.document', key: 'image', id: 'shadow', owner: 'fixture', priority: -1 },
      () => createElement('button', { type: 'button' }, 'Plugin'),
    )
    await vi.waitFor(() => expect(f.host.querySelector('button')?.textContent).toBe('Plugin'))
    pending.splice(0).forEach((finish) => {
      finish()
    })
    await vi.waitFor(() => expect(revoked).toHaveBeenCalledTimes(created.mock.calls.length))
    expect(f.host.querySelector('img')).toBeNull()
    remove()
    await vi.waitFor(() => expect(pending.length).toBe(1))
    pending.splice(0).forEach((finish) => {
      finish()
    })
    await vi.waitFor(() => expect(f.host.querySelector('img')).toBeTruthy())
    f.mount.dispose()
    f.mount.dispose()
    expect(f.host.textContent).toBe('')
    expect(revoked).toHaveBeenCalledTimes(created.mock.calls.length)
    expect(new Set(revoked.mock.calls.map(([url]) => url)).size).toBe(created.mock.calls.length)
  })

  it('does not reuse a revoked resource when the same document object returns before reloading', async () => {
    const pending: Array<() => void> = []
    let serial = 0
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:cycle-${++serial}`)
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const call = vi.fn(
      (_method, input) => new Promise((resolve) => pending.push(() => resolve(result(input, 'Loaded')))),
    )
    const initial = reference('image')
    const f = await fixture(initial, call)
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0))
    for (const finish of pending.splice(0)) finish()
    await vi.waitFor(() => expect(f.host.querySelector('img')).toBeTruthy())
    const oldUrl = f.host.querySelector('img')?.getAttribute('src')
    f.update({ id: 'inline', kind: 'image' })
    expect(revoked.mock.calls.map(([url]) => url)).toContain(oldUrl)
    f.update(initial)
    expect(f.host.querySelector('img')).toBeNull()
    for (const finish of pending.splice(0)) finish()
    await vi.waitFor(() => expect(f.host.querySelector('img')).toBeTruthy())
    expect(f.host.querySelector('img')?.getAttribute('src')).not.toBe(oldUrl)
  })

  it('drops an old-session reply after B completes, survives session loss, and releases a late acquired URL on unmount', async () => {
    const pending: Array<{ sessionId: string; finish: () => void }> = []
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const call = vi.fn(
      (_method, input) =>
        new Promise((resolve) =>
          pending.push({ sessionId: input.sessionId, finish: () => resolve(result(input, 'Loaded')) }),
        ),
    )
    const f = await fixture(reference('image'), call)
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0))
    const old = pending.splice(0)
    f.session.setSession('session-b')
    await vi.waitFor(() => expect(pending.some((p) => p.sessionId === 'session-b')).toBe(true))
    pending.splice(0).forEach((p) => {
      p.finish()
    })
    await vi.waitFor(() => expect(f.host.querySelector('img')?.getAttribute('src')).toBe('blob:late'))
    old.forEach((p) => {
      p.finish()
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(created).toHaveBeenCalledTimes(1)
    expect(f.host.querySelector('img')?.getAttribute('src')).toBe('blob:late')
    f.session.setSession(undefined)
    await vi.waitFor(() => expect(f.host.querySelector('img')).toBeNull())
    expect(revoked).toHaveBeenCalledTimes(1)
    f.session.setSession('session-c')
    await vi.waitFor(() => expect(pending.length).toBe(1))
    f.mount.dispose()
    pending.splice(0).forEach((p) => {
      p.finish()
    })
    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(2))
    expect(revoked).toHaveBeenCalledTimes(2)
    expect(f.host.textContent).toBe('')
  })
  it('retires the actual client-module rightbar, drops a late acquisition, and remounts into the same host', async () => {
    const host = document.createElement('aside')
    document.body.append(host)
    let serial = 0
    const created = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:runtime-${++serial}`)
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const pending: Array<() => void> = []
    const call = vi.fn(
      (_method, input) => new Promise((resolve) => pending.push(() => resolve(result(input, 'Loaded')))),
    )
    const start = async () => {
      const runtime = await startClientModules({
        agnes: { call } as never,
        rosterSource: { list: async () => ({ revision: '', modules: [], statuses: [] }) },
        rightbarContainer: host,
      })
      runtimes.push(runtime)
      runtime.session.setSession('session-a')
      const doc = reference('image')
      runtime.registry.register(
        {
          name: 'sidebar.right.pane.tab',
          key: 'document',
          id: 'runtime-owner',
          owner: 'fixture',
          priority: -1,
        },
        () =>
          createElement(SlotOutlet, {
            name: 'sidebar.right.tab.document',
            entryKey: doc.kind,
            props: { owner: doc },
          }),
      )
      return runtime
    }
    const old = await start()
    await vi.waitFor(() => expect(pending.length).toBe(1))
    old.builtinUnits.unmount('@agnes/web-rightbar')
    expect(host.textContent).toBe('')
    await old.dispose()
    runtimes.pop()
    const late = pending.splice(0)
    const next = await start()
    await vi.waitFor(() => expect(pending.length).toBe(1))
    for (const finish of pending.splice(0)) finish()
    await vi.waitFor(() => expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:runtime-1'))
    for (const finish of late) finish()
    await vi.waitFor(() => expect(created).toHaveBeenCalledTimes(2))
    expect(revoked.mock.calls).toEqual([['blob:runtime-2']])
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:runtime-1')
    await next.dispose()
    runtimes.pop()
    expect(revoked.mock.calls).toEqual([['blob:runtime-2'], ['blob:runtime-1']])
    expect(host.textContent).toBe('')
  })
})
