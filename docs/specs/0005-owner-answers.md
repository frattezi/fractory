# Spec 0005: Owner Answers

Status: accepted (2026-11-26). Vocabulary: [GLOSSARY.md](../../GLOSSARY.md). Builds on
[Spec 0002](0002-host-limits-and-re-runs.md), [Spec 0004](0004-ticket-dependencies.md) and ADR 0002.

## Goal

A Run that stops with `needs-human` is a dead end today. The question reaches the owner — in
`fractory status`, as a Ticket comment in Personal Mode, in Fractory Manager's Runs view — but the
answer has no way back. The only action is a Re-run, which starts the Ticket again on its branch
with nothing in its prompt about what the owner decided, so the next Run hits the same wall. The one
mechanism that does carry the owner's words into a prompt, the review-comment follow-up, is skipped
when the Ticket has no pull request, which is exactly the state a `needs-human` Run leaves it in.

The owner must be able to answer the question where they already read it, and that answer must reach
a new Run on the Ticket's branch and survive beyond it.

## Non-goals

- Interacting with a Run that is already running. A Run has no human in the loop; an Answer starts a
  new Run, it never resumes the stopped one.
- An agent that attempts the question before the owner sees it (triage). Separate Spec, once this
  channel exists.
- Answering a `failed` Run. Guidance on a failure stays a Re-run.
- Resuming the stopped Run's agent session. `sessionId` is recorded and still unused.
- Notifications. The owner finds the question the way they do today.
- A web or editor-based input. The field is in the Runs view.

## Solution

**Answer.** On a `needs-human` row in Fractory Manager's Runs view, `A` opens a bordered multi-line
field showing the Run's reason and question. Enter sends the answer, Esc cancels. The Manager writes
the answer to `<registryDir>/<runId>.answer.json`, atomically, the same way it writes a Re-run
request; Fractory only reads it. The row shows a pending marker until the next tick queues the Run.

**The Run the Answer starts.** The next tick turns the file into a Run on the Ticket's branch with
an `answer` Trigger, keyed `<ticketRef>:answer:<runId>`, so one answer yields one Run. The agent's
prompt carries the original reason and question with the owner's answer, marked as the owner's
decision and binding. Answer Runs start with the owner's other Runs, before follow-ups and new
Tickets. Nothing is queued while a Run on the Ticket is already queued or running: the answer waits
for a later tick, like a review comment does.

**The answer outlives the Run.** Before queueing, the tick posts the answer as a comment on the
Ticket, under the question Fractory already posted there, so a later Run on the same Ticket reads the
decision instead of asking again. In Work Mode the comment passes `assertOutboundAllowed`. A comment
that cannot be posted is logged and the Run is queued anyway: the answer is never lost because the
tracker was unreachable.

**Seeing it from a terminal.** `fractory status` marks a Ticket whose question has been answered but
whose Run has not been queued yet, so the owner is not told to answer something twice.

## User stories

1. As the owner, I want to answer a `needs-human` question on the Run's row in Fractory Manager, so that I do not need a terminal or the tracker.
2. As the owner, I want the question and its reason shown above the field while I type, so that I answer what was actually asked.
3. As the owner, I want a multi-line field, so that an answer with two sentences or a list is not cramped into one line.
4. As the owner, I want Esc to cancel without writing anything, so that opening the field by accident costs nothing.
5. As the owner, I want `A` offered only when the Ticket's latest Run needs a human and has no answer yet, so that the footer never offers an action that does nothing.
6. As the owner, I want a pending marker on the row after I send, so that I know my answer was received before the tick runs.
7. As the owner, I want a second answer on the same Run before the tick to replace the first, so that fixing a typo does not queue two Runs.
8. As the owner, I want my answer to reach the agent's prompt with the question it answers, so that the agent knows what the answer is about.
9. As the owner, I want the agent told my answer is binding, so that it does not re-litigate a decision I made.
10. As the owner, I want the Answer Run to continue on the Ticket's branch, so that the work the stopped Run committed is not thrown away.
11. As the owner, I want Answer Runs to start before follow-ups and new Tickets, so that unblocking is not stuck behind a batch.
12. As the owner, I want no Run queued while one is already active on the Ticket, so that two agents never work on one branch.
13. As the owner, I want my answer posted as a comment on the Ticket, so that the decision is on the record and a later Run can read it.
14. As the owner, I want a tracker that is down not to lose my answer, so that the Run is queued regardless.
15. As the owner, I want the answer comment to obey Work Mode's outbound rules, so that nothing about the factory leaks into a shared tracker.
16. As the owner, I want `fractory status` to show that a question is already answered and waiting, so that I do not answer it twice from a terminal.
17. As the owner, I want Fractory never to modify or delete the answer file, so that the Manager stays its only writer.
18. As the owner, I want an invalid or half-written answer file to be skipped and logged, so that one bad file never stops the factory.

## Implementation decisions

**Contracts (`src/contracts/run.ts`, its own commit, every caller updated).**

- Answer request at `<registryDir>/<runId>.answer.json`, written atomically by Fractory Manager,
  never modified by Fractory:

  ```ts
  export const ANSWER_REQUEST_VERSION = 1;
  { version: 1; answeredAt: string /* ISO */; answer: string /* min 1 */ }
  ```

  With `ANSWER_SUFFIX = '.answer.json'`, `answerRequestPath(registryDir, runId)` and
  `answerKey(ticketRef, runId) = `${ticketRef}:answer:${runId}``, mirroring the Re-run helpers.
