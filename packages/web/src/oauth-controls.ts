import type { ConfigModel, ConfigOAuthInput, ConfigProvider } from '@agnes/protocol'
import { loginSubscription, type OAuthClient } from '@agnes/sdk/browser'

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
  const panel = document.createElement('section')
  panel.className = 'oauth-controls'
  panel.setAttribute('aria-label', '订阅登录')
  panel.hidden = true
  const status = document.createElement('p')
  status.className = 'oauth-status'
  status.setAttribute('role', 'status')
  const links = document.createElement('div')
  links.className = 'oauth-links'
  const prompt = document.createElement('label')
  prompt.className = 'form-field oauth-prompt'
  prompt.textContent = '授权码或回调地址'
  const answer = document.createElement('input')
  answer.type = 'password'
  answer.autocomplete = 'off'
  prompt.append(answer)
  prompt.hidden = true
  const button = (text: string) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = text
    return b
  }
  const browser = button('浏览器登录'),
    device = button('设备码登录'),
    cancel = button('取消登录'),
    submit = button('提交授权码')
  const actions = document.createElement('div')
  actions.className = 'oauth-actions'
  actions.append(browser, device, cancel)
  submit.className = 'secondary-button'
  submit.hidden = true
  cancel.hidden = true
  panel.append(actions, status, links, prompt, submit)
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
            const link = document.createElement('a')
            link.href = url.href
            link.target = '_blank'
            link.rel = 'noopener noreferrer'
            link.textContent = `打开 ${provider.label} 登录页面`
            links.append(link)
          },
          prompt: (value, signal) =>
            new Promise<string>((resolve, reject) => {
              prompt.firstChild?.remove()
              prompt.prepend(document.createTextNode(value.message))
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
