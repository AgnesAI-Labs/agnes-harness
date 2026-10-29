import { readFile } from 'node:fs/promises'

// Keep upstream measurements and cleanup under the shell's existing CSP: rc-util needs the
// document nonce, and rc-input must write its hidden measurement node through the CSSOM.
export const scrollbarCsp = {
  name: 'agnes-scrollbar-csp',
  setup(build) {
    // xterm 6's CoreBrowserService ternary selects window.document even when documentOverride
    // exists. Keep the terminal's nonce/layer adapter in force for viewport-generated rules too.
    build.onLoad({ filter: /[/\\]@xterm[/\\]xterm[/\\]lib[/\\]xterm\.mjs$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8')
      const target = 'this._document??typeof window<"u"?window.document:null'
      // DomRenderer also passes the global document to its row factory, bypassing the
      // scoped CSSOM adapter for ANSI true colors and minimum-contrast cell styles.
      const rowFactory = 'this._rowFactory=u.createInstance(Vt,document)'
      if (source.split(target).length !== 2 || source.split(rowFactory).length !== 2)
        throw new Error('Terminal CSP adapter needs review for this xterm version')
      return {
        contents: source
          .replace(target, 'this._document??(typeof window<"u"?window.document:null)')
          .replace(rowFactory, 'this._rowFactory=u.createInstance(Vt,this._document)'),
        loader: 'js',
      }
    })
    // The portal's body scroll lock also inserts a stylesheet outside ConfigProvider.csp.
    build.onLoad(
      { filter: /[/\\]@rc-component[/\\]portal[/\\](?:es|lib)[/\\]useScrollLocker\.js$/ },
      async ({ path }) => {
        const source = await readFile(path, 'utf8')
        const target = '}`, id);'
        if (source.split(target).length !== 2)
          throw new Error('Portal CSP adapter needs review for this rc-portal version')
        return {
          contents: source.replace(
            target,
            '}`, id, { csp: { nonce: document.querySelector(\'meta[name="agnes-csp-nonce"]\')?.content } });',
          ),
          loader: 'js',
        }
      },
    )
    build.onLoad(
      { filter: /[/\\]@rc-component[/\\]input[/\\](?:es|lib)[/\\]calculateNodeHeight\.js$/ },
      async ({ path }) => {
        const source = await readFile(path, 'utf8')
        const target = "hiddenTextarea.setAttribute('style', `${sizingStyle};${HIDDEN_TEXTAREA_STYLE}`);"
        if (source.split(target).length !== 2)
          throw new Error('Textarea CSP adapter needs review for this rc-input version')
        return {
          contents: source.replace(
            target,
            'hiddenTextarea.style.cssText = `${sizingStyle};${HIDDEN_TEXTAREA_STYLE}`;',
          ),
          loader: 'js',
        }
      },
    )
    build.onLoad(
      { filter: /[/\\]@rc-component[/\\]util[/\\](?:es|lib)[/\\]getScrollBarSize\.js$/ },
      async ({ path }) => {
        const source = await readFile(path, 'utf8')
        const target = '`, randomId);'
        if (source.split(target).length !== 2)
          throw new Error('Scrollbar CSP adapter needs review for this rc-util version')
        return {
          contents: source.replace(
            target,
            '`, randomId, { csp: { nonce: document.querySelector(\'meta[name="agnes-csp-nonce"]\')?.content } });',
          ),
          loader: 'js',
        }
      },
    )
  },
}