- `TriggerSchema` gains `{ kind: 'answer', runId: string }`. `runKey` returns `answerKey` for it;
  the key is also passed explicitly, as Re-runs do.
- `RUN_RECORD_VERSION` stays 1: the record's shape does not change. The Manager's Go mirror of
  `TriggerSchema` gains the kind in this Spec, and an unknown Trigger kind must render as `unknown`
  rather than fail to parse the record.
- `RunRegistry.list()` filters `ANSWER_SUFFIX` out alongside `.comments.json` and `RERUN_SUFFIX`.

**Reading the requests (`src/registry/answers.ts`).** `listAnswerRequests(registryDir)` returns the
Run ids with a valid answer file, sorted, skipping invalid ones, and `readAnswerRequest(registryDir,
runId)` returns the parsed request or `undefined`. Modelled on `src/registry/reruns.ts`.

**Tick (`src/trigger/tick.ts`).** `handleAnswers(repoPath, config, source)` runs next to
`handleReruns`, before the launch step. For each answer file whose Run is in this repo: skip when a
Run with the key exists, when the target Run is not its Ticket's latest, or when the target is not
`needs-human` (log the reason, as Re-runs do); skip silently while a Run on the Ticket is `queued`
or `running`. Otherwise post the answer to the Ticket (`source.comment`, guarded by
`assertOutboundAllowed`, failures logged only), then queue a Run on the Ticket's branch with the
`answer` Trigger and that key, and set the Ticket `in_progress`. `launchGroup` returns 0 for
`answer`, with `manual`.

**Runner (`src/runner/execute.ts`, `src/runner/prompt.ts`).** `followUp()` handles the `answer`
Trigger: read the answer file for `trigger.runId` and that Run's `result` from the registry, and
build `{ kind: 'answer', reason, question, answer }`. When either cannot be read, the section says so
and tells the agent to find the owner's answer in the Ticket's comments. `followUpSection` adds the
`answer` case: the reason and question as context, the answer wrapped as data (never instructions),
stating it is the owner's decision and binding, and that the work continues on this branch and
finishes the Ticket.

**Rules (`rules/run-agent.md`).** The "Stopping for a human" section says what now happens after
`needs-human`: the owner answers, a new Run continues on the same branch with the answer, so a
question must be answerable on its own — and that an answer in the prompt is a decision, not a
suggestion.

**CLI (`src/status/status.ts`).** A `needsHuman` entry gains `answered?: boolean`, set when an
answer file exists for the Run, and `formatStatus` renders it as `(answered, waiting for the next
tick)`. `repoStatus` stays pure: the caller passes the answered Run ids.

**Documentation.** `GLOSSARY.md` gains **Answer** under "Human oversight" (the owner's reply to a
`needs-human` question, which starts a Run on the Ticket's branch; _avoid_: reply, response, input).
`docs/flows.md` and `docs/runner.md` cover the Trigger and the prompt section; the `fractory` skill's
needs-human row points at the Manager's `A` instead of a hand fix plus `fractory run`.

**Fractory Manager fork (`frattezi/agent-manager`, branch `fractory/runs-view`).** Tickets there are
created only after the contract above is merged, so the Go side is written against a file format
that exists.

- `A` on a selected Ticket row whose latest Run is `needs-human` and has no answer file opens the
  field: a bordered pane showing `<runId> · <ticketRef> · <reason>`, the wrapped question, and a
  multi-line input. Enter writes the request atomically; Esc discards. A second answer overwrites
  the file.
- Row marker while an answer file exists without its Run: `✎…`, `A…` in Compatible mode, next to the
  existing `↻N` Re-run marker.
- The footer lists `A answer` only when the action is available, through the existing contextual key
  legend.
- The detail pane shows the `answer` Trigger kind for Runs an Answer started.

## Testing decisions

Behaviour through the highest seam, every external process stubbed, no network:

- **`tick` harness** (`tests/trigger-helpers.ts`): an answer queues one Run on the Ticket's branch
  with the `answer` Trigger and key; a duplicate key queues nothing; an answer on a Run that is not
  the Ticket's latest, or not `needs-human`, is skipped and logged; nothing is queued while a Run on
  the Ticket is active; the answer is posted to the Ticket; a failing `comment` still queues the
  Run; an invalid answer file is skipped; `answer` Runs launch before follow-ups and `ticket-ready`.
- **`prompt`** (`tests/runner-prompt.test.ts`): the `answer` section carries the reason, question and
  answer, marks the answer as data and as binding, and the fallback text appears when the answer or
  the question is missing.
- **`runner`** (`tests/runner-execute.test.ts`): an `answer` Trigger builds the follow-up from the
  answer file and the target Run's result, and a missing file does not fail the Run.
- **`registry`**: `listAnswerRequests` ignores invalid files; `RunRegistry.list()` ignores answer
  files.
- **`status`/CLI**: `answered` is set and rendered; Work Mode rejects a forbidden answer comment.
- **Fork** (Go tests in `internal/ui/runs`): the key is offered only when it applies, the file is
  written atomically and overwritten by a second answer, the marker and the detail pane render, and
  an unknown Trigger kind parses as `unknown`.

## Open questions

- Whether a Ticket comment is enough for a decision that really belongs in the Spec or `AGENTS.md`.
  The Run can say so in its summary; promoting it stays the owner's job for now.
- Whether `budget-exhausted` deserves its own path (a continuation Run with a larger budget, no
  answer needed) rather than an answer saying "keep going".
