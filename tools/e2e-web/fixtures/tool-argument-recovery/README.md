# Tool argument recovery fixture

A plain mechanism plugin for scripted browser acceptance: a read-only observation tool and an in-memory progress recorder. Both declare a two-failure argument limit. Three identical recorder calls exercise the real T0 repeated-write verdict, followed by one automatic correction. The plugin has no application, custom UI or permission handling. Core owns validation, retry exhaustion and fallback. No real business records are read or written.
