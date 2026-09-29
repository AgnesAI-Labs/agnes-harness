import type { ConfigModel, ConfigOAuthInput, ConfigProvider } from '@agnes/protocol'
import { loginSubscription, type OAuthClient } from '@agnes/sdk/browser'
import { Button, createRegionHost, Field, mountRegion } from '@agnes/web-ui'
import { createElement } from 'react'

type UiButton = { button: HTMLButtonElement; host: HTMLElement; dispose?: () => void }
type UiField = { field: HTMLLabelElement; input: HTMLInputElement; host: HTMLElement; dispose?: () => void }

/**
 * OAuth keeps its public controller API for the settings state machine, but its visible actions
 * now come from the shared UI layer. The fallback is only for the controller's minimal fake DOM
 * tests, which intentionally do not install a browser runtime for ReactDOM.
 */
function uiButton(parent: HTMLElement, text: string, className?: string): UiButton {
  if (typeof window !== 'undefined' && typeof document.querySelector === 'function') {
    const host = createRegionHost(parent, 'span', 'agnes-ui-button-host')
    const props =
      className === undefined ? { type: 'default' as const } : { className, type: 'default' as const }
    const dispose = mountRegion(host, createElement(Button, props, text))
    const button = host.querySelector('button')
    if (button) return { button, host, dispose }
    dispose()
    host.remove()
  }
  const button = createRegionHost(parent, 'button') as HTMLButtonElement
  button.type = 'button'
  button.textContent = text
  if (className) button.className = className
  return { button, host: button }
}

function uiField(parent: HTMLElement): UiField {
  if (typeof window !== 'undefined' && typeof document.querySelector === 'function') {
    const host = createRegionHost(parent, 'span', 'agnes-ui-field-host')
    const dispose = mountRegion(
      host,
      createElement(
        Field,
        { className: 'form-field oauth-prompt', hidden: true, label: '授权码或回调地址' },
        createElement('input', { autoComplete: 'off', type: 'password' }),
      ),
    )
    const field = host.querySelector('label')
    const input = host.querySelector('input')
    if (field && input) return { field, input, host, dispose }
    dispose()
    host.remove()
  }
  const field = createRegionHost(parent, 'label') as HTMLLabelElement
  field.className = 'form-field oauth-prompt'
  field.textContent = '授权码或回调地址'
  const input = createRegionHost(field, 'input') as HTMLInputElement
  input.type = 'password'
  input.autocomplete = 'off'
  field.append(input)
  return { field, input, host: field }
}

