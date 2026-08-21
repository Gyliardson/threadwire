import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { CdpSessionManager } from "../../src/cdp/CdpSessionManager.js";
import { loadConfig } from "../../src/config/ControllerConfig.js";
import {
  runtimeGenerationNumber,
  sameRuntimeIdentity,
} from "../../src/domain/RuntimeGeneration.js";
import { ClassicProcessObservation } from "../../src/domain/RuntimeState.js";
import { ReadinessController } from "../../src/readiness/ReadinessController.js";
import { ConversationRouter } from "../../src/routing/ConversationRouter.js";
import { OperationScheduler } from "../../src/routing/OperationScheduler.js";
import { ThreadRegistry } from "../../src/routing/ThreadRegistry.js";
import { ClassicSupervisor } from "../../src/runtime/ClassicSupervisor.js";
import { TurnExecutor } from "../../src/turn/TurnExecutor.js";

function identity(process: ClassicProcessObservation) {
  return { pid: process.pid, creationTime: process.creationTime };
}

function nonce(): string {
  return randomBytes(8).toString("hex");
}

const m7Enabled =
  process.env.THREADWIRE_ACCEPT_DESTRUCTIVE_TESTS === "1" &&
  process.env.THREADWIRE_ACCEPT_M7_COLD_STREAMING === "1";

