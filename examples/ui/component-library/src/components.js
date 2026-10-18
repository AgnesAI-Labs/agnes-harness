/** Audited code only. Model strings are assigned as text, never HTML or JavaScript. */
export const renderers = {
  '@example/ui-components/gauge@1'(mount, props, api) {
    const meter = document.createElement('meter')
    meter.min = 0
    meter.max = 100
    meter.value = props.value
    meter.setAttribute('aria-label', api.readLocale() === 'zh-CN' ? '完成进度' : 'Completion')
    mount.replaceChildren(meter, document.createTextNode(` ${props.value}%`))
    return () => mount.replaceChildren()
  },
  '@example/ui-components/note@1'(mount, props) {
    const text = document.createElement('p')
    text.textContent = props.text
    mount.replaceChildren(text)
    return () => mount.replaceChildren()
  },
}
