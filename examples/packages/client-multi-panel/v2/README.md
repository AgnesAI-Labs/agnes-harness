# Client multi-panel v2 failure fixture

This fixture intentionally throws from only the secondary browser row. The primary row remains
valid so the real-browser acceptance proves row-level, rather than package-level, isolation.
