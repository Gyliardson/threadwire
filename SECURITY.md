# Security Policy

## System and scope

Threadwire is a local Windows controller for the legitimate ChatGPT Classic application. Its intended control path is a localhost controller using CDP against the legitimate ChatGPT WebContents; it is not a standalone ChatGPT HTTP client.

This policy covers Threadwire source code, tests, local controller boundaries, process supervision, CDP session management, routing/scheduling, readiness state machines, localhost APIs, persistence, and telemetry implemented in this repository.

OpenAI/ChatGPT service-side vulnerabilities are outside this repository's scope and should be reported through the appropriate OpenAI security channel.

## Threat model and trust boundaries

Important assets and boundaries include:

- the authenticated ChatGPT Classic runtime and its session state;
- localhost CDP and Threadwire APIs;
- runtime process identity and `runtimeGeneration` leases;
- opaque `ThreadHandle` values and account-linked conversation locators;
- the local M9 SQLite state database containing the opaque-handle-to-locator mapping;
- serialized WebContents mutations and active conversational-request state;
- logs, telemetry, fixtures, acceptance artifacts, and persisted metadata.

Inputs originating outside Threadwire's trusted local process boundary must be treated as untrusted. Process discovery, navigation targets, API inputs, persisted metadata, CDP observations, and future scheduling inputs must be validated before mutation.

## Security invariants

The following properties are intended to hold:

- CDP and local controller/API listeners bind to localhost only.
- Authentication, cookies, session/access tokens, proof artifacts, protected headers, CAPTCHA/Turnstile material, and equivalent protection state remain inside the legitimate ChatGPT runtime.
- Threadwire does not implement, replay, fabricate, bypass, or expose Sentinel, proof, Turnstile, Conduit, Cloudflare, MFA, rate limits, or equivalent protections.
- Conversation locators are treated as account-linked metadata; avoid logging them and expose opaque local `ThreadHandle` values where possible.
- M9 persistence stores only validated opaque `ThreadHandle` and normalized `ConversationLocator` pairs needed for routing. It must not persist prompts, responses, credentials, protected headers, proof material, runtime/CDP identities, or raw network data.
- The M9 store uses an explicit schema version and must fail closed on incompatible schema, invalid persisted identities, integrity failure, or unavailable durable writes. It must never silently replace/reset bad state and continue with volatile identity.
- A newly allocated handle becomes visible in memory/public results only after its mapping has been durably inserted; a durable-write failure cannot create a volatile-only mapping.
- The default M9 state path is outside the repository working tree. `THREADWIRE_STATE_PATH` overrides must be absolute; operators must protect the resulting local database as account-linked metadata.
- Mutating WebContents operations are serialized in the MVP.
- Navigation, switching, and reload do not occur while a conversational request is active.
- A full Classic process replacement advances `runtimeGeneration`; stale work must be rejected.
- Input-command acceptance, write observation, conversation creation, and response completion are distinct states and must not be conflated.
- Raw response bodies remain memory-only by default unless an explicit future design changes that policy.
- Unit tests must not mutate the real ChatGPT process. Destructive acceptance must remain explicitly gated.
- Real credentials, HAR files, authenticated profiles, raw network dumps, response bodies, persisted state databases, and sensitive research artifacts must never be committed.

## Reportable findings and severity context

Examples of security-relevant findings include:

- remote or non-loopback exposure of CDP or a Threadwire local API;
- extraction, persistence, logging, or outward exposure of protected session/authentication material;
- a protection bypass or replay mechanism introduced into Threadwire;
- stale-runtime work executing after a full Classic process replacement;
- mutation interleaving that violates the active-turn/navigation or scheduler boundaries;
- conversation-handle/locator isolation failures that expose account-linked metadata to the wrong caller;
- persisted handle reuse, locator remapping, silent state reset, or corruption handling that breaks durable conversation identity;
- command/process invocation paths that permit untrusted input to alter executable or shell behavior;
- telemetry, errors, fixtures, state databases, or acceptance artifacts that leak sensitive runtime data;
- destructive acceptance running under ordinary unit-test commands or without an explicit guard.

Severity should reflect realistic reachability and impact in Threadwire's local-controller deployment model. Local-only exposure reduces network reachability but does not make session leakage, process-control violations, durable identity corruption, or cross-thread metadata exposure harmless.

## Out of scope

The following are not goals of this repository:

- reverse engineering or bypassing ChatGPT/OpenAI protection systems;
- implementing a raw browser-independent ChatGPT HTTP write client;
- vulnerabilities in the OpenAI service that are not caused or exposed by Threadwire;
- claims based only on mocked behavior when the asserted security property depends on the real Classic runtime.

These exclusions do not suppress a Threadwire finding merely because the affected code interacts with ChatGPT Classic or CDP.

## Reporting a vulnerability

Do not open a public issue containing secrets, session material, exploit details, authenticated profile data, conversation locators, Threadwire state databases, HAR files, or raw network captures.

When GitHub private vulnerability reporting is enabled for this repository, use that channel. Until then, contact the repository owner privately through GitHub and provide only the minimum information needed to establish a private reporting channel.

A useful report includes:

- affected Threadwire version/commit;
- affected component and security invariant;
- realistic prerequisites and impact;
- minimal reproduction steps using synthetic data where possible;
- whether the issue requires real ChatGPT Classic or is reproducible in unit tests.

Do not include real credentials, cookies, tokens, protected headers, proof artifacts, authenticated profiles, persisted conversation locators, or unrelated private data.

## Known limitations

Threadwire is still an MVP. Repository unit tests prove only the exact code paths they exercise. Some runtime properties require separate Windows/ChatGPT Classic acceptance, and bounded acceptance samples must not be generalized into universal reliability or timing claims.

M9 persistence protects Threadwire's local durable mapping integrity and restart semantics; it does not make the local database a secret-management system or provide encryption at rest. Filesystem/account protections remain part of the local deployment boundary.
