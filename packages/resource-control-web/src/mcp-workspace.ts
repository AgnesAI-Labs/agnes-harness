import type { LocaleTranslator } from '@agnes/web-ui'
import { $ } from './admin-dom.js'

function absolutePath(value: string): string | undefined {
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(value)) return undefined
  const parts: string[] = []
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (part === '.') continue
    if (part === '..') {
      if (parts.length > 1) parts.pop()
    } else if (part || !parts.length) parts.push(part)
  }
  return parts.join('/')
}

/** A directory suggestion, never an assertion about files or permissions on the daemon machine. */
export function localScriptWorkspace(executable: string, argsText: string): string | undefined {
  const program = executable.replaceAll('\\', '/').split('/').at(-1) ?? ''
  if (!/^(?:node|python(?:\d+(?:\.\d+)?)?)(?:\.exe)?$/i.test(program)) return undefined
  const entry = argsText.split('\n')[0]?.trim() ?? ''
  if (!/\.(?:[cm]?[jt]s|py)$/i.test(entry)) return undefined
  const path = absolutePath(entry)
  if (!path) return undefined
  const parts = path.split('/')
  // Dependencies of npm packages can be siblings of the entry package. Suggest the install root,
  // not dist/ or the package's directory, which still leaves those siblings outside the workspace.
  const modules = parts.indexOf('node_modules')
  const directory = parts.slice(0, modules >= 0 ? modules : -1).join('/')
  if (!directory || /^[A-Za-z]:$/.test(directory)) return undefined
  return /^[A-Za-z]:/.test(directory) ? directory.replaceAll('/', '\\') : directory
}

export function workspaceContains(workspace: string, directory: string): boolean {
  let parent = absolutePath(workspace)
  let child = absolutePath(directory)
  if (!parent || !child) return false
  if (/^[A-Za-z]:/.test(parent)) {
    parent = parent.toLowerCase()
    child = child.toLowerCase()
  }
  return child === parent || child.startsWith(`${parent}/`)
}

export function mountMcpWorkspace(input: { text(): LocaleTranslator; sync(): void; signal: AbortSignal }) {
  const container = document.getElementById('mcp-workspace-config')
  if (!container) return { refresh() {} }
  const config = container
  const workspace = $('mcp-workspace', 'input')
  const suggestion = $('mcp-workspace-suggestion', 'p')
  const button = $('mcp-workspace-use', 'button')
  let directory: string | undefined
  function refresh() {
    const local = $('mcp-transport', 'select').value === 'stdio'
    config.hidden = !local
    directory = localScriptWorkspace($('mcp-executable', 'input').value, $('mcp-args', 'textarea').value)
    const needsReview = local && $('mcp-sandbox', 'select').value !== 'off-with-warning' && directory
    workspace.required = !!needsReview
    suggestion.hidden = !needsReview || workspaceContains(workspace.value, directory ?? '')
    $('mcp-workspace-explanation', 'span').textContent = directory
      ? input.text()('sandbox.workspaceSuggestion', { directory })
      : ''
    button.disabled = suggestion.hidden
  }
  button.addEventListener(
    'click',
    () => {
      if (!directory) return
      workspace.value = directory
      workspace.dispatchEvent(new Event('input', { bubbles: true }))
    },
    { signal: input.signal },
  )
  for (const [element, event] of [
    [workspace, 'input'],
    [$('mcp-sandbox', 'select'), 'change'],
  ] as const)
    element.addEventListener(
      event,
      () => {
        refresh()
        input.sync()
      },
      { signal: input.signal },
    )
  return { refresh }
}
