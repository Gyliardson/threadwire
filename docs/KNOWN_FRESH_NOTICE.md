# Opt-in handling of the known FRESH notice

Normal configuration does not authorize UI dismissal. A BOUND_EXISTING operator
may opt in to closing exactly the observed Portuguese introduction notice during
FRESH readiness, after normal navigation and reload. This is an ordinary click
on its existing `Fechar` button; no authentication, upgrade, preference, page
script, prompt submission, or Classic lifecycle operation is added.

Set `THREADWIRE_KNOWN_FRESH_NOTICE_INTENT` to a canonical lowercase UUID. Before
starting the controller, a reviewed execution control must provision that UUID's
authority file in the fixed OS user's home directory:
`.threadwire/fresh-notice-intents/<intent>.json`. The controller does not create
the directory or issue its own authority. This directory cannot be selected by
configuration. The required exact JSON shape is:

```json
{
  "schema": "THREADWIRE_KNOWN_FRESH_NOTICE_INTENT_V1",
  "authority": "00000000-0000-0000-0000-000000000001",
  "intent": "00000000-0000-0000-0000-000000000002",
  "scope": "DISMISS_KNOWN_FRESH_NOTICE_ONCE",
  "rootPid": 42,
  "rootCreationTime": "2026-10-13T00:00:00.1234560Z"
}
```

These values are illustrative, not executable authority. The runtime identity
must match the accepted lease, including the process inspector's canonical
creation timestamp. Symlinked authority paths, changed authority bytes, unknown
fields and invalid identifiers are rejected. This local file is a private
execution binding: it cannot replace external independent review, dispatch
ledger reconciliation, or one-intent native authorization.

The controller exclusively creates and flushes `<intent>.consumed.json` before
the first possible press. An existing consumed file prevents replay, including
after a controller restart. The in-memory budget also remains spent through
readiness reentry and M5 preflight. A failed persistence operation stops before
input; it is not proof that a durable record was written successfully. External
execution intent reconciliation remains necessary after any failed attempt.
The record retains only the authority digest, private runtime lease and document
identity. It does not persist a ThreadHandle or change session ownership.

The notice must have one visible dialog, the exact `Conheça o novo ChatGPT`
heading and exactly the `Fechar` and `Fazer upgrade agora` buttons. Only the close
button is eligible. Unknown, authentication, protection or ambiguous dialogs
permit no dismissal or composer focus. Both press and release independently
verify live runtime provenance, document identity, notice identity, button tag,
unchanged geometry and a live hit on that button before CDP input entry. There
is no retry of dispatched input. Partial, timed-out or otherwise uncertain input
poisons mutation admission for the same runtime lease.

Successful dismissal requires a new observation of the same FRESH document,
absence of blocking dialogs and a single eligible composer. Readiness then uses
new observations and the unchanged 500 ms FRESH stability guard within the
original 20-second deadline. Composer focus also revalidates route, document,
eligibility and absence of dialogs after provenance verification. The internal
pre-input staleness discriminator only permits more bounded observations; a raw
DOM focus failure is never retried.

This opt-in capability is limited to FRESH readiness. It is not acceptance of
HELYX M2, permission for another native attempt, automatic dialog handling on
THREAD routes, or a replacement for independently reviewed execution controls.
