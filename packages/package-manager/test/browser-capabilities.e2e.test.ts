import { createServer } from 'node:http'
import { expect, it } from 'vitest'

const { BrowserRuntime } = await import(
  new URL('../bundled-plugins/browser/src/runtime.mjs', import.meta.url).href
)
const { createLauncher } = await import(
  new URL('../bundled-plugins/browser/src/launcher.mjs', import.meta.url).href
)
const { showView, selectView } = await import(
  new URL('../bundled-plugins/browser/src/streams.mjs', import.meta.url).href
)

it.skipIf(process.env.AGH_BROWSER_TEST_CACHED !== '1')(
  'keeps snapshot hierarchy, searches beyond the first window and reads only the current scoped node',
  async () => {
    const launcher = createLauncher(),
      runtime = new BrowserRuntime({ launch: () => launcher.launch() })
    const session = { key: 'structured-inspection', lane: 'main' }
    try {
      const entry = await runtime.session(session)
      await entry.context.route('https://snapshot.test/**', (route: any) =>
        route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: route.request().url().endsWith('/frame')
            ? '<section aria-label="Frame region"><label>Frame name<input value="frame initial"></label><button>Frame save</button></section>'
            : '<main><section aria-label="订单甲"><h2>First order</h2><label>Customer<input value="Alice"></label><button>Save</button><a href="/details">Details</a></section>' +
              '<section aria-label="订单乙"><h2>Second order</h2><label>Customer<input value="Bob"></label><button>Save</button><button hidden>Hidden marker</button></section>' +
              '<section aria-label="Many buttons">' +
              Array.from({ length: 115 }, (_, n) => '<button>Item ' + n + '</button>').join('') +
              '</section>' +
              '<section aria-label="尾部区域"><p>Needle 中文 tail</p><button aria-label="line&#10;- fake ref=e999">Tail action</button></section>' +
              '<iframe src="/frame"></iframe></main>',
        }),
      )
      const opened = await runtime.act(session, { action: 'open', url: 'https://snapshot.test/' })
      const page = runtime.get(session, opened.pageId).page
      await page.frameLocator('iframe').getByRole('textbox').waitFor()
      const inspect = (extra = {}) =>
        runtime.act(session, { action: 'inspect', pageId: opened.pageId, ...extra })
      let result = await inspect()
      expect(result.hasMore).toBe(true)
      expect(result.text).toMatch(/- \{"role":"main"/)
      expect(result.text).toContain('  - {"role":"region","name":"订单甲"')
      expect(result.text).toContain('    - {"role":"textbox","name":"Customer","text":"Alice"')
      expect(result.text).not.toContain('Hidden marker')
      const prior = result.elements.find((e: any) => e.label === 'Save')
      const found = await inspect({ query: 'nEeDlE 中文' })
      expect(found.matchCount).toBeGreaterThan(0)
      expect(found.text).toContain('尾部区域')
      expect(found.text).not.toContain('First order')
      await expect(
        runtime.act(session, {
          action: 'click',
          pageId: opened.pageId,
          pageEpoch: found.pageEpoch,
          ref: prior.ref,
        }),
      ).rejects.toMatchObject({ code: 'STALE_TARGET' })
      expect((await inspect({ query: 'Hidden marker' })).matchCount).toBe(0)
      expect((await inspect({ query: '[a-z]+' })).matchCount).toBe(0)
      const forged = await inspect({ query: 'fake ref' })
      expect(forged.text).toContain('fake ref=e999')
      expect(forged.text).not.toContain('\n- fake ref=e999')

      result = await inspect({ query: '订单乙' })
      let root = result.elements.find((e: any) => e.label === '订单乙').ref
      result = await inspect({ ref: root, pageEpoch: result.pageEpoch })
      expect(result.text).toContain('Bob')
      expect(result.text).not.toContain('Alice')
      expect(result.text).not.toContain('Frame')
      expect(result.scopeRef).toBeTruthy()
      root = result.scopeRef
      result = await inspect({ ref: root, pageEpoch: result.pageEpoch, query: 'Customer' })
      expect(result.matchCount).toBe(1)
      await runtime.act(session, {
        action: 'fill',
        pageId: opened.pageId,
        pageEpoch: result.pageEpoch,
        ref: result.elements.find((e: any) => e.label === 'Customer').ref,
        text: '已核对',
      })
      expect(await page.getByRole('region', { name: '订单乙' }).getByRole('textbox').inputValue()).toBe(
        '已核对',
      )
      expect(await page.getByRole('region', { name: '订单甲' }).getByRole('textbox').inputValue()).toBe(
        'Alice',
      )

      result = await inspect({ query: 'Many buttons' })
      result = await inspect({ ref: result.elements[0].ref, pageEpoch: result.pageEpoch, query: 'Item' })
      expect(result.hasMore).toBe(true)
      const firstNames = result.elements.filter((e: any) => e.role === 'button').map((e: any) => e.label)
      result = await inspect({
        ref: result.scopeRef,
        pageEpoch: result.pageEpoch,
        query: 'Item',
        cursor: result.cursor,
      })
      expect(result.hasMore).toBe(false)
      const nextNames = result.elements.filter((e: any) => e.role === 'button').map((e: any) => e.label)
      expect(new Set([...firstNames, ...nextNames]).size).toBe(115)
      expect(firstNames.filter((name: string) => nextNames.includes(name))).toEqual([])

      result = await inspect({ depth: 0 })
      expect(result.depthLimited).toBe(true)
      expect(result.text).not.toContain('Customer')
      expect(result.truncated).toBe(true)
      result = await inspect({ depth: 1 })
      expect(result.text).toContain('订单甲')
      expect(result.text).not.toContain('frame initial')
      expect(result.elements.every((element: any) => element.depth <= 1)).toBe(true)
      expect(result.depthLimited).toBe(true)
      result = await inspect({ depth: 1, query: 'Frame name' })
      expect(result.matchCount).toBe(0)
      expect(result.depthLimited).toBe(true)
      result = await inspect({ query: '订单乙' })
      result = await inspect({ ref: result.elements[0].ref, pageEpoch: result.pageEpoch, depth: 0 })
      expect(result.elements).toHaveLength(1)
      expect(result.scopeRef).toBe(result.elements[0].ref)
      expect(result.depthLimited).toBe(true)
      expect(result.text).not.toContain('Bob')
      result = await inspect({ query: '订单甲' })
      const replacedRef = result.elements[0].ref
      await page.getByRole('region', { name: '订单甲' }).evaluate((element: HTMLElement) => {
        element.replaceWith(element.cloneNode(true))
      })
      await expect(inspect({ ref: replacedRef, pageEpoch: result.pageEpoch })).rejects.toMatchObject({
        code: 'STALE_TARGET',
      })
      result = await inspect({ query: 'Frame region' })
      result = await inspect({ ref: result.elements[0].ref, pageEpoch: result.pageEpoch })
      expect(result.text).toContain('frame initial')
      expect(result.text).not.toContain('订单')
      const stale = result.scopeRef,
        staleEpoch = result.pageEpoch
      await page.frames()[1].goto('https://snapshot.test/frame?replacement')
      await expect(inspect({ ref: stale, pageEpoch: staleEpoch })).rejects.toMatchObject({
        code: 'STALE_TARGET',
      })
      await expect(inspect({ query: '   ' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(inspect({ depth: -1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(
        runtime.act({ key: 'foreign', lane: 'main' }, { action: 'inspect', pageId: opened.pageId }),
      ).rejects.toMatchObject({ code: 'PAGE_UNAVAILABLE' })
      await page.setContent('<table><caption>Table title</caption><tr><td>Cell</td></tr></table>')
      expect((await inspect({ depth: 0 })).text).toContain('Table title')
      // Native shallow names must not change search's established match scope.
      expect((await inspect({ depth: 0, query: 'Table title' })).matchCount).toBe(0)
      expect((await inspect({ depth: 1, query: 'Table title' })).matchCount).toBe(1)
      await page.setContent('<button>Leaf</button>')
      expect(await inspect({ depth: 0 })).toMatchObject({ depthLimited: false, truncated: false })
    } finally {
      await runtime.close()
    }
  },
)

it.skipIf(process.env.AGH_BROWSER_TEST_CACHED !== '1').each(['http', 'https'])(
  'starts real PCM promptly on %s and preserves sound across viewport changes',
  async (protocol) => {
    const wave = Buffer.alloc(44 + 16000)
    wave.write('RIFF')
    wave.writeUInt32LE(wave.length - 8, 4)
    wave.write('WAVEfmt ', 8)
    wave.writeUInt32LE(16, 16)
    wave.writeUInt16LE(1, 20)
    wave.writeUInt16LE(1, 22)
    wave.writeUInt32LE(8000, 24)
    wave.writeUInt32LE(16000, 28)
    wave.writeUInt16LE(2, 32)
    wave.writeUInt16LE(16, 34)
    wave.write('data', 36)
    wave.writeUInt32LE(16000, 40)
    for (let n = 0; n < 8000; n++)
      wave.writeInt16LE(Math.round(Math.sin((n * Math.PI * 440) / 4000) * 12000), 44 + n * 2)
    const launcher = createLauncher(),
      runtime = new BrowserRuntime({ launch: () => launcher.launch() })
    const session = { key: 'audio-origin', lane: 'main' },
      viewer = new AbortController()
    const actor = { id: 'audio-viewer' }
    const url = protocol + '://audio-fixture.test/'
    let audible = false
    try {
      const entry = await runtime.session(session)
      // Fulfill a synthetic origin locally: HTTP must remain an insecure context.
      await entry.context.route(url, (route: any) =>
        route.fulfill({
          contentType: 'text/html',
          headers: { 'Permissions-Policy': 'speaker-selection=()' },
          body: `<audio loop src="data:audio/wav;base64,${wave.toString('base64')}"></audio>`,
        }),
      )
      const opened = await runtime.act(session, { action: 'open', url })
      const page = runtime.get(session, opened.pageId).page
      expect(await page.evaluate(() => isSecureContext)).toBe(protocol === 'https')
      const audioStarted = performance.now()
      await showView(
        runtime,
        { pageId: opened.pageId, viewId: 'audio-view', displayVersion: 2 },
        {
          actor,
          scope: { kind: 'session', sessionId: session.key, laneId: 'main' },
          signal: viewer.signal,
          stream: {
            send(value: Uint8Array) {
              const bytes = Buffer.from(value),
                size = bytes.readUInt32BE()
              if (JSON.parse(bytes.subarray(4, size + 4).toString()).media === 'audio')
                audible ||= bytes.subarray(size + 4).some((byte) => byte !== 0)
              return 'accepted'
            },
            close() {},
            onDisconnect() {},
          },
        },
      )
      await page.locator('audio').evaluate((audio: HTMLMediaElement) => audio.play())
      await expect.poll(() => audible, { timeout: 5000 }).toBe(true)
      // Include initialization: a running AudioContext can retain a failed
      // device after Chromium's own authorization timeout and never tick.
      expect(performance.now() - audioStarted).toBeLessThan(5000)
      await selectView(
        runtime,
        {
          viewId: 'audio-view',
          pageId: opened.pageId,
          sequence: 1,
          viewport: { width: 640, height: 480 },
        },
        { session, actor },
      )
      audible = false
      await expect.poll(() => audible, { timeout: 5000 }).toBe(true)
    } finally {
      viewer.abort()
      await runtime.close()
    }
  },
)

it.skipIf(process.env.AGH_BROWSER_TEST_CACHED !== '1')(
  'blocks every redirect hop in pages, frames and workers while preserving allowed redirects',
  async () => {
    let forbidden = 0
    const website = createServer((request, response) => {
      const path = new URL(request.url!, 'http://fixture').pathname
      if (path.startsWith('/__agnes')) {
        forbidden++
        response.end('protected')
        return
      }
      if (path.endsWith('/first') || path.endsWith('/second')) {
        response.writeHead(302, {
          location: path.endsWith('/first') ? path.replace('/first', '/second') : '/__agnes/blocked',
        })
        response.end()
        return
      }
      if (path === '/allowed') {
        response.writeHead(302, { location: '/final' })
        response.end()
        return
      }
      if (path === '/worker.js') {
        response.setHeader('Content-Type', 'application/javascript')
        response.end("fetch('/worker/first').then(()=>postMessage('bad'),()=>postMessage('blocked'))")
        return
      }
      if (path === '/shared.js') {
        response.setHeader('Content-Type', 'application/javascript')
        response.end(`onconnect=e=>{
          const port=e.ports[0];
          fetch('/shared/first').then(()=>port.postMessage('bad'),()=>port.postMessage('shared-blocked'));
          fetch('/allowed').then(r=>port.postMessage(r.url.endsWith('/final')?'shared-allowed':'bad'));
        }`)
        return
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      if (path === '/frame') {
        response.end(
          "<script>fetch('/frame/first').then(()=>parent.postMessage('bad','*'),()=>parent.postMessage('frame-blocked','*'))</script>",
        )
        return
      }
      response.end(`<button>Final page</button><script>
      window.messages=[];onmessage=e=>messages.push(e.data);
      const worker=new Worker('/worker.js');worker.onmessage=e=>messages.push(e.data);
      window.shared=new SharedWorker('/shared.js');shared.port.onmessage=e=>messages.push(e.data);
      fetch('/fetch/first').then(()=>messages.push('bad'),()=>messages.push('fetch-blocked'));
      </script><iframe src="http://localhost:${(website.address() as { port: number }).port}/frame"></iframe>`)
    })
    await new Promise<void>((resolve) => website.listen(0, resolve))
    const origin = `http://127.0.0.1:${(website.address() as { port: number }).port}`
    const launcher = createLauncher(),
      runtime = new BrowserRuntime({ launch: () => launcher.launch() })
    const session = { key: 'redirects', lane: 'main' }
    try {
      const opened = await runtime.act(session, { action: 'open', url: origin + '/allowed' })
      const page = runtime.get(session, opened.pageId).page
      expect(page.url()).toBe(origin + '/final')
      await expect
        .poll(() => page.evaluate(() => (window as any).messages.sort()))
        .toEqual(['blocked', 'fetch-blocked', 'frame-blocked', 'shared-allowed', 'shared-blocked'])
      const popupPromise = page.waitForEvent('popup')
      await page.evaluate(() => {
        window.open('/popup/first')
      })
      const popup = await popupPromise
      await expect.poll(() => popup.url()).not.toBe('about:blank')
      await popup.close()
      // Popup capacity may close a target while its guard is being installed.
      // That must not tear down the other owned pages or their browser.
      for (let index = 0; index < 5; index++)
        await page.evaluate(() => {
          window.open('about:blank')
        })
      await expect.poll(() => runtime.list(session).length).toBe(3)
      expect(await page.getByRole('button', { name: 'Final page' }).count()).toBe(1)
      await expect(
        runtime.act(session, { action: 'open', pageId: opened.pageId, url: origin + '/navigation/first' }),
      ).rejects.toThrow()
      expect(forbidden).toBe(0)
    } finally {
      await runtime.close()
      await new Promise<void>((resolve) => website.close(() => resolve()))
    }
  },
)

it.skipIf(process.env.AGH_BROWSER_TEST_CACHED !== '1')(
  'observes visible controls and frames, performs bounded actions and requires exact upload consent',
  async () => {
    const website = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      if (request.url === '/frame' || request.url === '/replacement') {
        response.end('<label>Frame input<input></label>')
        return
      }
      response.end(`
      ${'<button hidden>Invisible</button>'.repeat(110)}
      <label>Name<input></label><label>Color<select><option value="red">Red</option><option value="blue">Blue</option></select></label>
      <label>Upload<input type="file"></label>
      <button onmouseenter="this.dataset.hovered='yes'">Hover</button>
      <div role="button" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','payload')">Source</div>
      <div role="button" ondragover="event.preventDefault()" ondrop="event.preventDefault();this.dataset.dropped=event.dataTransfer.getData('text/plain')">Target</div>
      <button onclick="this.dataset.answer=confirm('Proceed?')">Confirm</button>
      <iframe src="http://localhost:${(website.address() as { port: number }).port}/frame"></iframe>`)
    })
    await new Promise<void>((resolve) => website.listen(0, resolve))
    const launcher = createLauncher(),
      runtime = new BrowserRuntime({ launch: () => launcher.launch() })
    const session = { key: 'actions', lane: 'main' }
    try {
      const opened = await runtime.act(session, {
        action: 'open',
        url: `http://127.0.0.1:${(website.address() as { port: number }).port}/`,
      })
      const page = runtime.get(session, opened.pageId).page
      await page.frameLocator('iframe').getByRole('textbox').waitFor()
      const inspect = () => runtime.act(session, { action: 'inspect', pageId: opened.pageId })
      const action = async (name: string, label: string, extra = {}, access?: object) => {
        const snapshot = await inspect()
        const element = snapshot.elements.find((element: any) => element.label === label)
        expect(element, JSON.stringify(snapshot)).toBeTruthy()
        return runtime.act(
          session,
          { action: name, pageId: opened.pageId, pageEpoch: snapshot.pageEpoch, ref: element.ref, ...extra },
          undefined,
          access,
        )
      }
      const observed = await inspect()
      expect(observed.elements.some((element: any) => element.label === 'Invisible')).toBe(false)
      await action('fill', 'Name', { text: '中文 Mac/Windows' })
      await action('fill', 'Frame input', { text: 'frame value' })
      expect(await page.frameLocator('iframe').getByRole('textbox').inputValue()).toBe('frame value')
      const old = await inspect(),
        oldRef = old.elements.find((element: any) => element.label === 'Frame input').ref
      await page
        .frames()[1]
        .goto(`http://localhost:${(website.address() as { port: number }).port}/replacement`)
      await expect(
        runtime.act(session, {
          action: 'fill',
          pageId: opened.pageId,
          pageEpoch: runtime.describe(runtime.get(session, opened.pageId)).pageEpoch,
          ref: oldRef,
          text: 'wrong',
        }),
      ).rejects.toMatchObject({ code: 'STALE_TARGET' })
      await action('hover', 'Hover')
      expect(
        await page.getByRole('button', { name: 'Hover', exact: true }).getAttribute('data-hovered'),
      ).toBe('yes')
      const drag = await inspect()
      await runtime.act(session, {
        action: 'drag',
        pageId: opened.pageId,
        pageEpoch: drag.pageEpoch,
        ref: drag.elements.find((e: any) => e.label === 'Source').ref,
        targetRef: drag.elements.find((e: any) => e.label === 'Target').ref,
      })
      expect(
        await page.getByRole('button', { name: 'Target', exact: true }).getAttribute('data-dropped'),
      ).toBe('payload')
      // Exercise the workbench's pointer path against real HTML drag-and-drop too.
      await page.getByRole('button', { name: 'Target', exact: true }).evaluate((element: HTMLElement) => {
        delete element.dataset.dropped
      })
      const actor = { id: 'viewer' }
      const grant = await runtime.control(session, { pageId: opened.pageId, mode: 'human' }, actor)
      const source = await page.getByRole('button', { name: 'Source', exact: true }).boundingBox()
      const target = await page.getByRole('button', { name: 'Target', exact: true }).boundingBox()
      for (const [seq, phase, box] of [
        [0, 'down', source],
        [1, 'move', target],
        [2, 'up', target],
      ] as const) {
        await runtime.humanInput(
          session,
          {
            ...grant,
            type: 'pointer',
            gesture: 'real-drag',
            seq,
            phase,
            x: box!.x + box!.width / 2,
            y: box!.y + box!.height / 2,
          },
          actor,
        )
      }
      expect(
        await page.getByRole('button', { name: 'Target', exact: true }).getAttribute('data-dropped'),
      ).toBe('payload')
      await runtime.control(session, { pageId: opened.pageId, mode: 'agent' }, actor)
      await action('select', 'Color', { values: ['blue'] })
      expect(await page.getByRole('combobox').inputValue()).toBe('blue')
      await action('click', 'Confirm', {
        dialog: { type: 'confirm', message: 'Proceed?', response: 'accept' },
      })
      expect(
        await page.getByRole('button', { name: 'Confirm', exact: true }).getAttribute('data-answer'),
      ).toBe('true')
      await action('click', 'Confirm', {
        dialog: { type: 'confirm', message: 'Different question', response: 'accept' },
      })
      expect(
        await page.getByRole('button', { name: 'Confirm', exact: true }).getAttribute('data-answer'),
      ).toBe('false')
      const payload = Buffer.from('synthetic upload')
      let approved = false,
        question: any
      const access = {
        root: process.cwd(),
        files: { stat: async () => ({ kind: 'file', size: payload.length }), read: async () => payload },
        decisions: {
          request: async (spec: any) => {
            question = spec
            return { id: 'question' }
          },
          wait: async () => ({
            status: 'resolved',
            snapshot: {
              result: {
                reason: 'answered',
                answeredBy: { id: 'human', role: 'user' },
                response: { option: approved ? 'Upload this file' : 'Cancel' },
              },
            },
          }),
        },
      }
      await expect(action('upload', 'Upload', { path: 'synthetic.txt' }, access)).rejects.toMatchObject({
        code: 'UPLOAD_REJECTED',
      })
      expect(
        await page.locator('input[type=file]').evaluate((element: HTMLInputElement) => element.files!.length),
      ).toBe(0)
      approved = true
      await action('upload', 'Upload', { path: 'synthetic.txt' }, access)
      expect(question.purpose).toBe('browser.upload.confirm')
      expect(
        await page
          .locator('input[type=file]')
          .evaluate((element: HTMLInputElement) => element.files?.[0]?.type),
      ).toBe('text/plain')
      expect(
        await page
          .locator('input[type=file]')
          .evaluate((element: HTMLInputElement) => element.files![0]!.text()),
      ).toBe('synthetic upload')
    } finally {
      await runtime.close()
      await new Promise<void>((resolve) => website.close(() => resolve()))
    }
  },
)
