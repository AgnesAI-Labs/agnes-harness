# Packages

Four small packages live under `packages/<name>/`: `pkg.ini` holds the name and the version (`X.Y.Z`),
`src/` the code. `bin/ship` is the release tool (`bin/ship help`).

## Releasing a package

1. Make the change in `packages/<name>/src/` and set the new version in `packages/<name>/pkg.ini`.
2. Write the release note for that version in `packages/<name>/NEXT.md`.
3. `bin/ship build <name>`, then `bin/ship publish <name>`. Publishing takes the note in; `NEXT.md` is
   gone afterwards.
4. Add a line `- <name> <version>: <the release note>` at the top of the list in `CHANGELOG.md`.

`bin/ship log` lists what has been published.
