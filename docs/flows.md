# Writing a flow

A flow is the part of a Run where agents work. You write it in TypeScript against Sandcastle's API,
the same way Sandcastle's templates do. Fractory keeps everything deterministic around it: Ticket
status, worktree, pre-push hook, follow-up context, push, PR, Ticket updates, Work Mode checks.

A flow lives at `flows/<name>.ts` in this repository and `export default`s a function.

## The contract

```ts
// src/flows/types.ts
type Flow = (ctx: FlowContext) => Promise<RunResult>;
```

`FlowContext`:

| Field | What it is |
| --- | --- |
| `ticket` | The Ticket (`ref`, `title`, `body`, `url`, ...) |
| `repoConfig` | The repository's `.fractory.json`, parsed (`mode`, `baseBranch`, ...) |
| `followUp` | CI log, review comment or Answer for a follow-up Run, already loaded; `undefined` otherwise (see below) |
| `rules` | Text of `rules/run-agent.md` |
| `worktree` | The real Sandcastle `Worktree` Fractory created. Call `worktree.run(...)` or `worktree.createSandbox(...)` |
| `sandbox` | The Docker sandbox provider for the repo's `sandboxImage`. Pass it as `sandbox` |
| `agents.claude(model?, options?)` | `Promise` of Sandcastle's `claudeCode(...)` provider, wired with this Mode's account |
| `agents.opencode(model?, options?)` | Same for `opencode(...)`. Personal Mode only |
| `logPath` | Pass as `logging: { type: 'file', path: ctx.logPath }` |
| `maxIterations` | From `.fractory.json` |
| `completionSignal` | The string `buildPrompt` tells the agent to print; pass it as `completionSignal` |
| `buildPrompt(...)` | Rules + Ticket + follow-up + the "how to finish" block (the `<result>` JSON contract) |
| `parseRunResult(stdout)` | The last valid `<result>` block of the agent's output, or `undefined` |

The return value is a `RunResult` (`src/contracts/run.ts`):

- `{ outcome: 'done', summary }`: Fractory checks there are commits, pushes, opens or reuses the PR
  and moves the Ticket to `in_review`.
- `{ outcome: 'failed', summary }`: the Run fails; nothing is pushed.
- `{ outcome: 'needs-human', reason, question }`: the Run waits for the owner. `reason` is one of
  `ambiguous-spec`, `needs-access`, `destructive-op`, `budget-exhausted`.

Fractory validates the result with `RunResultSchema`. A throw or an invalid value fails the Run.

## Follow-up context

`ctx.followUp` follows the Run's Trigger (`FollowUp` in `src/runner/prompt.ts`). Pass it to
`buildPrompt`, which turns it into a section after the Ticket:

| Trigger | `followUp` | Prompt section |
| --- | --- | --- |
| `ticket-ready`, `manual` | `undefined` | none |
| `ci-failed` | `{ kind: 'ci-failed', prNumber, log }` | the failing CI log, as data |
| `review-comment` | `{ kind: 'review-comment', prNumber, comment }` | the review comment, as data |
| `answer` | `{ kind: 'answer', reason, question, answer }` | the question and the owner's Answer |

An `answer` Run starts when the owner answers a `needs-human` Run's question in Fractory Manager
(`<registryDir>/<runId>.answer.json`). The tick queues one Run per Answer on the Ticket's branch,
keyed `<ticketRef>:answer:<runId>`, once no other Run on the Ticket is queued or running, and posts
the Answer on the Ticket first. Its section gives the earlier Run's reason and question as context
and the Answer wrapped as data, stated as the owner's decision and binding, and tells the agent to
continue on this branch until the Ticket is finished. A field that could not be read is
`undefined`; the section then says so and points the agent at the Ticket's comments, where the
Answer is posted under the question.

## Rules

1. Return a `RunResult`. Do not rely on side effects to signal the outcome.
2. Never push, open PRs or touch the tracker. Commits on the worktree's branch are the output.
3. Credentials come only from `ctx.agents`. Never read the Keychain or `process.env` for them. An
   agent's `env` option cannot override the account.
4. `agents.opencode()` throws in Work Mode (the Mode allows Claude only). Let it throw: the Run fails
   with that message.
5. Everything the flow prints or returns can end up in the registry. No secrets.

## A minimal flow

```ts
// flows/hello.ts
import type { Flow } from '../src/flows/types.ts';

const hello: Flow = async (ctx) => {
  const result = await ctx.worktree.run({
    agent: await ctx.agents.claude('claude-sonnet-4-6'),
    sandbox: ctx.sandbox,
    prompt: ctx.buildPrompt({ rules: ctx.rules, ticket: ctx.ticket, followUp: ctx.followUp }),
    maxIterations: ctx.maxIterations,
    completionSignal: ctx.completionSignal,
    logging: { type: 'file', path: ctx.logPath },
  });

  const parsed = ctx.parseRunResult(result.stdout);
  if (parsed) return parsed;
  return { outcome: 'failed', summary: 'The agent finished without a valid result block.' };
};

export default hello;
```

`flows/build.ts` is the real default flow and the best reference: one `worktree.run` with Claude,
plus `budget-exhausted` when the agent never printed the completion signal.

## Adapting a Sandcastle template

Templates live in `node_modules/@ai-hero/sandcastle/dist/templates/` (for example
`sequential-reviewer/main.mts`). To port one:

- Delete the outer loop that picks issues, the branch naming and the merging. Fractory owns the
  Ticket, the branch and the push. One Run is one Ticket.
- Replace `sandcastle.claudeCode("...")` with `await ctx.agents.claude("...")`, and `docker()` with
  `ctx.sandbox`.
- Replace `sandcastle.createSandbox({ branch, ... })` with `ctx.worktree.createSandbox({ sandbox:
  ctx.sandbox })`: the worktree already is on the Run's branch. It returns a `Sandbox` whose
  `run(...)` you call once per agent, and which you `close()` in a `finally`.
  Calling `ctx.worktree.run(...)` several times also works, one sandbox per call.
- Replace `promptFile` with `prompt` built from `ctx.buildPrompt(...)` (and your own extra text
  for a reviewer step). Keep `promptArgs` if you like Sandcastle's placeholders.
- Keep the agent calls, their order and their prompts. Decide the final `RunResult` from the last
  agent's output with `ctx.parseRunResult`, or from the commits, and return it.

## Choosing a flow

In the target repository's `.fractory.json`:

```json
{ "flow": "hello" }
```

The name matches `[a-z][a-z0-9-]*` and maps to `flows/<name>.ts`. The default is `build`. An unknown
flow, or a default export that is not a function, fails the Run with a clear summary before any
worktree is created.

## Trying a flow locally

1. `pnpm fractory run <ticket-ref>` queues a manual Run and prints its id.
2. `pnpm fractory run-exec <id>` runs it in the foreground, in your terminal, with the real
   Sandcastle and Docker. Follow the log at the Run's `logPath`.
3. Inspect the result: `mode`, `flow`, `agents` (e.g. `claude@personal`) and `sessionId` are on the
   Run record. Use a throwaway Ticket and a Personal Mode repo.

Credentials must be in the Keychain first (see `docs/runner.md`); otherwise the Run stops with
`needs-human` / `needs-access` and tells you the exact command.
