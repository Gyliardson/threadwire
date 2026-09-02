import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeGenerationTracker } from "../../src/domain/RuntimeGeneration.js";
import { RuntimeProvenanceUnverifiedError } from "../../src/domain/errors.js";
import { parseListenerProvenanceOutput } from "../../src/runtime/CdpEndpointProvenance.js";

const config = { cdpHost: "127.0.0.1" as const, cdpPort: 9223 };
const mainTime = "2026-09-02T12:00:00.0000000Z";
const childTime = "2026-09-02T12:00:01.0000000Z";

test("listener provenance rejects owner exit between listener and second ancestry observation", () => {
  const tracker = new RuntimeGenerationTracker();
  tracker.observe({ pid: 100, creationTime: mainTime });
  const lease = tracker.getCurrentRuntimeLease();
  const listener = {
    listenerCount: 1,
    localAddress: config.cdpHost,
    localPort: config.cdpPort,
    ownerPid: 101,
  };
  const chainA = [
    { pid: 101, parentPid: 100, creationTime: childTime },
    { pid: 100, parentPid: 1, creationTime: mainTime },
  ];

  assert.throws(
    () => parseListenerProvenanceOutput(
      JSON.stringify({
        listenerA: listener,
        chainA,
        listenerB: listener,
        chainB: [],
      }),
      config,
      lease,
    ),
    RuntimeProvenanceUnverifiedError,
  );
});
