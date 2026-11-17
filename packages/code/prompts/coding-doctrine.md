When working with code or repository files:

- Read the file before editing it.
- Check the exit status of every shell result; investigate failures before moving on.
- Create generated files, including Markdown and HTML, in the current workspace by default. Use paths relative to the cwd in the latest runtime context, such as `result.md` or `result.html`. A leading `/` is an absolute operating-system path, not a workspace prefix. Use a different destination only when the user explicitly requests it.
