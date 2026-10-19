import React from 'react'
export function useProgramme(ctx, config, t) {
  const services = ctx.profile.services
  const key = JSON.stringify(['aero-operation', config.binding, config.revision])
  const saved = () => JSON.parse(window.sessionStorage.getItem(key) ?? 'null')
  const [data, setData] = React.useState(null)
  const [busy, setBusy] = React.useState(true)
  const [error, setError] = React.useState('')
  const [message, setMessage] = React.useState('')
  const [pending, setPending] = React.useState(saved)
  const alive = React.useRef(false)
  const locked = React.useRef(false)
  const load = async () => {
    const next = await services.query('aero.snapshot', {})
    if (alive.current) setData(next)
  }
  const receipt = async (r) => {
    const final = ['completed', 'refused', 'cancelled'].includes(r.state)
    if (final) window.sessionStorage.removeItem(key)
    if (!alive.current) return
    if (final) setPending(null)
    if (r.state === 'completed') {
      setMessage(t.saved)
      await load()
    } else if (r.state === 'approval-required') setMessage(t.approval)
    else if (final) setError(`${t.error}: ${r.state}`)
    else setMessage(t.uncertain)
  }
  const request = async (work) => {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await work()
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : t.error)
    } finally {
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  const check = (resume = true) =>
    request(async () => {
      const p = saved() ?? pending
      if (!p) return
      let r = await services.readOperation(p.service, p.operationId)
      if (resume && r.state === 'approval-required')
        r = await services.effect(p.service, p.input, { operationId: p.operationId })
      await receipt(r)
    })
  React.useEffect(() => {
    alive.current = true
    void request(async () => {
      const p = saved()
      if (p) await receipt(await services.readOperation(p.service, p.operationId))
      await load()
    })
    return () => {
      alive.current = false
    }
  }, [])
  const change = (service, input) =>
    request(async () => {
      if (saved() || pending) return
      const p = { service, input, operationId: crypto.randomUUID() }
      window.sessionStorage.setItem(key, JSON.stringify(p))
      setPending(p)
      await receipt(await services.effect(service, input, { operationId: p.operationId }))
    })
  return {
    data,
    busy,
    error,
    message,
    pending,
    refresh: () => request(load),
    check,
    change,
    disabled: busy || Boolean(pending),
  }
}
