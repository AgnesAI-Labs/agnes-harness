---
name: add_part_and_build
description: "Add a part and build it with the studio build script"
---
When to use: the user asks to add a new part with given content and build it with the project's build script (repeated three times this session).

1. Write `parts/<name>.txt` containing exactly the requested line(s), e.g. `bore=8\n`.
2. Run `./build.sh <name>` with cwd `studio/` (the script takes the part name as its argument and must run from that directory).
3. Verify by listing/catting `studio/bundles/<name>.pack`; it should start with `PACK 1`, then `name=<name>`, then the part's keys.

Do not read build.sh or docs first; only inspect on failure. Build and verification can be combined in one shell call (e.g. `./build.sh <name> && cat bundles/<name>.pack`). Report the part file, the command, and the resulting pack contents.
