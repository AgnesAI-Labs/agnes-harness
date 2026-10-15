import { Button, Tooltip } from '@agnes/web-ui'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type Axis, ManualController, manualKey, roleKeys } from './manual.js'
import { array, type Device, jsonText, number, record, text } from './model.js'
import { ActionFeedback, useAction, useMhs } from './react.js'

export function Drive({ device }: { device: Device }) {
  const { client, t } = useMhs(),
    action = useAction(),
    stopAction = useAction(),
    [controller, setController] = useState<ManualController>(),
    [failure, setFailure] = useState(false)
  const stopRunner = useRef(stopAction.run)
  stopRunner.current = stopAction.run
  const current = useRef<ManualController>(),
    opening = useRef(false)
  const declarationKey = jsonText(device.manual)
  const axes = useMemo(
    (): Axis[] =>
      array(record(JSON.parse(declarationKey)).axes).map((v) => {
        const a = record(v)
        return {
          id: text(a.id),
          min: number(a.min),
          max: number(a.max),
          ...(text(a.role) ? { role: text(a.role) } : {}),
        }
      }),
    [declarationKey],
  )
  const rate = number(device.manual.rate_hz, 30)
  const consumed = useRef(new Set<string>())
  // biome-ignore lint/correctness/useExhaustiveDependencies: A declaration revision invalidates the current device lease.
  useEffect(() => {
    const receipt = action.receipt
    if (
      receipt?.state !== 'completed' ||
      opening.current ||
      current.current ||
      !device.available ||
      consumed.current.has(receipt.operationId)
    )
      return
    consumed.current.add(receipt.operationId)
    const output = record(receipt.output),
      leaseId = text(output.leaseId ?? output.operationId),
      expiresAt = number(output.expiresAt ?? output.until)
    if (!leaseId || expiresAt <= Date.now()) {
      setFailure(true)
      return
    }
    opening.current = true
    const abort = new AbortController()
    void client
      .stream('control', { device: device.id, leaseId }, () => {}, abort.signal, receipt.operationId)
      .then(({ stream }) => {
        if (abort.signal.aborted || client.abort.signal.aborted) return
        const control = new ManualController(
          stream,
          axes,
          expiresAt,
          async () => {
            const result = await stopRunner.current('stop', { device: device.id })
            if (result?.state !== 'completed' || record(result.output).state !== 'settled') {
              setFailure(true)
              throw new Error('stop-unconfirmed')
            }
            return result
          },
          Date.now,
          rate,
        )
        const ended = () => {
          void control.release().catch(() => setFailure(true))
          setController(undefined)
          current.current = undefined
        }
        stream.onDisconnect(ended)
        stream.onDrop(ended)
        const expiry = setTimeout(ended, Math.max(0, expiresAt - Date.now()))
        const off = client.onDispose(() => {
          clearTimeout(expiry)
          void control.release().catch(() => {})
        })
        abort.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(expiry)
            off()
            if (current.current === control) {
              current.current = undefined
              setController(undefined)
            }
            void control.release().catch(() => {})
          },
          { once: true },
        )
        current.current = control
        setController(control)
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailure(true)
      })
    return () => {
      abort.abort()
      opening.current = false
    }
  }, [action.receipt, client, device.id, device.revision, device.available, axes, rate])
  useEffect(() => {
    const release = () => {
      const c = current.current
      current.current = undefined
      setController(undefined)
      void c?.release().catch(() => setFailure(true))
    }
    const hidden = () => {
      if (document.hidden) release()
    }
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', hidden)
      release()
    }
  }, [])
  useEffect(() => {
    if (!device.available) {
      void current.current?.release().catch(() => setFailure(true))
      current.current = undefined
      setController(undefined)
    }
  }, [device.available])
  if (!axes.length) return null
  const release = () => {
    void controller?.release().catch(() => setFailure(true))
    setController(undefined)
    current.current = undefined
  }
  return (
    <section className="mhs-box">
      <h3>{t('manual')}</h3>
      <p>{t('controlHelp')}</p>
      <Button
        disabled={
          !device.available || action.pending || stopAction.busy || stopAction.pending || !!controller
        }
        loading={action.busy}
        onClick={() => {
          setFailure(false)
          void action.run('lease', { device: device.id })
        }}
      >
        {t('requestControl')}
      </Button>
      {controller && <Button onClick={release}>{t('release')}</Button>}
      <ActionFeedback action={action} />
      <ActionFeedback action={stopAction} />
      {failure && <p role="alert">{t('unknown')}</p>}
      <fieldset
        className="mhs-drive"
        aria-label={t('manual')}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) release()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            release()
            return
          }
          if (e.code === 'Space') {
            e.preventDefault()
            if (controller) release()
            else void stopAction.run('stop', { device: device.id })
            return
          }
          if (e.ctrlKey || e.metaKey || e.altKey) return
          const key = manualKey(e.key)
          for (const axis of axes) {
            const keys = roleKeys[axis.role ?? '']
            if (keys?.includes(key)) {
              e.preventDefault()
              controller?.set(axis.id, key === keys[0] ? 1 : -1)
            }
          }
        }}
        onKeyUp={(e) => {
          for (const axis of axes) {
            if (roleKeys[axis.role ?? '']?.includes(manualKey(e.key))) {
              e.preventDefault()
              controller?.set(axis.id, 0)
              controller?.zero()
            }
          }
        }}
      >
        {(() => {
          const horizontal =
              axes.find((axis) => axis.role === 'turn') ?? axes.find((axis) => axis.role === 'yaw'),
            vertical =
              axes.find((axis) => axis.role === 'forward') ?? axes.find((axis) => axis.role === 'pitch')
          return horizontal && vertical ? (
            <AxisPad controller={controller} horizontal={horizontal} vertical={vertical} />
          ) : null
        })()}
        {axes.map((axis) => (
          <div key={axis.id} className="mhs-axis">
            <span>{axis.id}</span>
            {[-1, 1].map((sign) => (
              <Tooltip key={sign} title={`${axis.id} ${sign > 0 ? '+' : '−'}`}>
                <Button
                  disabled={!controller}
                  aria-label={`${axis.id} ${sign > 0 ? '+' : '−'}`}
                  onPointerDown={(e) => {
                    e.preventDefault()
                    e.currentTarget.setPointerCapture(e.pointerId)
                    controller?.set(axis.id, sign)
                  }}
                  onPointerUp={() => controller?.zero()}
                  onPointerCancel={() => controller?.zero()}
                  onLostPointerCapture={() => controller?.zero()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                      e.stopPropagation()
                      e.preventDefault()
                      controller?.set(axis.id, sign)
                    }
                  }}
                  onKeyUp={(e) => {
                    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                      e.stopPropagation()
                      e.preventDefault()
                      controller?.zero()
                    }
                  }}
                >
                  {sign > 0 ? '+' : '−'}
                </Button>
              </Tooltip>
            ))}
          </div>
        ))}
      </fieldset>
    </section>
  )
}

