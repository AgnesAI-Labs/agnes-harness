import type { TraceEntry } from '@agnes/jev-trace'
import type { Translate } from './jev-locale.js'

export function decisionModelLabel(backend: unknown, t: Translate): string {
  if (backend === 'jev') return 'Jev'
  if (backend === 'laya') return 'Laya'
  if (backend === 'agnes-provider' || backend === 'llm') return 'LLM'
  return t('req.model.unknown')
}

type SavedRequest = {
  key: string
  seq: number
  label: string
  metadata: string
  raw?: string
  unavailable?: string
}

function savedRequests(entries: readonly TraceEntry[], t: Translate): SavedRequest[] {
  return entries.flatMap((entry) => {
    const record = entry.record
    if (record.kind !== 'model.requested' || record.call.purpose !== 'decision') return []
    const settlement = entries.find(
      (candidate) =>
        candidate.seq > entry.seq &&
        candidate.record.kind === 'model.settled' &&
        candidate.record.requested === record.id,
    )?.record
    const status =
      settlement?.kind === 'model.settled'
        ? settlement.settlement.error
          ? t('req.status.failed')
          : t('req.status.settled')
        : t('req.status.unsettled')
    const result: SavedRequest = {
      key: `${entry.seq}:${record.id}`,
      seq: entry.seq,
      label: t('req.saved.label', {
        seq: entry.seq,
        backend: decisionModelLabel(record.call.backend, t),
        turn: entry.turn,
        step: entry.step ?? t('req.unknown'),
        status,
      }),
      metadata: t('req.saved.metadata', {
        backend: decisionModelLabel(record.call.backend, t),
        model: record.call.requestedModel ?? t('req.unknown'),
        endpoint: record.call.endpoint,
        id: record.id,
        codec: record.call.codec,
        status,
      }),
    }
    if (record.call.codec !== 'systemone-json-v1') {
      result.unavailable = t('req.unavailable.codec')
      return [result]
    }
    const input = record.call.input
    if (
      input === null ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof input.model !== 'string' ||
      !Object.hasOwn(input, 'state') ||
      input.questions === null ||
      typeof input.questions !== 'object' ||
      Array.isArray(input.questions)
    ) {
      result.unavailable = t('req.unavailable.missing')
      return [result]
    }
    try {
      result.raw = JSON.stringify(input)
    } catch {
      result.unavailable = t('req.unavailable.json')
    }
    return [result]
  })
}

