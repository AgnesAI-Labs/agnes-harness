# goal-ui

Default bundled client presentation. Its descriptor requires the active `ext:agnes/goal` backend row. Disable the feature or this UI package to remove its registrations. The backend implementation and durable event identity are unchanged.

The official `goal` presentation role uses priority 100; replacements conventionally use 0. Browser source lives in `packages/web-conversation/src`. Regenerate with `node tools/build-feature-clients.mjs`, or verify with `--check`.
