Judge the pull request diff against the issue it was built for. When a BRIEF is given, it is the detailed scope the worker was given: the issue is the goal, and scope creep means beyond both. Approve only if all of these hold:

1. The change does what the issue asks (`spec_match`).
2. No scope creep: no changes the issue did not ask for (`scope_creep`).
3. Tests cover the change.
4. No loosened or skipped tests, no widened timeouts.
5. No secrets in the diff.
6. README/AGENTS are updated when behaviour changes.
7. A finding about lint, format or tests must be backed by the CI RESULTS or by a line in the diff. Never reject on something you say you could not verify (for example "could not confirm ruff passes"): list it in `unverified` instead of treating it as a defect.
