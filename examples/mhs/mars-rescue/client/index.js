import { createElement as h, useEffect, useRef, useState } from 'react'
import { MarsCameras } from './generated/cameras.js'
import { MarsRuntime } from './generated/runtime.js'
import { MarsScene, VIEWS } from './generated/scene.js'

const PACKAGE = '@agnes-example/mars-rescue'
/** Parent MHS supplies an explicitly reviewed, owner-bound connector. No browser URL fallback. */
export function apply(ctx) {
  let runtime,
    cameras,
    captureTimer,
    releaseLock,
    disposed = false,
    unavailable = 'Enable the reviewed MHS example device connection to start.'
  const listeners = new Set()
  const notify = () => {
    for (const fn of listeners) fn()
  }
  const release = () => {
    releaseLock?.()
    releaseLock = undefined
  }
  const assertLive = () => {
    if (disposed || ctx.availability.getSnapshot()?.availability !== 'active')
      throw new Error('example-revoked')
  }
  const start = async () => {
    try {
      assertLive()
      const access = ctx.get('mhsExampleAccess', false)
      if (!access || typeof access.connect !== 'function' || typeof access.launch !== 'function')
        throw new Error('E_MARS_REVIEWED_DEVICE_TRANSPORT_REQUIRED')
      if (!releaseLock) {
        if (!navigator.locks || !ctx.module.binding?.profileId) throw new Error('profile-lock-unavailable')
        await new Promise((resolve, reject) => {
          void navigator.locks
            .request(`agnes:mars:${ctx.module.binding.profileId}`, { ifAvailable: true }, async (lock) => {
              if (!lock) {
                reject(new Error('example-running-in-another-tab'))
                return
              }
              await new Promise((release) => {
                releaseLock = release
                resolve()
              })
            })
            .catch(reject)
        })
      }
      if (!runtime) {
        runtime = new MarsRuntime(
          {
            connect: (device, signal) => {
              assertLive()
              const currentAccess = ctx.get('mhsExampleAccess', false)
              if (typeof currentAccess?.connect !== 'function')
                throw new Error('example-connection-unavailable')
              return currentAccess.connect(PACKAGE, device, signal)
            },
          },
          typeof VideoEncoder !== 'undefined',
        )
        runtime.subscribe(notify)
      }
      cameras ??= new MarsCameras(runtime.simulation, document)
      await cameras.capture(performance.now())
      if (cameras.error) throw new Error('camera-renderer-unavailable')
      assertLive()
      await runtime.start()
      assertLive()
      clearInterval(captureTimer)
      captureTimer = setInterval(() => {
        if (runtime.snapshot().status !== 'ready') {
          clearInterval(captureTimer)
          cameras?.dispose()
          cameras = undefined
          release()
          notify()
          return
        }
        void cameras.capture(performance.now()).then(notify)
      }, 100)
      unavailable = undefined
    } catch {
      await runtime?.stop().catch(() => {})
      cameras?.dispose()
      cameras = undefined
      release()
      unavailable = 'Device connection unavailable. Review the parent MHS connection, then retry.'
    }
    notify()
  }
  const stop = async () => {
    clearInterval(captureTimer)
    await runtime?.stop()
    cameras?.dispose()
    cameras = undefined
    release()
    notify()
  }
  const exit = () => {
    void stop().catch(() => {})
  }
  window.addEventListener('pagehide', exit)
  ctx.effect(() => () => {
    disposed = true
    window.removeEventListener('pagehide', exit)
    release()
    clearInterval(captureTimer)
    cameras?.dispose()
    void runtime?.stop().catch(() => {})
  })
  const bindingChanged = () => {
    const binding = ctx.availability.getSnapshot()
    if (binding?.availability !== 'active') {
      disposed = true
      clearInterval(captureTimer)
      cameras?.dispose()
      cameras = undefined
      release()
      void runtime?.stop().catch(() => {})
    }
  }
  ctx.effect(() => ctx.availability.subscribe(bindingChanged))
  ctx.examplePages.register({ id: 'mars-rescue', component: Page })

  function Page() {
    const [, update] = useState(0),
      canvas = useRef(null),
      renderer = useRef(null),
      [view, setView] = useState(0),
      [tags, setTags] = useState(true),
      [map, setMap] = useState(true),
      [error, setError] = useState(''),
      [attempt, setAttempt] = useState(0),
      [busy, setBusy] = useState(false)
    useEffect(() => {
      const changed = () => update((n) => n + 1)
      listeners.add(changed)
      return () => listeners.delete(changed)
    }, [])
    const snapshot = runtime?.snapshot()
    useEffect(() => {
      if (!canvas.current || !runtime) return
      let scene,
        frame,
        disposed = false
      try {
        scene = new MarsScene(canvas.current, runtime.simulation)
        scene.view = view
        renderer.current = scene
        setError('')
        const draw = () => {
          if (disposed) return
          try {
            scene.render()
            frame = requestAnimationFrame(draw)
          } catch {
            setError('Scene unavailable. Retry WebGL.')
            scene.dispose()
          }
        }
        draw()
      } catch {
        setError('WebGL unavailable. Retry on a WebGL-capable browser.')
      }
      return () => {
        disposed = true
        cancelAnimationFrame(frame)
        scene?.dispose()
        renderer.current = null
      }
    }, [view, snapshot?.status, attempt])
    const act = async (fn) => {
      setBusy(true)
      setError('')
      try {
        await fn()
      } catch {
        setError('Operation failed or outcome unknown. Inspect MHS Activity before retrying.')
      } finally {
        setBusy(false)
      }
    }
    const launch = async (id) => {
      assertLive()
      if (runtime?.snapshot().status !== 'ready') throw new Error('example-unavailable')
      const access = ctx.get('mhsExampleAccess', false)
      // Keep the operation id across retries, including an uncertain response.
      const key = `mars.launch.${ctx.module.binding.profileId}.${ctx.module.binding.activationId}.${id}`,
        operationId = sessionStorage.getItem(key) ?? crypto.randomUUID()
      sessionStorage.setItem(key, operationId)
      const launched = await access.launch(PACKAGE, id, operationId)
      if (typeof launched?.sessionId !== 'string' || !launched.sessionId)
        throw new Error('launch-outcome-unknown')
      sessionStorage.removeItem(key)
    }
    const keyDown = (event) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target.isContentEditable
      )
        return
      if (/^[0-9]$/.test(event.key)) {
        setView(event.key === '0' ? 9 : Number(event.key) - 1)
        event.preventDefault()
      }
      if (event.key.toLowerCase() === 'l') setTags((v) => !v)
      if (event.key.toLowerCase() === 'm') setMap((v) => !v)
    }
    const button = (text, fn, disabled = false) =>
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            void act(fn)
          },
          disabled: busy || disabled,
        },
        text,
      )
    return h(
      'section',
      { className: 'mars-rescue', 'aria-label': 'Mars rescue simulation', onKeyDown: keyDown },
      h('h2', null, '火星救援 · Mars rescue'),
      h('p', null, 'Simulation · 11 devices · movement requires MHS approval'),
      h(
        'p',
        { role: 'status' },
        unavailable ?? `${snapshot?.status}: ${snapshot?.online.length ?? 0}/11 online`,
        cameras?.error ? ` · ${cameras.error}` : '',
      ),
      h(
        'div',
        { className: 'mars-rescue-controls' },
        button('Start / Retry connection', start),
        button('Stop example', stop, !runtime),
        button('Reset simulation', () => runtime.reset(), snapshot?.status !== 'ready'),
        button('Retry cameras', () => {
          cameras?.retry()
          setAttempt((n) => n + 1)
        }),
        button('Rescue Agent', () => launch('rescue'), snapshot?.status !== 'ready'),
        button('Sample Agent', () => launch('sample'), snapshot?.status !== 'ready'),
      ),
      error && h('p', { role: 'alert' }, error),
      h(
        'label',
        null,
        'View ',
        h(
          'select',
          { value: view, onChange: (e) => setView(Number(e.target.value)) },
          ...VIEWS.map((name, i) => h('option', { key: name, value: i }, `${i === 9 ? 0 : i + 1} · ${name}`)),
        ),
      ),
      h(
        'div',
        { className: 'mars-rescue-scene' },
        h('canvas', {
          ref: canvas,
          width: 960,
          height: 540,
          tabIndex: 0,
          'aria-label': '3D Mars base. Keys 1–9 and 0 change views; L toggles labels; M toggles map.',
        }),
        tags &&
          h(
            'svg',
            { className: 'mars-rescue-tags', viewBox: '0 0 960 540', 'aria-hidden': true },
            ...(snapshot?.devices ?? []).flatMap((device) => {
              const p = renderer.current?.project(device.pose)
              return p ? [h('text', { key: device.id, x: p.x, y: p.y }, device.id)] : []
            }),
          ),
      ),
      h(
        'p',
        null,
        'Keys 1–9 / 0: views · L: device labels · M: map. Leaving this view keeps the example running; Stop disconnects this fleet.',
      ),
      tags &&
        h(
          'ul',
          { className: 'mars-rescue-devices' },
          ...(snapshot?.devices ?? []).map((d) =>
            h('li', { key: d.id }, `${d.id}: ${d.state.mode ?? 'monitoring'}`),
          ),
        ),
      map &&
        h(
          'svg',
          {
            className: 'mars-rescue-map',
            viewBox: '-80 -80 160 160',
            role: 'img',
            'aria-label': 'Base map in metres east and north of habitat',
          },
          ...Array.from({ length: 15 }, (_, i) => (i - 7) * 10).flatMap((n) => [
            h('path', {
              key: `grid-${n}`,
              d: `M ${n} -80 V 80 M -80 ${n} H 80`,
              className: 'mars-rescue-grid',
            }),
            h('text', { key: `tick-${n}`, x: n, y: 78 }, n),
          ]),
          ...(snapshot?.devices ?? []).map((d) =>
            h(
              'g',
              { key: d.id, transform: `translate(${d.pose.x},${-d.pose.y})` },
              h('circle', { r: 1.5 }),
              h('text', { x: 2, y: -2 }, d.id),
            ),
          ),
        ),
    )
  }
}
