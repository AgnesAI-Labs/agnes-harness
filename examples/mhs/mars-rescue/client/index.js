import { createElement as h, useEffect, useRef, useState } from 'react'
import { createMarsExampleAccess } from './generated/browser-transport.js'
import { MarsCameras } from './generated/cameras.js'
import { MarsRuntime } from './generated/runtime.js'
import { MarsScene, VIEWS } from './generated/scene.js'

const PACKAGE = '@agnes-example/mars-rescue'
/** The child profile facade consumes an explicitly reviewed parent producer grant. No browser URL fallback. */
export function apply(ctx) {
  ctx.provide('mhsExampleAccess', createMarsExampleAccess(ctx.profile.streams))
  let cameras,
    captureTimer,
    releaseLock,
    disposed = false,
    starting,
    intent = 0,
    unavailable = 'Enable the reviewed MHS example device connection to start.'
  const lifetime = new AbortController()
  const hosts = new WeakSet()
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
  const runtime = new MarsRuntime(
    {
      connect: (device, signal) => {
        assertLive()
        const currentAccess = ctx.get('mhsExampleAccess', false)
        if (typeof currentAccess?.connect !== 'function') throw new Error('example-connection-unavailable')
        return currentAccess.connect(PACKAGE, device, signal)
      },
    },
    typeof VideoEncoder !== 'undefined',
  )
  runtime.subscribe(notify)
  const start = () =>
    (starting ??= (async () => {
      const attempt = ++intent
      try {
        assertLive()
        const access = ctx.get('mhsExampleAccess', false)
        if (!access || typeof access.connect !== 'function')
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
        cameras ??= new MarsCameras(runtime.simulation, document)
        await cameras.capture(performance.now())
        if (cameras.error) throw new Error('camera-renderer-unavailable')
        assertLive()
        if (attempt !== intent) throw new Error('example-start-cancelled')
        await runtime.start()
        assertLive()
        if (attempt !== intent) throw new Error('example-start-cancelled')
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
        }, 50)
        unavailable = undefined
      } catch {
        await runtime?.stop().catch(() => {})
        cameras?.dispose()
        cameras = undefined
        release()
        unavailable = 'Device connection unavailable. Review the parent MHS connection, then retry.'
      }
      notify()
    })().finally(() => {
      starting = undefined
    }))
  const stop = async () => {
    intent++
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
    lifetime.abort()
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
  ctx.effect(() => {
    void start()
  })

  const presentation = {
    getSnapshot: () => {
      const state = runtime.snapshot()
      return {
        state: state.status === 'ready' ? 'running' : state.status,
        connected: state.online.length,
        total: 11,
      }
    },
    subscribe: runtime.subscribe,
    stop,
  }
  function Page({ context }) {
    const host =
      context?.data?.kind === 'agnes.mhs-example-scene/v1' &&
      context.data.exampleId === PACKAGE &&
      context.data.profileId === ctx.module.binding?.profileId
        ? context.data
        : undefined
    useEffect(() => {
      if (!host || hosts.has(host.bindRuntime)) return
      const release = host.bindRuntime(presentation, lifetime.signal)
      hosts.add(host.bindRuntime)
      // The profile owns this binding. Detaching the scene never stops the fleet.
      ctx.effect(() => release)
    }, [host?.bindRuntime])
    const [, update] = useState(0),
      canvas = useRef(null),
      renderer = useRef(null),
      [view, setView] = useState(0),
      [tags, setTags] = useState(true),
      [map, setMap] = useState(true),
      [error, setError] = useState(''),
      [attempt, setAttempt] = useState(0),
      [busy, setBusy] = useState(false),
      [quality, setQuality] = useState('high'),
      [time, setTime] = useState(12),
      [ao, setAo] = useState(true),
      [bloom, setBloom] = useState(true),
      [fps, setFps] = useState(0),
      [stats, setStats] = useState(new URLSearchParams(location.search).has('stats'))
    useEffect(() => {
      const changed = () => update((n) => n + 1)
      listeners.add(changed)
      return () => listeners.delete(changed)
    }, [])
    const snapshot = runtime?.snapshot()
    useEffect(() => {
      const scene = renderer.current
      if (scene) Object.assign(scene, { quality, time, ao, bloom })
    }, [quality, time, ao, bloom])
    useEffect(() => {
      if (!canvas.current || !runtime) return
      let scene,
        frame,
        disposed = false
      try {
        scene = new MarsScene(canvas.current, runtime.simulation)
        scene.view = view
        Object.assign(scene, { quality, time, ao, bloom })
        renderer.current = scene
        setError('')
        let count = 0,
          since = performance.now()
        const draw = () => {
          count++
          if (performance.now() - since >= 1000) {
            setFps((count * 1000) / (performance.now() - since))
            count = 0
            since = performance.now()
          }
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
      if (!host) throw new Error('example-scene-host-unavailable')
      host.launch(id)
    }
    const keyDown = (event) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        event.target.isContentEditable
      )
        return
      if (/^[0-9]$/.test(event.key)) {
        setView(event.key === '0' ? 9 : Number(event.key) - 1)
        event.preventDefault()
      }
      if (event.key.toLowerCase() === 'l') setTags((v) => !v)
      if (event.key.toLowerCase() === 'm') setMap((v) => !v)
      if (event.key.toLowerCase() === 'r') {
        renderer.current?.resetView()
        event.preventDefault()
      }
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
        { className: 'mars-rescue-controls' },
        h(
          'label',
          null,
          'Quality ',
          h(
            'select',
            { value: quality, onChange: (e) => setQuality(e.target.value) },
            h('option', { value: 'low' }, 'Low'),
            h('option', { value: 'high' }, 'High'),
          ),
        ),
        h(
          'label',
          null,
          'Time ',
          h('input', {
            type: 'range',
            min: 0,
            max: 24,
            value: time,
            onChange: (e) => setTime(Number(e.target.value)),
          }),
        ),
        h(
          'label',
          null,
          h('input', { type: 'checkbox', checked: ao, onChange: (e) => setAo(e.target.checked) }),
          'Ambient occlusion',
        ),
        h(
          'label',
          null,
          h('input', { type: 'checkbox', checked: bloom, onChange: (e) => setBloom(e.target.checked) }),
          'Bloom',
        ),
        h(
          'label',
          null,
          h('input', { type: 'checkbox', checked: stats, onChange: (e) => setStats(e.target.checked) }),
          'Stats',
        ),
        stats && h('output', null, `${fps.toFixed(0)} FPS`),
        button('R · Reset view', () => renderer.current?.resetView()),
      ),
      h(
        'div',
        { className: 'mars-rescue-scene' },
        h('canvas', {
          ref: canvas,
          width: 960,
          height: 540,
          tabIndex: 0,
          'aria-label':
            '3D Mars base. Keys 1–9 and 0 change views; L labels; M map; R resets. Drag to orbit; wheel to zoom.',
          onPointerDown: (e) => {
            e.currentTarget.focus()
            e.currentTarget.setPointerCapture(e.pointerId)
          },
          onPointerMove: (e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              renderer.current?.orbit(e.movementX * 0.005, e.movementY * 0.005)
          },
          onPointerUp: (e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId)
          },
          onWheel: (e) => renderer.current?.zoom(e.deltaY * 0.001),
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
        'Keys 1–9 / 0: views · L: device labels · M: map · R: reset view · Drag: orbit · Wheel: zoom. Leaving this view keeps the example running; Stop disconnects this fleet.',
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
