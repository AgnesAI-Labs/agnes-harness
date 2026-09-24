# Compaction parity fixtures

These cases cover threshold selection, overflow retention, split turns, pins, replacement of a leading summary, and cuts inside a tool loop. Fixtures are synthetic data and are checked by the planner tests.

Core validates call/result pairing across each replacement boundary. A cut can follow a completed tool result without retaining the entire turn:

- `threshold-basic` keeps from sequence 8 with the prefix `[5, 7]`: the cut lands on the assistant
  after `r7`, whose batch closes inside the prefix. It used to keep from 6 with prefix `[5, 5]`.
- `one-turn` now compacts instead of refusing. The first turn has no earlier history, so `[1, 3]` is
  summarized as one range marked `inProgressTail`, which asks the prompt to record the opening
  request.
- `trailing-tool-batch` keeps only the final assistant; the two-result batch now sits in the prefix
  `[5, 8]` with its assistant call instead of being kept.
