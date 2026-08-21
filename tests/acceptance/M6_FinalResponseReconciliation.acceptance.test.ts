import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { CdpSessionManager } from "../../src/cdp/CdpSessionManager.js";
import { loadConfig } from "../../src/config/ControllerConfig.js";
import { sameRuntimeIdentity } from "../../src/domain/RuntimeGeneration.js";
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

const enabled =
  process.env.THREADWIRE_ACCEPT_DESTRUCTIVE_TESTS === "1" &&
  process.env.THREADWIRE_ACCEPT_M6_FINAL_RESPONSE === "1";

test(
  "M6 final response reconciliation: FRESH + EXISTING publish authoritative FINAL_TEXT before COMPLETED",
  { skip: !enabled },
  async () => {
    assert.equal(process.env.THREADWIRE_ACCEPT_DESTRUCTIVE_TESTS, "1");
    assert.equal(process.env.THREADWIRE_ACCEPT_M6_FINAL_RESPONSE, "1");

    const config = loadConfig();
    assert.equal(config.cdpHost, "127.0.0.1");

    const supervisor = new ClassicSupervisor(config);
    const before = await supervisor.inspect();
    assert.equal(before.isRunning, true, "Acceptance requires a pre-existing legitimate Classic runtime.");
    if (before.mainProcess === null) {
      throw new Error("Acceptance requires a pre-existing Classic Main process.");
    }
    const initialMain = before.mainProcess;
    const initialGeneration = before.generation;

    const registry = new ThreadRegistry();
    const scheduler = new OperationScheduler(supervisor);
    const cdp = new CdpSessionManager(config, supervisor);
    const readiness = new ReadinessController(cdp);
    const router = new ConversationRouter(registry, scheduler, cdp, readiness);
    const executor = new TurnExecutor(registry, scheduler, readiness, cdp);

    try {
      await cdp.connect();
      cdp.assertCurrentRuntime();

      await router.routeFresh();
      let lease = supervisor.getCurrentRuntimeLease();
      const freshComposer = await cdp.getTurnComposerState({ kind: "FRESH_ROOT" }, lease);
      assert.equal(freshComposer.expectedRoute, true);
      assert.equal(freshComposer.eligible, true);
      assert.equal(freshComposer.focused, true);
      assert.equal(freshComposer.empty, true);

      const freshNonce = nonce();
      const input1 = `TW_M6_FINAL_IN_${freshNonce}`;
      const output1 = `TW_M6_FINAL_OUT_${freshNonce}`;
      const prompt1 = `Reply with exactly ${output1} and do not repeat ${input1}.`;
      let freshSafeText = "";
      let freshFinalText = "";
      let freshDeltaCount = 0;
      let freshFinalCount = 0;
      let freshCompletedCount = 0;
      const freshOrder: string[] = [];

      const freshResult = await executor.executeStreaming({ kind: "FRESH" }, prompt1, (event) => {
        freshOrder.push(event.type);
        if (event.type === "TEXT_DELTA") {
          freshDeltaCount += 1;
          freshSafeText += event.text;
          return;
        }
        if (event.type === "FINAL_TEXT") {
          freshFinalCount += 1;
          freshFinalText = event.text;
          return;
        }
        freshCompletedCount += 1;
      });

      assert.equal(freshResult.kind, "THREAD");
      assert.equal(freshResult.created, true);
      assert.equal(registry.knownThreads().length, 1);
      assert.ok(freshDeltaCount >= 1);
      assert.equal(freshSafeText.includes(input1), false);
      assert.equal(freshFinalCount, 1);
      assert.equal(freshFinalText.trim() === output1, true);
      assert.equal(freshFinalText.includes(input1), false);
      assert.equal(freshCompletedCount, 1);
      assert.equal(freshOrder.filter((type) => type === "FINAL_TEXT").length, 1);
      assert.equal(freshOrder.filter((type) => type === "COMPLETED").length, 1);
      assert.equal(freshOrder.indexOf("FINAL_TEXT") < freshOrder.indexOf("COMPLETED"), true);
      assert.equal(freshOrder.at(-1), "COMPLETED");

      lease = supervisor.getCurrentRuntimeLease();
      const registeredLocator = registry.resolve(freshResult.threadHandle);
      const currentLocator = await cdp.getCurrentConversationLocator(lease);
      assert.notEqual(currentLocator, null);
      assert.equal(currentLocator, registeredLocator);
      const threadComposer = await cdp.getTurnComposerState(
        { kind: "THREAD", locator: registeredLocator },
        lease,
      );
      assert.equal(threadComposer.expectedRoute, true);
      assert.equal(threadComposer.eligible, true);
      assert.equal(threadComposer.focused, true);
      assert.equal(threadComposer.empty, true);

      const existingNonce = nonce();
      const input2 = `TW_M6_FINAL_IN2_${existingNonce}`;
      const output2 = `TW_M6_FINAL_OUT2_${existingNonce}`;
      const prompt2 = `Reply with exactly ${output2} and do not repeat ${input2}.`;
      let existingSafeText = "";
      let existingFinalText = "";
      let existingDeltaCount = 0;
      let existingFinalCount = 0;
      let existingCompletedCount = 0;
      const existingOrder: string[] = [];

      const existingResult = await executor.executeStreaming(
        { kind: "THREAD", threadHandle: freshResult.threadHandle },
        prompt2,
        (event) => {
          existingOrder.push(event.type);
          if (event.type === "TEXT_DELTA") {
            existingDeltaCount += 1;
            existingSafeText += event.text;
            return;
          }
          if (event.type === "FINAL_TEXT") {
            existingFinalCount += 1;
            existingFinalText = event.text;
            return;
          }
          existingCompletedCount += 1;
        },
      );

      assert.equal(existingResult.kind, "THREAD");
      assert.equal(existingResult.created, false);
      assert.equal(existingResult.threadHandle, freshResult.threadHandle);
      assert.equal(registry.knownThreads().length, 1);
      assert.ok(existingDeltaCount >= 1);
      assert.equal(existingSafeText.includes(input2), false);
      assert.equal(existingSafeText.includes(input1), false);
      assert.equal(freshSafeText.includes(input2), false);
      assert.equal(existingFinalCount, 1);
      assert.equal(existingFinalText.trim() === output2, true);
      assert.equal(existingFinalText.includes(input2), false);
      assert.equal(existingFinalText.includes(input1), false);
      assert.equal(existingCompletedCount, 1);
      assert.equal(existingOrder.filter((type) => type === "FINAL_TEXT").length, 1);
      assert.equal(existingOrder.filter((type) => type === "COMPLETED").length, 1);
      assert.equal(existingOrder.indexOf("FINAL_TEXT") < existingOrder.indexOf("COMPLETED"), true);
      assert.equal(existingOrder.at(-1), "COMPLETED");

      lease = supervisor.getCurrentRuntimeLease();
      const afterExistingLocator = await cdp.getCurrentConversationLocator(lease);
      assert.notEqual(afterExistingLocator, null);
      assert.equal(afterExistingLocator, registeredLocator);

      let schedulerProbeExecuted = false;
      await scheduler.schedule("ROUTE", async () => {
        schedulerProbeExecuted = true;
      });
      assert.equal(schedulerProbeExecuted, true);

      const after = await supervisor.inspect();
      assert.equal(after.generation, initialGeneration);
      assert.notEqual(after.mainProcess, null);
      if (after.mainProcess === null) {
        throw new Error("Classic Main process disappeared during final-response acceptance.");
      }
      assert.equal(sameRuntimeIdentity(identity(after.mainProcess), identity(initialMain)), true);
    } finally {
      await cdp.disconnect().catch(() => undefined);
    }
  },
);
