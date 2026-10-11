Shell commands already run inside PowerShell, so for them:

- Write commands and `$` variables directly. Never wrap a command in `powershell -Command` or `pwsh -Command`: the outer shell expands `$` and quotes in that string before the inner one runs.
- `curl` and `wget` may be aliases of Invoke-WebRequest. Call `curl.exe`, or Invoke-WebRequest with its own parameters.
- No bash syntax: no heredoc, `export`, or, in Windows PowerShell 5.1, `&&` and `||`. Pipe a here-string into the program instead (`@'` ends its line and `'@` starts one; for example into `python -`), set `$env:NAME = 'value'`, and separate commands with `;`.
- Pass `-Encoding utf8` every time you read or write a file with Get-Content, Set-Content, Add-Content or Out-File.
