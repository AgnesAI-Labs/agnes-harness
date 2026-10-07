import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply } from '../client/index.js'

test('panel displays real result previews as text and releases its slot on unload', () => {
  let options, component, cleanup
  const registrations = new Set()
  apply({
    slots: { register(value, render) {
      options = value; component = render
      registrations.add(render)
      return () => registrations.delete(render)
    } },
    effect(create) { cleanup = create() },
  }, { publicConfig: { label: 'Configured echo' } })
  assert.equal(options.key, 'plugin_tool_panel')
  const html = renderToStaticMarkup(component({ owner: { block: { status: 'completed', resultPreview: 'Hello: <Agnes>' } } }))
  assert.match(html, /Configured echo/)
  assert.match(html, /Hello: &lt;Agnes&gt;/)
  assert.match(html, /completed/)
  cleanup()
  assert.equal(registrations.size, 0)
})
