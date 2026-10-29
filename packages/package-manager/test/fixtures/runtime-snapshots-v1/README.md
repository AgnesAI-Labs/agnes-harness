# Plugin-core runtime snapshot v1 fixture

`home/` was written by the actual PackageManager at commit
`877a2c2976ca7cbf4ebd37655df968cd76d9aec4`, before bundle launch and application
projections were added. It contains only synthetic package files and account-free
package state. The example package exercises the original `category=example`
capability digest, including `launches`; both package-level and row metadata use
the original closed schema. The active pins and `session-original` turn pin are
writer output, not reconstructed by the current implementation.

To reproduce, archive that commit into an empty temporary source directory,
install its pinned dependencies, copy `capture.ts.txt` there as `capture.ts`, and
run `node --import tsx capture.ts /absolute/path/to/empty-home` with Node 24.
The generated home also contains the file-source trees. No daemon, model,
credentials or network source is involved in generation. Keep the original
snapshot records, pin request hashes, trust decisions and package bytes intact.
The formatter leaves `home/` unchanged because its original bytes are integrity-bound test evidence.

The fast PackageManager refusal tests consume this home as negative evidence.
Current AGH rejects its retired category/launches/kinds metadata and version-1
records with a clean-home hint, leaving the records, pins, trust decisions and
package bytes unchanged. It must never project these bytes into current trusted state.
