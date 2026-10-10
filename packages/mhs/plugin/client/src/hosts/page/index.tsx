/**
 * The panel on a page of its own, without the workbench: the same components with React bundled
 * in. AgnesHub's address comes from `?hub=` (default: the page's own host), the language from
 * `?lang=`, the remembered choice, or the browser.
 */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Store } from '../../core/store.js'
import { setLocale } from '../../i18n/i18n.js'
import { Panel } from '../../layout/panel.js'
import { NavContext, StoreContext } from '../../react/hooks.js'
import '../../style.css'

const params = new URLSearchParams(location.search)
const hub = params.get('hub') ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/hub`
let lang = params.get('lang')
try {
  lang ??= localStorage.getItem('mhs.lang')
} catch {
  // Private windows remember nothing.
}
setLocale(lang ?? (navigator.language.startsWith('zh') ? 'zh-CN' : 'en'))
// Dark like the device console, unless asked for light.
const dark = params.get('theme') !== 'light'

const store = new Store(hub.endsWith('/ws/hub') ? hub : `${hub.replace(/\/$/, '')}/ws/hub`)

function App() {
  const [device, setDevice] = useState<string | undefined>(params.get('device') ?? undefined)
  return (
    <StoreContext.Provider value={store}>
      <NavContext.Provider value={{ device, open: setDevice }}>
        <div className={`mhs-root mhs-standalone${dark ? ' mhs-dark' : ''}`}>
          <Panel />
        </div>
      </NavContext.Provider>
    </StoreContext.Provider>
  )
}

createRoot(document.getElementById('app') as HTMLElement).render(<App />)
