# pi-context-tools

Pi package: https://pi.dev/packages/pi-context-tools

`pi-context-tools` is a tiny [pi](https://pi.dev) coding agent extension that
allows agents to inspect and compact their own context.

It exposes two tools:

- `context_info` reports the current context usage, including token count and
  available context-window details.
- `compact_context` triggers compaction of the current session context. It
  requires a `continueMessage` parameter: after compaction completes
  successfully, that string is sent as a user message (e.g. `Please continue`)
  so the agent resumes working with the compacted context without waiting for
  the user. Compaction starts at the end of the turn that requested it, ahead of
  anything queued behind it, and the resume message is rebuilt at that point so
  it also reports what arrived while compaction was running.

Together, these tools let agents inspect their own context usage and compact it
on demand, without waiting for auto-compaction or requiring the user to run
`/compact` manually.

This is especially useful for orchestration agents that coordinate subagents
or run long multi-step workflows.

## Install

Install the published package with `pi install`:

```bash
pi install npm:pi-context-tools
pi install git:github.com/theduke/pi-context-tools
```

## Usage

Instruct agents to use the `context_info` tool to get information about the
current context, and `compact_context` to compact the context.

## How `compact_context` is scheduled

`compact_context` returns `terminate: true`, so pi ends the turn as soon as the
rest of the tool batch finishes. The extension then starts compaction from the
`turn_end` boundary. That boundary is the earliest point where every tool result
of the turn is persisted, so nothing the agent just produced is lost, and it is
far earlier than the previous behaviour of waiting for `agent_end`, i.e. for the
agent to become completely idle.

Starting compaction from that boundary also gives it priority over work that
pi would otherwise run first. `ctx.compact()` aborts the current run before it
summarizes, so background job notifications and user input that arrive while
the agent works queue up behind the compaction instead of being answered ahead
of it. When the run ends without reaching a turn boundary (an aborted turn, for
example), `agent_end` is still used as a fallback.

The continuation message cannot be composed before compaction runs, because the
agent's own instruction is written against a context that compaction is about to
replace. The extension therefore records the session entries that existed when
the tool was called and, at resume time, appends a preview of every entry that
arrived since (background job completions, user input) so the agent can verify
their current state before acting. If compaction fails, the same message is sent
with a note that the context is unchanged, so a failed compaction never leaves
the agent stopped with nothing to continue from.

In `print` and `json` modes pi tears the session down as soon as the prompt
resolves, so there is no run left to abort, summarize for, or resume into. The
tool reports that and leaves the turn alone rather than aborting work that could
not be compacted.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
```

Tests drive the extension with a stand-in for pi's extension API, so they cover
the scheduling and the resume message without a model or a network call.

For local compaction testing, this repo can use project-local pi settings in
`.pi/settings.json`:

```json
{
  "compaction": {
    "keepRecentTokens": 500
  }
}
```

`keepRecentTokens` is only the target for how much recent conversation pi keeps
after summarizing older entries. The reported context size after compaction will
usually be higher because it also includes the system prompt, tool definitions,
the generated compaction summary, and any messages sent after compaction. This is
expected when debugging `compact_context` and does not by itself mean compaction
failed.