function AxisPad({
  controller,
  horizontal,
  vertical,
}: {
  controller: ManualController | undefined
  horizontal: Axis
  vertical: Axis
}) {
  const [position, setPosition] = useState({ x: 0, y: 0 })
  useEffect(() => {
    if (!controller) setPosition({ x: 0, y: 0 })
  }, [controller])
  const reset = () => {
    controller?.zero()
    setPosition({ x: 0, y: 0 })
  }
  const move = (element: HTMLElement, clientX: number, clientY: number) => {
    const bounds = element.getBoundingClientRect()
    if (!controller || bounds.width <= 0 || bounds.height <= 0) return
    let x = ((clientX - bounds.left) / bounds.width) * 2 - 1,
      y = ((clientY - bounds.top) / bounds.height) * 2 - 1
    const length = Math.max(1, Math.hypot(x, y))
    x /= length
    y /= length
    controller.set(horizontal.id, -x)
    controller.set(vertical.id, -y)
    setPosition({ x, y })
  }
  return (
    <Button
      className="mhs-axis-pad"
      disabled={!controller}
      aria-label={`${vertical.id} / ${horizontal.id}`}
      onPointerDown={(event) => {
        if (!controller) return
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
        move(event.currentTarget, event.clientX, event.clientY)
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          move(event.currentTarget, event.clientX, event.clientY)
      }}
      onPointerUp={reset}
      onPointerCancel={reset}
      onLostPointerCapture={reset}
    >
      <span className="mhs-pad-cross" aria-hidden="true" />
      <span
        className="mhs-pad-thumb"
        aria-hidden="true"
        style={{ transform: `translate(${position.x * 32}px, ${position.y * 32}px)` }}
      />
      <span className="mhs-pad-label">
        {vertical.id} / {horizontal.id}
      </span>
    </Button>
  )
}