/** Native controls remain in the existing account dialog and its focus trap. */
export function oauthControls(
  parent: HTMLElement,
  client: OAuthClient,
  callbacks: {
    input(): ConfigOAuthInput
    provider(): ConfigProvider | undefined
    pending(value: boolean): void
    ready(models: ConfigModel[]): void
    error(error: unknown): void
  },
) {
  const panel = createRegionHost(parent, 'section')
  panel.className = 'oauth-controls'
  panel.setAttribute('aria-label', '订阅登录')
  panel.hidden = true
  const status = createRegionHost(panel, 'p', 'oauth-status')
  status.setAttribute('role', 'status')
  const links = createRegionHost(panel, 'div', 'oauth-links')
  const promptView = uiField(panel)
  const prompt = promptView.field
  const answer = promptView.input
  prompt.hidden = true
  const actions = createRegionHost(panel, 'div', 'oauth-actions')
  const browserView = uiButton(actions, '浏览器登录')
  const deviceView = uiButton(actions, '设备码登录')
  const cancelView = uiButton(actions, '取消登录')
  const submitView = uiButton(actions, '提交授权码', 'secondary-button')
  const browser = browserView.button
  const device = deviceView.button
  const cancel = cancelView.button
  const submit = submitView.button
  actions.append(browserView.host, deviceView.host, cancelView.host)
  submit.hidden = true
  cancel.hidden = true
  panel.append(actions, status, links, promptView.host, submitView.host)
  parent.append(panel)
  let controller: AbortController | undefined
  let operationId: string | undefined
  let allowedHosts = new Set<string>()
  const providerHosts: Record<string, string[]> = {
    'openai-codex': ['auth.openai.com'],
    anthropic: ['claude.ai'],
    'github-copilot': ['github.com'],
    'kimi-coding': ['auth.kimi.com', 'www.kimi.com'],
    xai: ['auth.x.ai', 'accounts.x.ai'],
  }
  const clear = () => {
    controller?.abort()
    controller = undefined
    if (operationId) void client.oauth({ action: 'cancel', operationId }).catch(() => {})
    operationId = undefined
    answer.value = ''
    prompt.hidden = true
    submit.hidden = true
    cancel.hidden = true
    links.replaceChildren()
    status.textContent = ''
    status.removeAttribute('aria-busy')
    callbacks.pending(false)
  }
  const start = async (loginMethod: 'browser' | 'device_code') => {
    clear()
    const own = new AbortController()
    controller = own
    let input: ConfigOAuthInput
    let provider: ConfigProvider | undefined
    try {
      input = callbacks.input()
      provider = callbacks.provider()
      if (!provider?.loginMethods?.includes(loginMethod)) throw new Error('当前 Provider 不支持该登录方式')
    } catch (error) {
      if (controller === own) {
        clear()
        callbacks.error(error)
      }
      return
    }
    try {
      allowedHosts = new Set(providerHosts[provider.id] ?? [])
      callbacks.pending(true)
      callbacks.ready([])
      browser.disabled = true
      device.disabled = true
      cancel.hidden = false
      status.textContent = '等待授权。关闭账户窗口会取消本次登录。'
      status.setAttribute('aria-busy', 'true')
      const result = await loginSubscription(
        client,
        { ...input, action: 'start', providerId: provider.id, loginMethod },
        {
          signal: own.signal,
          operation: (id) => {
            operationId = id
          },
          notice: (notice) => {
            status.textContent = notice.message
            if (!notice.url) return
            const url = new URL(notice.url)
            if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname) || url.username || url.password)
              return
            const link = createRegionHost(links, 'a') as HTMLAnchorElement
            link.href = url.href
            link.target = '_blank'
            link.rel = 'noopener noreferrer'
            link.textContent = `打开 ${provider.label} 登录页面`
          },
          prompt: (value, signal) =>
            new Promise<string>((resolve, reject) => {
              const promptLabel = prompt.querySelector<HTMLElement>('.agnes-ui-field-label')
              if (promptLabel) promptLabel.textContent = value.message
              else if (prompt.firstChild) prompt.firstChild.textContent = value.message
              answer.type = value.type === 'secret' ? 'password' : 'text'
              answer.placeholder = value.placeholder ?? ''
              submit.textContent = value.type === 'text' ? '继续' : '提交授权码'
              prompt.hidden = false
              submit.hidden = false
              answer.value = ''
              answer.focus()
              const cleanup = () => {
                submit.removeEventListener('click', send)
                signal.removeEventListener('abort', abort)
                answer.value = ''
                prompt.hidden = true
                submit.hidden = true
              }
              const send = () => {
                if (!answer.value.trim() && value.type !== 'text') return
                const answerValue = answer.value.trim()
                if (provider.id === 'github-copilot' && answerValue) {
                  try {
                    allowedHosts.add(
                      new URL(answerValue.includes('://') ? answerValue : `https://${answerValue}`).hostname,
                    )
                  } catch {
                    return
                  }
                }
                cleanup()
                resolve(answerValue)
              }
              const abort = () => {
                cleanup()
                reject(new Error('cancelled'))
              }
              submit.addEventListener('click', send)
              signal.addEventListener('abort', abort, { once: true })
              if (signal.aborted) abort()
            }),
        },
      )
      if (controller !== own || own.signal.aborted) return
      status.textContent = '授权完成。选择模型并保存；保存前会发送一条测试请求。'
      status.removeAttribute('aria-busy')
      links.replaceChildren()
      callbacks.ready(result.models ?? [])
    } catch {
      if (controller === own && !own.signal.aborted) {
        clear()
        callbacks.pending(false)
        callbacks.error(
          new Error(
            provider.loginMethods && provider.loginMethods.length > 1
              ? '登录失败，请重试；也可选择该 Provider 支持的其他登录方式。'
              : '登录失败，请检查网络连接后重试。',
          ),
        )
      }
    } finally {
      if (controller === own) {
        callbacks.pending(false)
        browser.disabled = false
        device.disabled = false
      }
    }
  }
  browser.addEventListener('click', () => void start('browser'))
  device.addEventListener('click', () => void start('device_code'))
  cancel.addEventListener('click', () => {
    clear()
    callbacks.pending(false)
    callbacks.ready([])
    ;(browser.hidden ? device : browser).focus()
  })
  answer.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit.click()
    }
  })
  return {
    clear,
    operation: () => operationId,
    visible(value: boolean) {
      panel.hidden = !value
      const provider = callbacks.provider()
      const methods =
        provider?.loginMethods ?? (provider?.authType === 'oauth' ? ['browser', 'device_code'] : [])
      browser.hidden = !methods.includes('browser')
      device.hidden = !methods.includes('device_code')
    },
    disabled(value: boolean) {
      browser.disabled = value
      device.disabled = value
    },
  }
}
