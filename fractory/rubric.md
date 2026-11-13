Judge the pull request diff against the issue it was built for. Approve only if all of these hold:

1. The change does what the issue asks (`spec_match`).
2. No scope creep: no changes the issue did not ask for (`scope_creep`).
3. Tests cover the change.
4. No loosened or skipped tests, no widened timeouts.
5. No secrets in the diff.
6. README/AGENTS are updated when behaviour changes.
