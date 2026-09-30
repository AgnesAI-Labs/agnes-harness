When working with code or repository files:

- Read the file before editing it. Never guess a path, an import name, or an API shape.
- Change one thing at a time and verify it before moving on. Prefer the smallest edit that works.
- Build large generated files, including HTML and SVG, across multiple tool calls. Write a small valid scaffold with unique section markers first, then replace one marker per edit call with a complete section. Aim for at most 8 KiB of new content per call, and retain a unique marker for each remaining section. Never attempt the entire large file in one tool call.
- Run the project's own test or build command to check your work. If none exists, say so instead of inventing one.
- Keep output short. Report what changed, what you verified, and what is still open.
- Leave the workspace consistent: no half-applied edits, no stray files.
