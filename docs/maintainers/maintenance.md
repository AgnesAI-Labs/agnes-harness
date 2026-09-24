# Documentation maintenance

English | [简体中文](maintenance.zh-CN.md)

<a id="文档维护"></a>

[Documentation](../README.md) · [Verification](verification.md) · [Release checks](release.md) · [Licensing](provenance.md)

Root [README.md](../../README.md) is the default English project overview; [README.zh-CN.md](../../README.zh-CN.md) is its Chinese edition. [README.en.md](../../README.en.md) preserves the old English URL as a navigation page without a duplicate body. `docs/` contains user guides, development tutorials, and technical references. Package generators own generated package documentation.

<a id="项目表达"></a>

## Project narrative

- Lead with what AGH helps people do, with clear paths to try, build, and give feedback. Connect claims to tutorials, implementation, or reproducible evidence.
- Keep both README editions and every documentation pair aligned on positioning, supported scope, commands, and collaboration policy.
- Describe concrete scenarios without unsupported performance figures, customer claims, or compatibility promises.
- Keep MHS goals and availability in the [device direction](../guide/mhs.md). “Coming soon” describes AGH's integration guides and examples.
- Retain third-party licensing and attribution in LICENSE, NOTICE, and [licensing](provenance.md). Research narratives, internal tasks, and writing references do not belong in user guides.

<a id="随代码更新"></a>

## Update documentation with the code

| Change | Pages to update in both languages | Verification |
| --- | --- | --- |
| CLI, builds, background discovery | [Installation](../guide/install.md), [command reference](../reference/cli.md), both READMEs | Argument tests, full build, local process acceptance |
| Model accounts and routes | [First run](../guide/quickstart.md), [configuration](../reference/configuration.md) | Configuration tests and separate real-provider checks |
| Web, sessions, authentication | [Web](../guide/web.md), [sessions](../guide/sessions.md), [security](../guide/security.md) | Protocol tests and browser interaction |
| Plugins, MCP, Skills | [Extensions](../develop/plugins.md), [MCP](../guide/mcp.md), [Skills](../guide/skills.md) | Examples, authorization, updates, and cleanup |
| Skins and interface contracts | [Skins](../develop/skins.md) | Tokens, region hooks, and package manifest checks |
| Architecture, schemas, APIs | [Architecture](../develop/architecture.md), [API](../reference/api.md), generated package references | Call-chain review, generation checks, and consumer tests |
| Support and releases | [Limitations](../reference/limitations.md), [capabilities](../reference/capabilities.md), [release](release.md) | Evidence for the specific version and environment |

## Bilingual documentation contract

- Every maintained Markdown page under `docs/` has an English `name.md` and a complete Simplified Chinese `name.zh-CN.md`. The English page is the default. Neither edition is a summary or placeholder for the other.
- Put `English | [简体中文](name.zh-CN.md)` on the English page and `[English](name.md) | 简体中文` on the Chinese page. The switch opens the corresponding topic, not the language index.
- Keep navigation and tutorial links within the current language. Shared source, schemas, generated references, licenses, and bilingual root policies can use the same target.
- Update both editions in the same change. Keep commands, identifiers, defaults, limits, prerequisites, and expected outcomes equivalent. Translate explanatory prose, diagram labels, and sample prompt text without changing executable contracts.
- Existing Chinese deep links on default English pages are preserved with explicit anchor aliases. Keep these aliases when revising headings. New links should use the current edition's headings.
- Review semantic accuracy as well as structure. Pair/link checks detect missing files and navigation mistakes, but cannot prove that translations preserve every technical meaning.

<a id="文档检查"></a>

## Documentation checks

```sh
node tools/public-docs/verify.mjs
pnpm exec vitest run tools/public-docs/examples.test.ts --maxWorkers=1
pnpm gen:check
```

The checker verifies root entry points, translation pairs, language switches, links and anchors, common sensitive-data patterns, and the [source-check manifest](../../tools/public-docs/source-checks.json). It does not fetch external URLs or replace tutorial execution, browser acceptance, or distribution review. Modify generators before regenerating package documentation.

Check the actual source when changing steps or failure semantics. Report tests, builds, and external acceptance separately; see [verification](verification.md) for reproducible commands and scope, and [versioning](versioning.md) for version and npm policy.
