# Threadwire

Threadwire is an experimental local controller for ChatGPT Classic on Windows. It drives the legitimate ChatGPT Classic process and its WebContents through localhost Chrome DevTools Protocol (CDP) rather than implementing a standalone or reverse-engineered ChatGPT HTTP client.

> **Project status:** active MVP development. The repository currently implements runtime supervision, CDP session/target management, conversation routing/scheduling, and existing/fresh-route readiness. Turn execution, response streaming, the localhost HTTP/SSE API, persistence, and the final integration/acceptance suite are not yet complete.

Threadwire is an independent, unofficial project and is not affiliated with or endorsed by OpenAI.

## Architecture

The intended runtime path is:

```text
local Threadwire controller/API
  -> legitimate ChatGPT Classic process
  -> CDP-controlled legitimate ChatGPT WebContents
  -> normal ChatGPT frontend, protection, and network runtime
```

Threadwire deliberately keeps authentication, session state, and protection lifecycles inside the legitimate ChatGPT runtime.

## Implemented today

The current `master` includes the first five MVP milestones:

- **M0:** project/controller extraction and baseline hardening.
- **M1:** `ClassicSupervisor` and CDP session management.
- **M2:** `ConversationRouter`, opaque `ThreadHandle` registry, and serialized mutation scheduling.
- **M3:** existing-thread route readiness with frame, editable, focus, runtime-generation, and backend-activity observation.
- **M4:** fresh/root route readiness with a configurable post-readiness engineering guard.

The 500 ms fresh-route guard is an engineering default, not a proven frontend minimum or a claim about a specific frontend mechanism.

## Security boundaries

Threadwire is designed around strict boundaries:

- CDP binds to `127.0.0.1` only.
- Authentication/session/protection state remains inside ChatGPT Classic.
- The controller must not extract or persist Authorization values, cookies, session/access tokens, protected headers, proof artifacts, CAPTCHA/Turnstile material, or equivalent protection internals.
- Threadwire does not implement, replay, fabricate, or bypass Sentinel, proof, Turnstile, Conduit, Cloudflare, MFA, rate limits, or equivalent protections.
- Conversation locators are treated as account-linked metadata and should not be logged or exposed where an opaque `ThreadHandle` is sufficient.
- Mutating WebContents operations are serialized in the MVP.
- Navigation, thread switching, and reload are forbidden while a conversational request is active.
- Runtime leases become stale after full Classic process replacement and must fail closed.
- Raw response bodies are intended to remain memory-only by default.

See [SECURITY.md](SECURITY.md) for reporting guidance and the repository security policy.

## Requirements

- Windows
- ChatGPT Classic installed for real-runtime use
- Node.js 24
- pnpm

Unit tests do not require the real ChatGPT process. Real Classic acceptance is separate and may be destructive to the running Classic process/session state.

## Configuration

The CDP endpoint is intentionally localhost-only:

```text
THREADWIRE_CDP_HOST=127.0.0.1
THREADWIRE_CDP_PORT=9223
```

`THREADWIRE_CDP_HOST` must be exactly `127.0.0.1`. The port is configurable and defaults to `9223`.

## Development

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Run the normal repository checks:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm test` runs unit tests only. It must not mutate a real ChatGPT Classic process.

Real-runtime acceptance is explicitly separated:

```bash
pnpm test:acceptance
```

Acceptance tests can control or replace the local Classic runtime. Review the test and its guards before running it on a machine with an authenticated session.

## Roadmap

Planned MVP sequence after M4:

- **M5:** `TurnExecutor`
- **M6:** `ResponseStreamConsumer`
- **M7:** cold-start recovery/hardening
- **M8:** localhost HTTP/SSE API
- **M9:** `ThreadHandle` persistence
- **M10:** observability/recovery hardening
- **M11:** integration/acceptance suite

Repository tests and mocks validate only the code paths they exercise; they do not prove real ChatGPT Classic behavior. Real-runtime evidence is tracked separately.

## Sensitive material

Do not commit or upload real secrets, HAR files, authenticated browser profiles, raw network dumps, cookies, tokens, response bodies, or sensitive research artifacts. Treat every commit as potentially public.

## License

No open-source license has been selected yet. A `LICENSE` file is a required pre-publication gate; do not assume reuse rights until one is added.