test(
  "M7 true cold start: full Classic replacement -> safe FRESH + EXISTING streaming path",
  { skip: !m7Enabled },
  async () => {
    assert.equal(process.env.THREADWIRE_ACCEPT_DESTRUCTIVE_TESTS, "1");
    assert.equal(process.env.THREADWIRE_ACCEPT_M7_COLD_STREAMING, "1");

    const config = loadConfig();
    assert.equal(config.cdpHost, "127.0.0.1");

    const supervisor = new ClassicSupervisor(config);
    const before = await supervisor.inspect();
    assert.equal(before.isRunning, true, "M7 requires a pre-existing Classic runtime to replace.");
    if (before.mainProcess === null) {
      throw new Error("M7 requires a pre-existing Classic Main process.");
    }

    const previousMain = before.mainProcess;
    const previousProcesses = before.processes.map((process) => ({ ...process }));

    const generationAfterRestart = await supervisor.restart();
    assert.equal(
      runtimeGenerationNumber(generationAfterRestart),
      runtimeGenerationNumber(before.generation) + 1,
      "A single production restart must advance runtimeGeneration exactly once.",
    );

    const afterRestart = await supervisor.inspect();
    assert.equal(afterRestart.isRunning, true);
    if (afterRestart.mainProcess === null) {
      throw new Error("A replacement Classic Main process must be observed.");
    }
    assert.equal(afterRestart.generation, generationAfterRestart);
    assert.equal(
      sameRuntimeIdentity(identity(previousMain), identity(afterRestart.mainProcess)),
      false,
      "The replacement Main identity must differ from the pre-restart Main identity.",
    );
    for (const previous of previousProcesses) {
      assert.equal(
        afterRestart.processes.some((current) =>
          sameRuntimeIdentity(identity(current), identity(previous)),
        ),
        false,
        "No process identity from the previous Classic generation may survive the restart.",
      );
    }

    const registry = new ThreadRegistry();
    const scheduler = new OperationScheduler(supervisor);
    const cdp = new CdpSessionManager(config, supervisor);
    const readiness = new ReadinessController(cdp);
    const router = new ConversationRouter(registry, scheduler, cdp, readiness);
    const executor = new TurnExecutor(registry, scheduler, readiness, cdp);

    try {
      await cdp.connect();
      cdp.assertCurrentRuntime();
      assert.equal(cdp.boundGeneration, supervisor.currentGeneration);

      await router.routeFresh();
      let lease = supervisor.getCurrentRuntimeLease();
      const freshComposer = await cdp.getTurnComposerState({ kind: "FRESH_ROOT" }, lease);
      assert.equal(freshComposer.expectedRoute, true);
      assert.equal(freshComposer.eligible, true);
      assert.equal(freshComposer.focused, true);
      assert.equal(freshComposer.empty, true);

      const freshNonce = nonce();
      const input1 = `TW_M7_COLD_IN_${freshNonce}`;
      const output1 = `TW_M7_COLD_OUT_${freshNonce}`;
      const prompt1 = `Reply with exactly ${output1} and do not repeat ${input1}.`;
      let freshText = "";
      let freshDeltaCount = 0;
      let freshCompletedCount = 0;

      const freshResult = await executor.executeStreaming({ kind: "FRESH" }, prompt1, (event) => {
        if (event.type === "TEXT_DELTA") {
          freshDeltaCount += 1;
          freshText += event.text;
          return;
        }
        if (event.type === "COMPLETED") {
          freshCompletedCount += 1;
        }
      });

      assert.equal(freshResult.kind, "THREAD");
      assert.equal(freshResult.created, true);
      assert.equal(registry.knownThreads().length, 1);
      assert.ok(freshDeltaCount >= 1);
      assert.ok(freshText.length > 0);
      assert.equal(freshCompletedCount, 1);
      assert.equal(freshText.includes(input1), false);

      // M7 proves that the safe normalized streaming path survives true cold-start
      // recovery. Final rendered-text completeness is tracked separately in #9;
      // mixed input/output response records must not be broadened into TEXT_DELTA.
      lease = supervisor.getCurrentRuntimeLease();
      const registeredLocator = registry.resolve(freshResult.threadHandle);
      const currentLocator = await cdp.getCurrentConversationLocator(lease);
      assert.notEqual(currentLocator, null);
      assert.equal(currentLocator, registeredLocator);

      await router.routeFresh();
      lease = supervisor.getCurrentRuntimeLease();
      const freshAfterTurn = await cdp.getTurnComposerState({ kind: "FRESH_ROOT" }, lease);
      assert.equal(freshAfterTurn.expectedRoute, true);
      assert.equal(freshAfterTurn.eligible, true);
      assert.equal(freshAfterTurn.focused, true);
      assert.equal(freshAfterTurn.empty, true);

      await router.routeToThread(freshResult.threadHandle);
      lease = supervisor.getCurrentRuntimeLease();
      const threadLocator = registry.resolve(freshResult.threadHandle);
      const threadComposer = await cdp.getTurnComposerState(
        { kind: "THREAD", locator: threadLocator },
        lease,
      );
      assert.equal(threadComposer.expectedRoute, true);
      assert.equal(threadComposer.eligible, true);
      assert.equal(threadComposer.focused, true);
      assert.equal(threadComposer.empty, true);

      const existingNonce = nonce();
      const input2 = `TW_M7_COLD_IN2_${existingNonce}`;
      const output2 = `TW_M7_COLD_OUT2_${existingNonce}`;
      const prompt2 = `Reply with exactly ${output2} and do not repeat ${input2}.`;
      let existingText = "";
      let existingDeltaCount = 0;
      let existingCompletedCount = 0;

      const existingResult = await executor.executeStreaming(
        { kind: "THREAD", threadHandle: freshResult.threadHandle },
        prompt2,
        (event) => {
          if (event.type === "TEXT_DELTA") {
            existingDeltaCount += 1;
            existingText += event.text;
            return;
          }
          if (event.type === "COMPLETED") {
            existingCompletedCount += 1;
          }
        },
      );

      assert.equal(existingResult.kind, "THREAD");
      assert.equal(existingResult.created, false);
      assert.equal(existingResult.threadHandle, freshResult.threadHandle);
      assert.equal(registry.knownThreads().length, 1);
      assert.ok(existingDeltaCount >= 1);
      assert.ok(existingText.length > 0);
      assert.equal(existingCompletedCount, 1);
      assert.equal(existingText.includes(input2), false);
      assert.equal(existingText.includes(input1), false);
      assert.equal(freshText.includes(input2), false);

      lease = supervisor.getCurrentRuntimeLease();
      const afterExistingLocator = await cdp.getCurrentConversationLocator(lease);
      assert.notEqual(afterExistingLocator, null);
      assert.equal(afterExistingLocator, registeredLocator);

      let schedulerProbeExecuted = false;
      await scheduler.schedule("ROUTE", async () => {
        schedulerProbeExecuted = true;
      });
      assert.equal(schedulerProbeExecuted, true);

      const finalRuntime = await supervisor.inspect();
      assert.equal(finalRuntime.generation, afterRestart.generation);
      assert.notEqual(finalRuntime.mainProcess, null);
      if (finalRuntime.mainProcess === null) {
        throw new Error("The replacement Classic Main process disappeared during M7 acceptance.");
      }
      assert.equal(
        sameRuntimeIdentity(identity(finalRuntime.mainProcess), identity(afterRestart.mainProcess)),
        true,
        "The post-restart Classic runtime must remain stable through both streaming turns.",
      );
    } finally {
      await cdp.disconnect().catch(() => undefined);
    }
  },
);
