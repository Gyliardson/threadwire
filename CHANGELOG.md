# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-24

### Added

- Add bounded ChatGPT Project creation through the legitimate frontend and shared mutation scheduler.
- Add `POST /v1/projects` with strict input validation and opaque project handles.
- Add unit coverage for project identity, registry, UI automation, scheduling, and HTTP behavior.

### Changed

- Generalize controller workflow serialization so project creation cannot interleave with turns.

### Security

- Keep ChatGPT project locators internal and serialize only opaque handles at the HTTP boundary.
