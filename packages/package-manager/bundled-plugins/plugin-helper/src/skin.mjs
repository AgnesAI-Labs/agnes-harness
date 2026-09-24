/** Self-contained skin files: no access to the source checkout or browser JavaScript required. */
export function skinFiles() {
  return [
    {
      path: 'package.json',
      content: JSON.stringify(
        {
          name: 'my-mint-skin',
          version: '0.1.0',
          type: 'module',
          license: 'Apache-2.0',
          exports: './index.mjs',
          agnes: {
            plugins: [{ id: 'ext:my-mint-skin/main', export: 'main' }],
            clientDescriptors: [
              { rowId: 'ext:my-mint-skin/main', path: './extensions/main/agnes.client.json' },
            ],
          },
        },
        null,
        2,
      ),
    },
    { path: 'index.mjs', content: 'export const main = { apply() {} }\n' },
    {
      path: 'extensions/main/agnes.client.json',
      content: JSON.stringify(
        {
          skins: [
            {
              id: 'mint',
              name: '薄荷绿',
              css: './skin.css',
              tokens: {
                '--agnes-brand-primary': { light: '#167c55', dark: '#72d6aa' },
                '--agnes-bg-page': { light: '#f2faf6', dark: '#101e19' },
                '--agnes-bg-app-content': { light: '#ffffff', dark: '#14251e' },
              },
            },
          ],
        },
        null,
        2,
      ),
    },
    {
      path: 'extensions/main/skin.css',
      content:
        '[data-agnes-region="sidebar"], [data-agnes-region="composer"] { background: #e6f5ed; }\n.dark [data-agnes-region="sidebar"], .dark [data-agnes-region="composer"] { background: #19382a; }\n',
    },
  ]
}
export const skinGuidance =
  'This is a pure CSS/tokens skin, not a tool. Use the supplied files directly; do not search the user workspace for AGH source/examples. Rename the package, row and skin id consistently. clientDescriptors.rowId must match agnes.plugins.id. Descriptor and CSS paths are relative to their containing file. Keep the empty exported main plugin; no inject, runtime, dependencies or browser JavaScript is needed. Preserve layouts and interactions. Use semantic tokens and data-agnes-region selectors; .dark provides dark-mode overrides. After install status reports ready, select the skin in Settings → General → Appearance. Verify both light/dark appearance in the browser. Disable the package to restore default appearance; ?skin=none is the recovery override. Backend running alone does not prove the browser applied the skin.'
