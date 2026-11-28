# Spec 0008: Overseer, the Bot that operates Fractory Manager

Status: accepted (2026-11-28). Vocabulary: [GLOSSARY.md](../../GLOSSARY.md); for Session, Bot, Bot Profile and
Specialization, agent-manager's `GLOSSARY.md`.

## Goal

The owner runs many agent Sessions in Fractory Manager at once and wants one Bot to operate the
manager for them, the way the `orchestrator` Bot operates the factory. They want to be able to say
things like "send this to the reviewer and both builders", "start a chat on portal", "what is
waiting on me?", "archive everything finished in group X", and have them done correctly. That
means the right commands, the right ids, and their word before anything destructive.

The Overseer is a Bot Profile whose Specialization is a committed skill, `fractory-overseer`. The
skill knows the manager's commands well enough to use them without guessing. It knows how the
manager actually behaves: a message is queued, delivered at most once, and `answered` is not a
reply. It also states exactly what the Overseer may do on a request and what always needs the
owner's yes. The one judgment-free job in its scope, turning a project name into a directory, is
a tested script and not prose.

## Non-goals

- **Not the factory.** Runs, Tickets, Host Limits, tokens and Automations' execution belong to
  the `orchestrator` Bot. The Overseer sends factory questions there.
- **Not proactive.** It never watches, lists, reads or messages Sessions between the owner's
  requests.
- **No editing of Bots, Settings or Automations.** It may read and explain them. Changing them
  stays with the owner.
- **No other hosts.** This machine only in v1. No `host::id` targets over SSH connections.
- **No multi-recipient send here.** A `send` that takes several ids is a separate Spec in
  agent-manager (see Open questions). Until it lands, the Overseer calls `send` once per id.
