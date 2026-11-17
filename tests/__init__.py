"""Tests never reach the real Orca or pr-triage DB: the CLI's PR-review/worker cleanup step is stubbed out here.

`tests.test_prcleanup` imports the real module, so that step is still tested directly.
"""

from types import SimpleNamespace

from fractory import cli

cli.prcleanup = SimpleNamespace(run=lambda *args, **kwargs: 0)
