# Changelog

All changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `compact_context` now accepts a required `continueMessage` string. After
  compaction completes successfully, that message is sent as a user message so
  the agent resumes with the compacted context. The message should describe
  what the agent should do next.

### Changed

- Tool and parameter descriptions clarify that `continueMessage` is an
  instruction for post-compaction work.

## [0.1.1] - 2026-05-10

### Changed

- Updated package metadata to use an HTTPS repository URL.

## [0.1.0] - 2026-05-09

### Added

- Introduced the `compact_context` tool, which schedules compaction after the current turn finishes.
- Added the `context_info` tool for inspecting current context usage alongside `compact_context`.
