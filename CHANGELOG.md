# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-08-26

### Added

- Add `PROJECT` turn targets that create a new conversation inside an opaque Project handle.
- Add Project-aware route readiness and send-button submission through the legitimate frontend.
- Add Project-scoped conversation locator support for later opaque `THREAD` follow-up turns.

### Changed

- Reuse the existing turn write observation and normalized response stream for Project first turns.

### Security

- Bind Project submission to the exact Project route and focused composer form.
- Reject Project-qualified results from ordinary `FRESH` turns.
- Require stable same-Project conversation ownership before registering a `ThreadHandle`.
- Reject stale runtime leases before Project routing, submission, or conversation registration.

## [0.2.0] - 2026-08-24

### Added

- Add bounded ChatGPT Project creation through the legitimate frontend and shared mutation scheduler.
- Add `POST /v1/projects` with strict input validation and opaque project handles.
- Add unit coverage for project identity, registry, UI automation, scheduling, and HTTP behavior.

### Changed

- Generalize controller workflow serialization so project creation cannot interleave with turns.

### Fixed

- Normalize proven batched assistant append deltas without recursively extracting unrelated response metadata.

### Security

- Keep ChatGPT project locators internal and serialize only opaque handles at the HTTP boundary.

## [0.1.1] - 2026-08-24

### Fixed

- Verify bounded Classic process quiescence before accepting a stop-command failure as successful termination.
- Reject unexpected replacement runtimes immediately and invalidate stale runtime leases.
- Bound the PowerShell stop-command phase while preserving caller cancellation.
- Refuse launch when another Classic runtime appears before the controlled launch begins.
- Serialize complete lifecycle transitions and promptly reject canceled queued operations.
