# Threadwire

Threadwire is an experimental local controller for ChatGPT Classic on Windows. It drives the legitimate ChatGPT Classic process and its WebContents through localhost Chrome DevTools Protocol (CDP) rather than implementing a standalone or reverse-engineered ChatGPT HTTP client.

> **Project status:** active MVP development. The repository currently implements runtime supervision, CDP recovery/session management, conversation routing/scheduling, existing/fresh-route readiness, turn execution, conservative response streaming with authoritative final rendered reconciliation, and a localhost HTTP/SSE API. ThreadHandle persistence and the later observability/integration milestones are not yet complete.

Threadwire is an independent, unofficial project and is not affiliated with or endorsed by OpenAI.

## Architecture

The runtime path is:

```text
local Threadwire controller/API
  -> legitimate ChatGPT Classic process
  -> CDP-controlled legitimate ChatGPT WebContents
  -> normal ChatGPT frontend, protection, and network runtime
```

Threadwire deliberately keeps authentication, session state, and protection lifecycles inside the legitimate ChatGPT runtime.

## Implemented today

The current MVP implementation includes:

- **M0:** project/controller extraction and baseline hardening.
- **M1:** `ClassicSupervisor` and CDP session management.
- **M2:** `ConversationRouter`, opaque `ThreadHandle` registry, and serialized mutation scheduling.
- **M3:** existing-thread route readiness with frame, editable, focus, runtime-generation, and backend-activity observation.
- **M4:** fresh/root route readiness with a configurable post-readiness engineering guard.
- **M5:** `TurnExecutor` with distinct command acceptance, write observation/settlement, fresh-conversation registration, cancellation, and fail-closed uncertainty handling.
- **M6:** conservative normalized response streaming plus authoritative `FINAL_TEXT` reconciliation from the rendered assistant response.
- **M7:** bounded true cold-start/CDP recovery acceptance and hardening.
- **M8:** localhost-only HTTP/SSE API over the existing routing, scheduling, turn, and response pipeline.

The 500 ms fresh-route guard is an engineering default, not a proven frontend minimum or a claim about a specific frontend mechanism.

`TEXT_DELTA` events are conservative and best-effort. A successful streamed turn may emit zero or more `TEXT_DELTA` events, followed by exactly one authoritative `FINAL_TEXT`, then terminal `COMPLETED`.

## Security boundaries

Threadwire is designed around strict boundaries:

- CDP and the public controller API bind to `127.0.0.1` only.
- Authentication/session/protection state remains inside ChatGPT Classic.
- The controller must not extract or persist Authorization values, cookies, session/access tokens, protected headers, proof artifacts, CAPTCHA/Turnstile material, or equivalent protection internals.
- Threadwire does not implement, replay, fabricate, or bypass Sentinel, proof, Turnstile, Conduit, Cloudflare, MFA, rate limits, or equivalent protections.
- Conversation locators are treated as account-linked metadata and are not part of the public HTTP API; callers use opaque `ThreadHandle` values.
- Mutating WebContents operations are serialized in the MVP.
- Navigation, thread switching, and reload are forbidden while a conversational request is active.
- Runtime leases become stale after full Classic process replacement and must fail closed.
- Raw ChatGPT response bodies remain memory-only by default.
- Browser-origin requests are rejected by the localhost HTTP boundary; Host/Origin checks are hardening and are not local-process authentication.

See [SECURITY.md](SECURITY.md) for reporting guidance and the repository security policy.

## Requirements

- Windows
- ChatGPT Classic installed for real-runtime use
- Node.js 24
- pnpm

Unit tests do not require the real ChatGPT process. Real Classic acceptance is separate, opt-in, and can submit synthetic turns or replace the local Classic runtime depending on the specific test.

## Configuration

The CDP endpoint is intentionally localhost-only:

```text
THREADWIRE_CDP_HOST=127.0.0.1
THREADWIRE_CDP_PORT=9223
```

`THREADWIRE_CDP_HOST` must be exactly `127.0.0.1`. The port is configurable and defaults to `9223`.

The M8 HTTP API is also localhost-only:

```text
THREADWIRE_API_HOST=127.0.0.1
THREADWIRE_API_PORT=9224
```

`THREADWIRE_API_HOST` must be exactly `127.0.0.1`. The API port must differ from the CDP port.

## Local HTTP/SSE API

Build and start the controller API:

```bash
pnpm build
node dist/src/main.js
```

The default listener is `http://127.0.0.1:9224`.

### `GET /v1/health`

Returns only safe controller state:

```json
{
  "classic": "RUNNING",
  "cdp": "CONNECTED"
}
```

`classic` is `RUNNING` or `STOPPED`. `cdp` uses Threadwire's CDP connection state. Process IDs, runtime generations, target metadata, conversation locators, and debugger URLs are not exposed.

### `GET /v1/threads`

Returns currently known in-memory opaque thread handles:

```json
{
  "threads": [
    { "threadHandle": "tw_..." }
  ]
}
```

ThreadHandle persistence is planned for M9; this endpoint does not imply persistence across controller restarts.

### `POST /v1/turns`

Fresh turn request:

```json
{
  "target": { "kind": "FRESH" },
  "prompt": "Hello"
}
```

Existing-thread request:

```json
{
  "target": {
    "kind": "THREAD",
    "threadHandle": "tw_..."
  },
  "prompt": "Follow up"
}
```

Successful requests use Server-Sent Events. The public success sequence is:

```text
TEXT_DELTA* -> FINAL_TEXT -> COMPLETED
```

`TEXT_DELTA` may be absent. `FINAL_TEXT` contains the authoritative full final rendered assistant text. `COMPLETED` is emitted only after the turn has returned successfully and contains the opaque `threadHandle` plus `newlyRegistered`.

A streamed failure terminates with an `ERROR` event containing only a safe public error DTO. Internal causes, stacks, credentials, protected headers, conversation locators, and low-level protocol metadata are not serialized.

The API uses bounded engineering limits for request body size, prompt size, concurrent/in-flight turn requests, controller admission, and pending SSE output. These bounds are controller limits, not discovered ChatGPT protocol limits.

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

Destructive/real-runtime acceptance tests are individually guarded and should remain skipped unless their explicit environment guards are enabled. Review the specific test before running it on an authenticated machine.

## Roadmap

Remaining MVP sequence after M8:

- **M9:** `ThreadHandle` persistence
- **M10:** observability/recovery hardening
- **M11:** integration/acceptance suite

Repository tests and mocks validate only the code paths they exercise; they do not prove universal ChatGPT Classic behavior. Real-runtime evidence is bounded to the exact code/runtime exercised.

## Sensitive material

Do not commit or upload real secrets, HAR files, authenticated browser profiles, raw network dumps, cookies, tokens, response bodies, or sensitive research artifacts. Treat every commit as potentially public.

Before changing repository visibility, perform a final local scan of tracked, untracked, generated files, and Git history for sensitive material, and decide whether historical author metadata containing a personal email address should be rewritten.

## License

Threadwire is licensed under the Apache License 2.0. See [LICENSE](LICENSE).
