# Security Policy

## System and scope

Threadwire is a local Windows controller for the legitimate ChatGPT Classic application. Its intended control path is a localhost controller using CDP against the legitimate ChatGPT WebContents; it is not a standalone ChatGPT HTTP client.

This policy covers Threadwire source code, tests, local controller boundaries, process supervision, CDP session management, routing/scheduling, readiness state machines, future localhost APIs, persistence, and telemetry implemented in this repository.

OpenAI/ChatGPT service-side vulnerabilities are outside this repository's scope and should be reported through the appropriate OpenAI security channel.

## Threat model and trust boundaries

Important assets and boundaries include:

- the authenticated ChatGPT Classic runtime and its session state;
- localhost CDP and future localhost Threadwire APIs;
- runtime process identity and `runtimeGeneration` leases;
- opaque `ThreadHandle` values and account-linked conversation locators;
- serialized WebContents mutations and active conversational-request state;
- logs, telemetry, fixtures, acceptance artifacts, and persisted metadata.

Inputs originating outside Threadwire's trusted local process boundary must be treated as untrusted. Process discovery, navigation targets, API inputs, persisted metadata, CDP observations, and future scheduling inputs must be validated before mutation.

## Security invariants

The following properties are intended to hold:

- CDP and local controller/API listeners bind to localhost only.
- Authentication, cookies, session/access tokens, proof artifacts, protected headers, CAPTCHA/Turnstile material, and equivalent protection state remain inside the legitimate ChatGPT runtime.
- Threadwire does not implement, replay, fabricate, bypass, or expose Sentinel, proof, Turnstile, Conduit, Cloudflare, MFA, rate limits, or equivalent protections.
- Conversation locators are treated as account-linked metadata; avoid logging them and expose opaque local `ThreadHandle` values where possible.
- Mutating WebContents operations are serialized in the MVP.
- Navigation, switching, and reload do not occur while a conversational request is active.
- A full Classic process replacement advances `runtimeGeneration`; stale work must be rejected.
- `THREADWIRE_CLASSIC_POLICY=BOUND_EXISTING` is an operator/startup policy only. It requires a pre-existing Classic runtime, binds one immutable runtime lease and one listener-owner PID-plus-creation-time identity for the server admission epoch, forbids automatic Classic launch/restart/recovery/replacement, and fails closed when those discrete observations no longer establish the admitted provenance.
- Bound-runtime process identity, listener ownership, process ancestry, target identifiers, and debugger endpoints are private internal metadata and must not be logged or serialized through the public API.
- CDP listener provenance in bound mode uses repeated discrete Windows listener/process observations: exactly the configured localhost listener must remain owned by the same admitted owner process generation, with a strictly ordered current ancestry chain rooted at the admitted Classic main identity. Executable names, process names, parent PID alone, and PID alone are not authority.
- Bound mutation guards are placed immediately before the raw CDP mutation commands that Threadwire controls, after any preceding asynchronous observation/polling in the same operation where practical. This narrows the race window but does not make the Windows/CDP observations atomic.
- Input-command acceptance, write observation, conversation creation, and response completion are distinct states and must not be conflated.
- Raw response bodies remain memory-only by default unless an explicit future design changes that policy.
- Unit tests must not mutate the real ChatGPT process. Destructive acceptance must remain explicitly gated.
- Real credentials, HAR files, authenticated profiles, raw network dumps, response bodies, and sensitive research artifacts must never be committed.

The deterministic Windows provenance fixture may create only controlled local test processes and sockets. It must tear down only those owned fixtures and must not start, stop, restart, attach to, or send a turn through a real ChatGPT Classic runtime.

## Reportable findings and severity context

Examples of security-relevant findings include:

- remote or non-loopback exposure of CDP or a Threadwire local API;
- extraction, persistence, logging, or outward exposure of protected session/authentication material;
- a protection bypass or replay mechanism introduced into Threadwire;
- stale-runtime work executing after a full Classic process replacement;
- a bound-existing server silently adopting a new Classic generation or accepting an unproven/foreign/replaced CDP listener generation;
- mutation interleaving that violates the active-turn/navigation or scheduler boundaries;
- conversation-handle/locator isolation failures that expose account-linked metadata to the wrong caller;
- command/process invocation paths that permit untrusted input to alter executable or shell behavior;
- telemetry, errors, fixtures, or acceptance artifacts that leak sensitive runtime data;
- destructive acceptance running under ordinary unit-test commands or without an explicit guard.

Severity should reflect realistic reachability and impact in Threadwire's local-controller deployment model. Local-only exposure reduces network reachability but does not make session leakage, process-control violations, or cross-thread metadata exposure harmless.

## Out of scope

The following are not goals of this repository:

- reverse engineering or bypassing ChatGPT/OpenAI protection systems;
- implementing a raw browser-independent ChatGPT HTTP write client;
- vulnerabilities in the OpenAI service that are not caused or exposed by Threadwire;
- claims based only on mocked behavior when the asserted security property depends on the real Classic runtime.

These exclusions do not suppress a Threadwire finding merely because the affected code interacts with ChatGPT Classic or CDP.

## Reporting a vulnerability

Do not open a public issue containing secrets, session material, exploit details, authenticated profile data, conversation locators, HAR files, or raw network captures.

When GitHub private vulnerability reporting is enabled for this repository, use that channel. Until then, contact the repository owner privately through GitHub and provide only the minimum information needed to establish a private reporting channel.

A useful report includes:

- affected Threadwire version/commit;
- affected component and security invariant;
- realistic prerequisites and impact;
- minimal reproduction steps using synthetic data where possible;
- whether the issue requires real ChatGPT Classic or is reproducible in unit tests.

Do not include real credentials, cookies, tokens, protected headers, proof artifacts, authenticated profiles, or unrelated private data.

## Known limitations

Threadwire is still an MVP. Repository tests prove only the exact code paths and controlled fixtures they exercise. The `BOUND_EXISTING` source/tests implement a fail-closed policy under a documented discrete-observation model; they do not provide cryptographic binding or eliminate the race interval after the final OS provenance check and before a raw CDP mutation. The actual ChatGPT Classic process-tree/CDP-listener topology remains acceptance-pending until a separate non-mutating Windows/Classic proof succeeds on the exact candidate SHA. Native HELYX M2 is not accepted by these source/tests alone, and bounded acceptance samples must not be generalized into universal Windows support, reliability, or timing claims.
