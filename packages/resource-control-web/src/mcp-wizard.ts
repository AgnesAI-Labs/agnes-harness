import { validateMethod } from '@agnes/protocol'
import { createSelectPicker, type LocaleTranslator } from '@agnes/web-ui'
import { $ } from './admin-dom.js'
import { formatMcpCommand, parseMcpCommand } from './mcp-command.js'

/** A presentation adapter over the existing form: managed definitions and confirmation are unchanged. */
export function mountMcpWizard(text: () => LocaleTranslator, sync: () => void) {
  const fields = document.getElementById('mcp-connection-fields')
  if (!fields)
    return { reset: (_editing = false) => {}, filled: () => {}, dispose: () => {}, localize: () => {} }
  const abort = new AbortController()
  const methods = $('mcp-methods', 'section')
  const command = $('mcp-command', 'input')
  const name = $('mcp-name', 'input')
  const identity = $('mcp-id', 'input')
  const credential = $('mcp-credential', 'select')
  let picker = createSelectPicker(credential, { label: text()('wizard.credential'), includeEmpty: true })
  let manualId = false
  let editingMode = false
  let fallbackId = `mcp-service-${crypto.randomUUID().slice(0, 8)}`
  let known: string[] = []
  const transport = $('mcp-transport', 'select')
  const submit = $('mcp-form', 'form').querySelector<HTMLButtonElement>('[type="submit"]')!
  const back = $('mcp-back', 'button')
  function stage(editing: boolean, configuring: boolean) {
    methods.hidden = configuring
    fields!.hidden = !configuring
    back.hidden = editing || !configuring
    submit.hidden = !configuring
    for (const input of fields!.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input, select, textarea',
    )) {
      // Hidden step controls must not participate in native constraint validation.
      if (!configuring) input.disabled = true
      else if (input !== identity) input.disabled = false
    }
    picker.sync()
  }
  function updateCommand() {
    try {
      const tokens = parseMcpCommand(command.value)
      $('mcp-executable', 'input').value = tokens[0] ?? ''
      $('mcp-args', 'textarea').value = tokens.slice(1).join('\n')
      command.setCustomValidity('')
    } catch {
      command.setCustomValidity(text()('wizard.commandError'))
    }
  }
  function filled() {
    identity.disabled = editingMode
    stage(editingMode, true)
    command.value = formatMcpCommand([
      $('mcp-executable', 'input').value,
      ...$('mcp-args', 'textarea').value.split('\n').filter(Boolean),
    ])
    command.hidden = false
    command.disabled = transport.value !== 'stdio'
    $('mcp-command-row', 'label').hidden = transport.value !== 'stdio'
    const binding = $('mcp-secret', 'textarea').value
    const selected = binding.startsWith('secret://')
      ? binding
      : /^([A-Z][A-Z0-9_]*)=(secret:\/\/[^\n]+)$/.exec(binding)?.[2]
    const env = /^([A-Z][A-Z0-9_]*)=/.exec(binding)?.[1]
    if (env) $('mcp-token-env', 'input').value = env
    choices(selected)
    command.setCustomValidity('')
  }
  function choices(selected?: string) {
    const refs = [...new Set([...known, ...(selected ? [selected] : [])])]
    const option = (label: string, value: string) => {
      const node = credential.ownerDocument.createElement('option')
      node.textContent = label
      node.value = value
      return node
    }
    credential.replaceChildren(
      option(text()('shell.form.secret-none'), ''),
      ...refs.map((ref) => option(ref.replace(/^secret:\/\//, '').replace(/\//g, ' · '), ref)),
    )
    credential.value = selected ?? ''
    picker.sync()
  }
  function applyCredential() {
    const local = transport.value === 'stdio'
    $('mcp-secret-kind', 'select').value = credential.value ? (local ? 'stdio-env' : 'http-bearer') : 'none'
    $('mcp-secret', 'textarea').value = credential.value
      ? local
        ? `${$('mcp-token-env', 'input').value}=${credential.value}`
        : credential.value
      : ''
    sync()
  }
  function choose(kind: 'stdio' | 'http') {
    transport.value = kind
    identity.disabled = false
    stage(false, true)
    command.hidden = false
    command.disabled = kind !== 'stdio'
    $('mcp-command-row', 'label').hidden = kind !== 'stdio'
    sync()
    name.focus()
  }
  const on = (element: HTMLElement, event: string, listener: EventListener) =>
    element.addEventListener(event, listener, { signal: abort.signal })
  on($('mcp-method-local', 'button'), 'click', () => choose('stdio'))
  on($('mcp-method-remote', 'button'), 'click', () => choose('http'))
  on(back, 'click', () => stage(false, false))
  on(identity, 'input', () => {
    manualId = true
  })
  on(name, 'input', () => {
    if (!manualId && !identity.disabled) {
      const generated = name.value
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      identity.value = /^[a-z]/.test(generated) ? generated.slice(0, 128) : fallbackId
    }
  })
  on(command, 'input', () => {
    updateCommand()
    sync()
  })
  for (const id of ['mcp-executable', 'mcp-args'] as const)
    on($(id, id === 'mcp-args' ? 'textarea' : 'input'), 'input', () => {
      command.value = formatMcpCommand([
        $('mcp-executable', 'input').value,
        ...$('mcp-args', 'textarea').value.split('\n').filter(Boolean),
      ])
      command.setCustomValidity('')
    })
  on(credential, 'change', applyCredential)
  on($('mcp-token-env', 'input'), 'input', () => {
    if (credential.value) applyCredential()
  })
  on(transport, 'change', () => {
    command.disabled = transport.value !== 'stdio'
    $('mcp-command-row', 'label').hidden = transport.value !== 'stdio'
  })
  async function loadCredentials() {
    try {
      // This existing read-only control surface exposes names, never secret values.
      const response = await fetch('/api/triggers', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'list' }),
        signal: abort.signal,
      })
      const value: unknown = await response.json()
      if (!response.ok || !validateMethod('_agnes/v1/admin.triggers', 'result', value).ok)
        throw new Error('credentials unavailable')
      const refs = (value as { snapshot?: { secretRefs: string[] } }).snapshot?.secretRefs ?? []
      if (abort.signal.aborted) return
      known = refs
      choices(credential.value || undefined)
      $('mcp-credential-status', 'p').textContent = known.length ? '' : text()('wizard.noCredentials')
    } catch {
      if (!abort.signal.aborted)
        $('mcp-credential-status', 'p').textContent = text()('wizard.credentialsUnavailable')
    }
  }
  function localize() {
    picker.destroy()
    picker = createSelectPicker(credential, { label: text()('wizard.credential') })
    choices(credential.value || undefined)
    const agent = document.getElementById('mcp-method-agent') as HTMLAnchorElement | null
    if (agent) agent.href = '/?' + new URLSearchParams({ new: '1', prompt: text()('wizard.agentPrompt') })
  }
  return {
    reset(editing = false) {
      manualId = editing
      editingMode = editing
      fallbackId = `mcp-service-${crypto.randomUUID().slice(0, 8)}`
      command.value = ''
      command.setCustomValidity('')
      choices()
      stage(editing, editing)
      void loadCredentials()
      if (editing) filled()
    },
    filled,
    localize,
    dispose() {
      abort.abort()
      picker.destroy()
    },
  }
}
