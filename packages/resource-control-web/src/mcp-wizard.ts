import { validateMethod } from '@agnes/protocol'
import { createSelectPicker, type LocaleTranslator } from '@agnes/web-ui'
import { $ } from './admin-dom.js'
import { CREDENTIALS_CHANGED, CredentialsApi } from './credentials-api.js'
import { deriveMcpName, formatMcpCommand, parseMcpCommand } from './mcp-command.js'
import { mountMcpCredentialCreate } from './mcp-credentials.js'

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
  let manualName = false
  const url = $('mcp-url', 'input')
  const step = document.getElementById('mcp-step')
  const named = document.getElementById('mcp-named')
  const oauth = document.getElementById('mcp-oauth') as HTMLInputElement | null
  const oauthClient = document.getElementById('mcp-oauth-client') as HTMLInputElement | null
  /** The name and ID follow what was pasted until the user names the server themselves. */
  function deriveName() {
    if (!manualName && !editingMode) {
      name.value = deriveMcpName(
        transport.value === 'stdio' ? 'stdio' : 'remote',
        transport.value === 'stdio' ? command.value : url.value,
      )
      name.dispatchEvent(new Event('input', { bubbles: true }))
      manualName = false
    }
    if (named) {
      named.textContent = name.value ? text()('wizard.named', { name: name.value }) : ''
      named.hidden = !name.value || editingMode
    }
  }
  function syncOAuth() {
    const remote = transport.value !== 'stdio'
    const row = document.getElementById('mcp-oauth-row')
    if (row) row.hidden = !remote
    if (!remote && oauth) oauth.checked = false
    const on = !!oauth?.checked
    const client = document.getElementById('mcp-oauth-client-row')
    if (client) client.hidden = !on
    credential.disabled = on
    // A saved credential and an OAuth sign-in are alternatives: show one at a time.
    const saved = credential.closest('label')
    if (saved) saved.hidden = on
    $('mcp-credential-status', 'p').hidden = on
    picker.sync()
  }
  let editingMode = false
  let fallbackId = `mcp-service-${crypto.randomUUID().slice(0, 8)}`
  let known: string[] = []
  const labels = new Map<string, string>()
  let loadVersion = 0
  const transport = $('mcp-transport', 'select')
  const submit = $('mcp-form', 'form').querySelector<HTMLButtonElement>('[type="submit"]')!
  const back = $('mcp-back', 'button')
  function stage(editing: boolean, configuring: boolean) {
    if (step) {
      step.textContent = text()(configuring ? 'wizard.step2' : 'wizard.step1')
      step.hidden = editing
    }
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
      ...refs.map((ref) => {
        const label = labels.get(ref)
        const duplicate = label && [...labels.values()].filter((value) => value === label).length > 1
        return option(
          label
            ? duplicate
              ? `${label} · ${ref.slice(-8)}`
              : label
            : ref.replace(/^secret:\/\//, '').replace(/\//g, ' · '),
          ref,
        )
      }),
    )
    credential.value = selected ?? ''
    picker.sync()
  }
  function applyCredential() {
    const local = transport.value === 'stdio'
    const kind = $('mcp-secret-kind', 'select')
    syncOAuth()
    if (!local && oauth?.checked) {
      kind.value = 'oauth'
      $('mcp-secret', 'textarea').value = oauthClient?.value.trim() ?? ''
      sync()
      return
    }
    kind.value = credential.value
      ? local
        ? 'stdio-env'
        : kind.value === 'http-header'
          ? 'http-header'
          : 'http-bearer'
      : 'none'
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
    syncOAuth()
    deriveName()
    ;(kind === 'stdio' ? command : url).focus()
  }
  const on = (element: HTMLElement, event: string, listener: EventListener) =>
    element.addEventListener(event, listener, { signal: abort.signal })
  on($('mcp-method-local', 'button'), 'click', () => choose('stdio'))
  on($('mcp-method-remote', 'button'), 'click', () => choose('http'))
  // Each card is the choice, not just the words inside it. A click that lands on an inner control
  // already has its own handler, so the row only reacts to the rest of the card.
  const onRowChoice = (rowId: string, activate: () => void) => {
    const row = document.getElementById(rowId)
    if (!row) return
    on(row, 'click', (event) => {
      if ((event.target as Element).closest('button, a')) return
      activate()
    })
  }
  onRowChoice('mcp-method-local-row', () => choose('stdio'))
  onRowChoice('mcp-method-remote-row', () => choose('http'))
  // Follow the row's own link so the prompt parameter prepared for it is kept.
  onRowChoice('mcp-method-agent-row', () =>
    (document.getElementById('mcp-method-agent') as HTMLAnchorElement | null)?.click(),
  )
  on(back, 'click', () => stage(false, false))
  on(identity, 'input', () => {
    manualId = true
  })
  on(name, 'input', () => {
    manualName = name.value !== ''
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
    deriveName()
    sync()
  })
  on(url, 'input', deriveName)
  if (oauth) on(oauth, 'change', applyCredential)
  if (oauthClient) on(oauthClient, 'input', applyCredential)
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
    syncOAuth()
    deriveName()
  })
  async function loadCredentials() {
    const version = ++loadVersion
    try {
      const items = await new CredentialsApi().list(abort.signal)
      if (abort.signal.aborted || version !== loadVersion) return
      labels.clear()
      for (const item of items) labels.set(item.id, item.label)
      known = items.map((item) => item.id)
      choices(credential.value || undefined)
    } catch {
      /* The legacy catalog may still be available; never infer permission to write. */
    }
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
      if (abort.signal.aborted || version !== loadVersion) return
      known = [...new Set([...known, ...refs])]
      choices(credential.value || undefined)
      $('mcp-credential-status', 'p').textContent = known.length ? '' : text()('wizard.noCredentials')
    } catch {
      if (!abort.signal.aborted && version === loadVersion)
        $('mcp-credential-status', 'p').textContent = text()('wizard.credentialsUnavailable')
    }
  }
  const disposeCreate = mountMcpCredentialCreate(credential, (item) => {
    if (abort.signal.aborted) return
    known = [...new Set([...known, item.id])]
    labels.set(item.id, item.label)
    choices(item.id)
    applyCredential()
    $('mcp-credential-status', 'p').textContent = ''
  })
  window.addEventListener(CREDENTIALS_CHANGED, () => void loadCredentials(), { signal: abort.signal })
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
      manualName = editing
      editingMode = editing
      if (oauth) oauth.checked = false
      if (oauthClient) oauthClient.value = ''
      fallbackId = `mcp-service-${crypto.randomUUID().slice(0, 8)}`
      command.value = ''
      command.setCustomValidity('')
      choices()
      stage(editing, editing)
      void loadCredentials()
      if (editing) filled()
      if (oauth && editing) {
        oauth.checked = $('mcp-secret-kind', 'select').value === 'oauth'
        if (oauthClient && oauth.checked) oauthClient.value = $('mcp-secret', 'textarea').value
      }
      syncOAuth()
      deriveName()
    },
    filled,
    localize,
    dispose() {
      abort.abort()
      disposeCreate()
      picker.destroy()
    },
  }
}