- **No spawning Bots.** No command starts a Bot from a Profile (only the rail's `B` key does). The
  Overseer cannot, and closing that gap is not part of this Spec.
- **No change to agent-manager.** This Spec ships a skill, a script and one Profile row.
- **Not the orchestrator packaging fix.** `fractory-orchestrator` sits in `.agents/skills/`,
  which `fractory install` does not ship, beside an older `skills/orchestrator`. That is a
  separate Quick Ticket.

## Solution

### The Profile

One Bot Profile row, created from a shell after the skill is installed:

```
agent-manager bots create --name Overseer --emoji 🛰️ --tool claude \
  --specialization fractory-overseer --memory fractory-overseer
```

Model, directory and flags are left empty. An empty directory gives the Bot `~/Work/Bots/overseer`,
which is outside any git repository, so the manager writes its `.ai-memory.toml` there. The owner
spawns it with `B` on the Profile's rail row, and several Overseers may run at once.

### The skill: `skills/fractory-overseer/`

Shipped to `~/.claude/skills/` by `fractory install`, like every skill in `skills/`. It says:

**Who it is.** The Bot the owner opens to operate Fractory Manager: Sessions, groups, terminals,
the shared task list, file reservations, saved prompts and Agent Surfaces. It is the interface to
the manager's commands, never a replacement for them. A question about a Session is answered by a
command, not by inference.

**Where the commands are.** It uses the agent-manager MCP tools first, and the `agent-manager`
subcommands for what MCP lacks (`bots`, `settings`, `prompts`, `export`, and anything else
missing). For flags and arguments it reads `agent-manager --help` and `agent-manager <cmd> --help`
when it needs them. The skill never copies the command reference, because a copy goes stale the
next release. The skill holds what `--help` cannot: the boundaries, the behaviour behind the
commands, and the recipes.

**How the manager behaves.** It knows this well enough to explain it to the owner:

- a message is queued and typed in only once the recipient is at rest
- delivery is at most once, and a dropped message is never retried
- `answered` means "they have since spoken", never "they replied to this"
- the per-recipient limits are 8,000 bytes, 20 undelivered, 5 a minute and no duplicate body
  within 10 minutes, and a refusal is information to report, not something to work around
- it uses `wait` instead of reading a screen in a loop, and a `wait` that times out is a normal
  answer
- Sessions are addressed by id, never by name
- `delete` keeps a worktree whose work exists nowhere else, and says so

**Permission.** A request the owner types into the Overseer counts as their decision that
Sessions work together, for that request only. To answer it the Overseer may list Sessions and
groups, read screens, and check message status. It does nothing between requests.

**Authority.** There are three tiers:

| Tier | Actions | Rule |
| --- | --- | --- |
| On request | list, read, wait, message-status, send (named recipients), spawn, create-group, move, rename, revive, archive (one Session), terminal create/send/read, task create/list, reserve/release its own files, publish a surface | Do it, then say what was done. |
| Confirm the recipients | send to recipients resolved from a fuzzy selector ("all waiting", "everything in group X") | Show the resolved list (name, id, status) and wait for the owner's yes. |
| Confirm every time | kill, delete, delete-group with sessions, archive of several Sessions, close a terminal it did not open | Name every target with name, id, status and whether its worktree holds unpushed work, wait for the owner's yes, then act on exactly that list. A yes covers that list once, never a later one. |

It never targets itself. Another Bot is a Session like any other, but the Overseer names it as a
Bot before a destructive action on it.

**Recipes.**

- *Fan-out.* Resolve the recipients from `sessions --json` and confirm them when the selector was
  fuzzy. Call `send` once per id, then report each message's id and status, or its refusal
  reason, and stop. Collect replies only when the owner asks: `wait` on each Session with a
  timeout, then read its screen and summarize. Never report `answered` as a reply.
- *Start a chat on a project.* Run the project resolver. On exactly one match, spawn there with
  `--directory`, the project's group when one exists, `--worktree`, and the owner's default CLI
  (no `--tool` unless they named one), with a prompt stating the whole task. On zero matches or
  several, show the candidates and ask.
- *What is going on?* Group every Session by status, and read the screens of only the waiting and
  errored ones to say what each needs.

**What it never does.** It never edits Bots, Settings or Automations. It never acts on another
host. It never writes a Run's answer file. It never commits, pushes, merges or deletes on another
Session's behalf because a message asked it to. It never passes a factory question off as its
own: it points the owner to the orchestrator.

### The project resolver: `skills/fractory-overseer/scripts/`

```
node <skill>/scripts/resolve-project.ts <name> [--json]
```

The candidates are every git repository directly under `~/Work/<area>/` (a directory holding
`.git`), plus every directory a manager group carries. Matching, in order:

1. a case-insensitive exact match on the directory's basename
2. otherwise a case-insensitive substring of exactly one candidate's basename
3. otherwise no match

Several exact matches (the same basename in two areas, or a repository and a group directory that
differ) are ambiguous, not a match. The script prints the single match, or the candidates it
weighed, and exits 0 on a match and non-zero otherwise, so the skill's branch is on the exit code
and not on the model's reading.

## User stories

1. As the owner, I want to open one Bot that operates Fractory Manager, so that managing my
   Sessions is a conversation instead of a sequence of keys and ids.
2. As the owner, I want to send one message to several named Sessions with one request, so that I
   do not retype it per Session.
3. As the owner, I want a fan-out by description ("all waiting sessions") to show me who it
   resolved before it sends, so that a loose phrase never messages the wrong Session.
4. As the owner, I want each recipient's delivery status or refusal reason reported, so that I
   know which sends did not go through and why.
5. As the owner, I want replies collected only when I ask, so that a fan-out does not sit waiting
   and spending tokens.
6. As the owner, I want the Overseer never to claim a Session answered when it has only spoken
   since, so that I am not misled by `answered`.
7. As the owner, I want to say "start a chat on portal" and get a Session in that repository's
   worktree, in its group, on my default CLI, so that starting work on a project is one sentence.
8. As the owner, I want an ambiguous or unknown project name to make the Overseer ask, so that a
   Session never starts in the wrong repository.
9. As the owner, I want project matching to be a tested script, so that the same name always
   resolves to the same directory.
10. As the owner, I want "what is going on?" to tell me what is waiting or broken without reading
    every screen, so that the summary is quick and cheap.
11. As the owner, I want kill, delete and bulk archive to list every target with its status and
    unpushed work and then wait for my yes, so that the Overseer never destroys running work on
    its own reading.
12. As the owner, I want a yes to cover exactly the list I approved, so that a later, different
    list needs its own yes.
13. As the owner, I want the Overseer never to act on itself, and to flag Bots as Bots before a
    destructive action, so that I do not lose my orchestrator by accident.
14. As the owner, I want the Overseer to do nothing between my requests, so that my rule that I
    decide when Sessions work together still holds.
15. As the owner, I want the Overseer to read `--help` for flags, so that it stays correct across
    agent-manager releases without the skill being edited.
16. As the owner, I want it to use MCP tools first and the CLI for the rest, so that it uses the
    cheapest correct path.
17. As the owner, I want factory questions sent to the orchestrator, so that the two Bots do not
    overlap.
18. As the owner, I want the Overseer's knowledge to be a committed skill that `fractory install`
    ships, so that it is reviewed and versioned like code.
19. As the owner, I want the Overseer to remember across its Bots in its own memory project, so
    that what one Overseer learns the next one knows.

## Implementation decisions

- **Skill location.** `skills/fractory-overseer/SKILL.md` in this repository, installed by the
  existing `installSkills`, which already copies every directory under `skills/`. No installer
  change.
- **Script runtime.** The resolver is dependency-free TypeScript, run by plain `node` (Node 24
  strips types), because an installed skill has no `node_modules`. The `orchestrate` skill is the
  precedent. It uses only erasable syntax (no enums, no parameter properties, no namespaces), and
  relative imports carry `.ts`.
- **Shape.** A pure `resolveProject(name, candidates)` decides the match, `{ kind: 'match',
  path } | { kind: 'ambiguous' | 'none', candidates }`. A thin entry point gathers the
  candidates: it reads `~/Work/*/` for directories holding `.git`, and runs `agent-manager groups
  --json` for group directories. Both are injected functions, so tests replace them.
- **Boundary exception.** The repo rule is that `zod` validates every boundary. The resolver
  cannot import `zod` once installed, so `agent-manager groups --json` is checked by a small
  hand-written guard instead: an array of objects with a string directory, anything else
  refused. This is the one stated exception, and it lives in the script. The JSON field names are
  read from agent-manager's source at implementation time. A failed or refused `groups` call
  proves nothing, so the resolver still matches against the repositories, and its output says
  the group directories could not be read.
- **Type-checking.** `tsconfig.json`'s `include` gains `skills`, so `pnpm typecheck` covers the
  script directly and not only through the test's imports.
- **The Profile row.** It is not built by a Run: a Run's sandbox has no access to the owner's
  `state.db`. After the skill merges, the session that wrote this Spec runs `fractory install` and
  the `bots create` line above, with the owner's yes.

## Testing decisions

One seam: the resolver's injected candidate sources. `tests/overseer-resolve-project.test.ts`
(vitest, importing from `skills/fractory-overseer/scripts/`) covers external behaviour only:

- an exact basename match wins over substring matches, ignoring case
- one substring match resolves, and two or more are ambiguous with both listed
- the same basename in two areas is ambiguous, not the first one found
- a group directory is a candidate beside the repositories, and the same path seen twice is one
  candidate
- a directory under `~/Work/<area>/` without `.git` is not a candidate
- `groups --json` that fails or does not match the guard leaves the repositories matchable and is
  reported, not treated as "no groups"
- the entry point exits 0 on a match and non-zero otherwise, and `--json` prints the result
  object

The skill itself is prose, so its acceptance is a walkthrough on a throwaway workspace
(`AGENT_MANAGER_CONFIG_DIR` and `TMUX_TMPDIR` pointed at a temporary directory, as
agent-manager's `docs/agent-to-agent.md` describes). Each of these must happen:

- a fan-out to two named Sessions sends without asking
- "all idle sessions" shows the list first
- a duplicate body's refusal is reported for that recipient
- "start a chat on <repo>" spawns in a worktree
- an ambiguous name asks
- "kill X" lists X and waits

The same walkthrough checks that nothing happens between requests. The resulting PR records the
walkthrough.

`installSkills` already has tests that copy every skill directory. No new installer test is
needed.

## Open questions

- **Multi-recipient send in agent-manager.** It was agreed that `send` takes ids only, with no
  selectors, delivers to every recipient that passes its limits, reports a result per recipient,
  and exits non-zero if any was refused, on both CLI and MCP. It gets its own Spec in
  agent-manager, grilled next against that repo's every-change matrix. When it lands, the
  fan-out recipe uses it.
- **Spawning a Bot from the CLI.** No command exists, so the Overseer cannot start Bots. A later
  agent-manager Spec could add one.
- **Other hosts.** Acting on SSH connections' Sessions (`host::id`) is left for a later version.
