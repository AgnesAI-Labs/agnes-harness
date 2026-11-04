# textkit

Four small text helpers in `src/textkit/` (slug, roman, wrap, plural), each a function
`run(text) -> str`. Each has a test suite in `tests/<suite>/`: one case per `.case` file, with two lines,

    input: <what run() is given>
    expect: <what it must return>

`bin/harness` runs the suites and keeps the team dashboard (`bin/harness help`): `bin/harness run <suite>`
runs a suite, and `bin/harness record <suite>` puts its latest run on the dashboard
(`bin/harness dashboard`).
