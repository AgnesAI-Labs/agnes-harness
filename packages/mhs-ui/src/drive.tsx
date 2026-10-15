import { Button, Tooltip } from '@agnes/web-ui'
import { useEffect, useRef, useState } from 'react'
import { type Axis, ManualController, roleKeys } from './manual.js'
import { array, type Device, number, record, text } from './model.js'
import { ActionFeedback, useAction, useMhs } from './react.js'

export function Drive({ device }: { device: Device }) {
  const { client, t } = useMhs(),
    action = useAction(),
    [controller, setController] = useState<ManualController>(),
    [failure, setFailure] = useState(false)
  const current = useRef<ManualController>(),
    opening = useRef(false)
  const axes: Axis[] = array(device.manual.axes).map((v) => {
    const a = record(v)
    return {
      id: text(a.id),
      min: number(a.min),
      max: number(a.max),
      ...(text(a.role) ? { role: text(a.role) } : {}),
    }
  })
  useEffect(() => {
    const receipt = action.receipt
    if (receipt?.state !== 'completed' || opening.current || current.current) return
    const output = record(receipt.output),
      leaseId = text(output.leaseId),
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
        if (abort.signal.aborted) return
        const control = new ManualController(
          stream,
          axes,
          expiresAt,
          () => client.effect('stop', { device: device.id }),
          Date.now,
          number(device.manual.rate_hz, 30),
        )
        const ended = () => {
          void control.release().catch(() => setFailure(true))
          setController(undefined)
          current.current = undefined
        }
        stream.onDisconnect(ended)
        stream.onDrop(ended)
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
  }, [action.receipt, client, device.id])
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
  }, [device.id, device.revision])
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
        disabled={!device.available || action.pending || !!controller}
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
      {failure && <p role="alert">{t('unknown')}</p>}
      <div
        className="mhs-drive"
        tabIndex={0}
        role="group"
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
            controller?.zero()
            void client.effect('stop', { device: device.id }).catch(() => setFailure(true))
            return
          }
          const key = e.key.toLowerCase()
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
            if (roleKeys[axis.role ?? '']?.includes(e.key.toLowerCase())) {
              e.preventDefault()
              controller?.set(axis.id, 0)
              controller?.zero()
            }
          }
        }}
      >
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
                    if (e.code === 'Space' || e.key === 'Enter') {
                      e.stopPropagation()
                      e.preventDefault()
                      controller?.set(axis.id, sign)
                    }
                  }}
                  onKeyUp={(e) => {
                    if (e.code === 'Space' || e.key === 'Enter') {
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
      </div>
    </section>
  )
}
