# SlotMap

Generated from schema/slots.json by tools/gen-docs.ts. Do not edit by hand.

One slot payload is capped at 65536 bytes. The cap is published here and enforced by the extension host and the UI projection, not by this package.

| slot | cardinality | order | surfaces | trigger | failPolicy | payload fields |
|---|---|---|---|---|---|---|
| `tool.card.inline` | multi | 100 | tui / web / channel | tool_result | open | `title`, `table?`, `chart?`, `actions?` |
| `sidebar.action` | multi | 200 | tui / web | turn_end / tick | open | `id`, `label`, `icon?`, `disabled?` |
| `status.line` | multi | 300 | tui / web / channel | tick | open | `text`, `level` |
| `notification` | multi | 400 | web / channel | turn_end | open | `title`, `body`, `link?` |