/** Read only trusted runtime records supplied by the graph, already restricted to its visible prefix. */
export function createJevRequestViewer(t: Translate) {
  const dialog = document.createElement('dialog')
  dialog.className = 'jev-request-viewer'
  dialog.setAttribute('aria-label', t('req.title'))
  const header = document.createElement('header')
  const title = document.createElement('h2')
  title.textContent = t('req.title')
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = t('req.close')
  header.append(title, close)
  const note = document.createElement('p')
  note.textContent = t('req.note')
  const controls = document.createElement('div')
  controls.className = 'jev-request-viewer-controls'
  const requests = document.createElement('select')
  requests.setAttribute('aria-label', t('req.requests.label'))
  const format = document.createElement('select')
  format.setAttribute('aria-label', t('req.format.label'))
  for (const [value, text] of [
    ['pretty', t('req.format.pretty')],
    ['raw', t('req.format.raw')],
  ] as const) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = text
    format.append(option)
  }
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = t('req.copy')
  const download = document.createElement('button')
  download.type = 'button'
  download.textContent = t('req.download')
  controls.append(requests, format, copy, download)
  const metadata = document.createElement('pre')
  metadata.className = 'jev-request-viewer-metadata'
  const body = document.createElement('textarea')
  body.className = 'jev-request-viewer-body'
  body.setAttribute('aria-label', t('req.body.label'))
  body.readOnly = true
  body.spellcheck = false
  const status = document.createElement('p')
  status.className = 'jev-request-viewer-status'
  status.setAttribute('role', 'status')
  dialog.append(header, note, controls, metadata, body, status)
  document.body.append(dialog)
  let choices: SavedRequest[] = []
  let selected: string | undefined
  let disposed = false
  let revision = 0
  let optionsIdentity = ''
  let url: string | undefined
  let revokeTimer: ReturnType<typeof setTimeout> | undefined
  const current = () => choices.find((choice) => choice.key === selected)
  const releaseDownload = () => {
    if (revokeTimer !== undefined) clearTimeout(revokeTimer)
    revokeTimer = undefined
    if (url !== undefined) URL.revokeObjectURL(url)
    url = undefined
  }
  function render() {
    revision++
    releaseDownload()
    const value = current()
    const identity = JSON.stringify([!!value, choices.map(({ key, label }) => [key, label])])
    if (identity !== optionsIdentity) {
      optionsIdentity = identity
      requests.replaceChildren()
      if (!value) {
        const empty = document.createElement('option')
        empty.value = ''
        empty.textContent = t('req.empty.option')
        requests.append(empty)
      }
      for (const choice of choices) {
        const option = document.createElement('option')
        option.value = choice.key
        option.textContent = choice.label
        requests.append(option)
      }
    }
    requests.value = value?.key ?? ''
    requests.disabled = choices.length === 0
    status.textContent =
      choices.length === 0
        ? t('req.status.empty')
        : (value?.unavailable ?? (value ? '' : t('req.status.stale')))
    metadata.textContent = value?.metadata ?? ''
    const text =
      value?.raw === undefined
        ? ''
        : format.value === 'raw'
          ? value.raw
          : JSON.stringify(JSON.parse(value.raw), null, 2)
    // Repeated graph updates must not reset the reader's text selection or scroll position.
    if (body.value !== text) body.value = text
    copy.disabled = value?.raw === undefined
    download.disabled = value?.raw === undefined
    format.disabled = value?.raw === undefined
  }
  close.addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => {
    if (dialog.open) return
    choices = []
    selected = undefined
    render()
  })
  requests.addEventListener('change', () => {
    selected = requests.value
    render()
  })
  format.addEventListener('change', render)
  copy.addEventListener('click', async () => {
    const raw = current()?.raw
    if (disposed || !dialog.open || raw === undefined) return
    const ticket = revision
    try {
      await navigator.clipboard.writeText(raw)
      if (!disposed && dialog.open && revision === ticket) status.textContent = t('req.status.copied')
    } catch {
      if (!disposed && dialog.open && revision === ticket) status.textContent = t('req.status.copyFailed')
    }
  })
  download.addEventListener('click', () => {
    const value = current()
    if (disposed || !dialog.open || value?.raw === undefined) return
    releaseDownload()
    try {
      url = URL.createObjectURL(new Blob([value.raw], { type: 'application/json;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `jev-request-${value.seq}.json`
      dialog.append(link)
      try {
        link.click()
      } finally {
        link.remove()
      }
      revokeTimer = setTimeout(releaseDownload, 0)
    } catch {
      releaseDownload()
      status.textContent = t('req.status.downloadFailed')
    }
  })
  render()
  return {
    open(entries: readonly TraceEntry[], selectedSeq?: number) {
      if (disposed) return
      choices = savedRequests(entries, t)
      selected = (
        selectedSeq === undefined ? choices.at(-1) : choices.find((choice) => choice.seq === selectedSeq)
      )?.key
      format.value = 'pretty'
      render()
      if (!dialog.open) dialog.showModal()
    },
    update(entries: readonly TraceEntry[]) {
      if (disposed) return
      choices = dialog.open ? savedRequests(entries, t) : []
      if (!current()) selected = undefined
      render()
    },
    dispose() {
      if (disposed) return
      disposed = true
      choices = []
      selected = undefined
      render()
      if (dialog.open) dialog.close()
      dialog.remove()
    },
  }
}
