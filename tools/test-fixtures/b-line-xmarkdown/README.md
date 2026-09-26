# B-line W5a-0 XMarkdown boundary fixture

This isolated fixture runs the published `@ant-design/x-markdown@2.9.0` with React/ReactDOM
`18.3.1`. Its own `pnpm-lock.yaml` pins the full dependency graph. It is evidence for the W5a
connection design, not a production renderer or a default timeline switch.

## Reproduce

From the repository root with Node >=24.10 and pnpm 10.34.5:

```sh
pnpm install --frozen-lockfile
pnpm --filter @agnes/web build
pnpm install --dir tools/test-fixtures/b-line-xmarkdown --frozen-lockfile
pnpm --dir tools/test-fixtures/b-line-xmarkdown typecheck
pnpm --dir tools/test-fixtures/b-line-xmarkdown test
pnpm --dir tools/test-fixtures/b-line-xmarkdown build
pnpm exec tsx packages/web/src/serve-entry.ts --ws ws://127.0.0.1:4199 --port 4198 --root /private/tmp/agh-w5a0-browser
```

Open `http://127.0.0.1:4198/` in a browser. The last command runs the **actual Agnes Web
server**, including its file allowlist and CSP. The fixture creates its static root under
`/private/tmp/agh-w5a0-browser`, using the repository's built React vendors through the import
map. The `/style.css` file deliberately merges Agnes base CSS, XMarkdown's generated CSS and
the fixture theme bridge; `/tokens.css` is copied from web-ui. No daemon or external data service
is required. Stop the server with Ctrl-C after testing. The generated static root may be discarded;
the nested lockfile, source, and tests are the reproducible fixture.

`src/compat.test.jsx` separates installed defaults from fixture adaptation. The default test
observes live image nodes, a relative link and missing literal script text. The adapted tests
use the existing `packages/web/test/markdown.test.ts` GFM and safety strings, plus reference,
copy, syntax, selection/focus, final replacement and simple suffix cases. The browser controls
repeat the material cases under the project CSP and display DOM/CSP/resource observations in
the report block.

## Boundary findings

- The installed package's `html-react-parser@5.2.17` ESM entry imports its CommonJS build, which
  calls `require('react')`. Externalizing React without a bridge throws in the browser. The
  fixture's esbuild banner maps only that require to the same import-map React module and throws
  for any other external require. Production builds must verify this exact edge on both Web and
  CLI artifacts before adopting the bridge.
- Its `es/XMarkdown/index.d.ts` imports `./index.css`; TypeScript 7 Bundler mode needs a CSS
  side-effect declaration in the consuming project. The fixture includes `src/css.d.ts`.
- `XMarkdown` imports core CSS itself. esbuild emits a CSS companion when bundling it. The
  browser fixture explicitly merges that output into `/style.css` and loads it, so no unlinked
  CSS chunk is relied upon. Production Web and CLI must do the same or explicitly link a named
  static CSS asset.
- The candidate policy in `src/adapt.jsx` is intentionally local to the fixture. Its escaped-tag
  protection, safe link renderer, image-as-text renderer, code control and update coordinator
  demonstrate feasible extension points. They are not exhaustive security or streaming code;
  W5a and W5b must add the production component and focused regressions.

The complete evidence, component and asset proposal, limitations and continuation are in
`docs/task-records/b-line-w5a-0-xmarkdown.md` in this checkout (task records are locally ignored).
