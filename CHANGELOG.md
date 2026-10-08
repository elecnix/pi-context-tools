# Changelog

All changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 (2026-10-08)


### Features

* Add context_info tool ([a04cb87](https://github.com/elecnix/pi-context-tools/commit/a04cb8763c9ba56eaea297fc23cbb18af4e57186))
* make continueMessage a required compact_context parameter ([41026c0](https://github.com/elecnix/pi-context-tools/commit/41026c0bd6db61dc89032148dfe9db5331ea9fd0))
* send "Please continue" after compact_context compaction ([9927c6c](https://github.com/elecnix/pi-context-tools/commit/9927c6c126b389b874a3778a7888d09ead7c86f0))

## [Unreleased]

### Added

- `compact_context` now accepts a required `continueMessage` string. After
  compaction completes successfully, that message is sent as a user message so
  the agent resumes with the compacted context. The message should describe
  what the agent should do next.
- The resume message now also lists the session entries that arrived after the
  tool was called, such as background job completions and user input, so the
  agent can verify their current state before acting on its instruction.
- A failed compaction now sends the resume message with a note that the context
  is unchanged, instead of leaving the agent stopped with nothing to continue
  from.
- In `print` and `json` modes the tool now reports that compaction is
  unavailable instead of aborting a run that could not be compacted or resumed.
- The compaction callbacks no longer touch a captured `ctx` after they are
  scheduled, so a session replacement, reload, or teardown during compaction can
  no longer take the pi process down.
- Added unit tests (`npm test`) covering compaction scheduling and resume message
  construction.

### Changed

- Compaction now starts at the `turn_end` boundary of the turn that requested
  it instead of at `agent_end`. `ctx.compact()` aborts the current run before it
  summarizes, so compaction runs ahead of background job notifications and user
  input that would otherwise be answered first. `agent_end` remains as a fallback
  for runs that end without a turn boundary, such as aborted turns.
- Tool and parameter descriptions clarify that `continueMessage` is an
  instruction for post-compaction work and that the rest of the turn is skipped.
- The `@earendil-works/pi-coding-agent` dev dependency now tracks the version
  the extension is type checked against, so boundary event results are checked
  against the current API.

## [0.1.1] - 2026-05-10

### Changed

- Updated package metadata to use an HTTPS repository URL.

## [0.1.0] - 2026-05-09

### Added

- Introduced the `compact_context` tool, which schedules compaction after the current turn finishes.
- Added the `context_info` tool for inspecting current context usage alongside `compact_context`.
