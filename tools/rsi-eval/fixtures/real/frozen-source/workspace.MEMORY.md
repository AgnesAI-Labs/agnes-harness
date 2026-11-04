<!-- refinement:rehndcaoaey -->
Run tools first when asked; correct from error output
When the user says to just run a build script or tool and not read its source or docs first, do that: invoke it directly instead of inspecting code or documentation.

If the user states a requirement outright (e.g. "build.sh must be run from inside studio/"), apply it on the first attempt instead of rediscovering it through an error.

If an invocation fails, treat the error message as the primary diagnostic. Extract the stated requirement (e.g. required working directory, missing argument, wrong path form) and retry once with the corrected command/cwd. Do not open the tool's source to work out the fix.

When reporting, state the final successful command, the bundle/output produced, and briefly note what the first failure was and how the error message dictated the fix. Only read source or docs if a retry also fails or the user asks.
<!-- /refinement:rehndcaoaey -->

## parts project build conventions

- `studio/build.sh` must be run from inside the `studio/` directory (e.g. `cd studio && ./build.sh <part>`); running it from the repo root fails with "../parts not found".
- Parts are single-line text files in `parts/<name>.txt`; the build writes `studio/bundles/<name>.pack`.

<!-- refinement:r9bj1t52h1a -->
Verify memory-file writes by re-reading; don't loop on denied paths
Ordinary file tools are not a reliable way to persist to the agent memory store. Observed: an `edit` to MEMORY.md returned "applied 1 edit(s)" but a re-read showed the original content unchanged; a topic file reported as created could not be read back ("requested path outside workspace"); `ls` on that directory returned E_FS_DENIED.

So:
- After any write or edit to a memory file, re-read it. Only claim persistence if the new content is actually there.
- If the read shows no change, do not retry through shell, ls, find, aliases or another path: that directory is outside the workspace and policy-denied. Respect the refusal.
- Report honestly that the memory could not be confirmed as saved, and treat the memory provider / refinement request as the persistence path rather than asserting success.
<!-- /refinement:r9bj1t52h1a -->

<!-- refinement:r3fq24rboyr -->
Part/build convention: parts/<name>.txt -> studio/build.sh -> studio/bundles/<name>.pack
Project layout observed: top level has README.md, parts/ and studio/. Parts are plain text files parts/<name>.txt with single key=[REDACTED] lines (e.g. parts/bolt.txt contains `thread=4`); a new part should match that convention, including the trailing newline.

The build script is studio/build.sh and takes the part name: `cd studio && ./build.sh valve` exits 0 and prints `wrote studio/bundles/valve.pack`. Output bundles land in studio/bundles/ as <name>.pack, containing a `PACK 1` header, `name=<name>` and the part's lines.

To add a part: read an existing parts/*.txt to copy the format, write parts/<name>.txt, run the build script, then check the bundle (exists, expected contents). Building one part leaves the other bundles untouched.
<!-- /refinement:r3fq24rboyr -->
