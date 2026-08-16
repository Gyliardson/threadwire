import test from "node:test";
import assert from "node:assert";
import { ClassicSupervisor } from "../../src/runtime/ClassicSupervisor.js";
import { CdpSessionManager } from "../../src/cdp/CdpSessionManager.js";
import { loadConfig } from "../../src/config/ControllerConfig.js";

test("A1 True Cold Start (Integration)", { skip: process.env.THREADWIRE_ACCEPT_DESTRUCTIVE_TESTS !== "1" }, async (t) => {
  const config = loadConfig();
  const supervisor = new ClassicSupervisor(config);
  const sessionManager = new CdpSessionManager(config);

  try {
    // Phase 1: Restart / True Cold Start
    console.log("[A1] Initiating True Cold Start...");
    const generation = await supervisor.restart();
    assert.strictEqual(typeof generation, "number");
    assert.ok(generation > 0, "Generation should be greater than 0");

    const snapshot = await supervisor.inspect();
    assert.strictEqual(snapshot.isRunning, true, "Classic process should be running");
    assert.strictEqual(snapshot.generation, generation, "Snapshot generation matches");
    console.log(`[A1] Classic running with generation: ${generation}, PID: ${snapshot.pid}`);

    // Phase 2: CDP Attach
    console.log("[A1] Attempting CDP Session Attach...");
    await sessionManager.connect(generation);
    assert.strictEqual(sessionManager.state, "CONNECTED", "CDP Session should be connected");

    // Phase 3: Verify generation staleness check
    sessionManager.checkGeneration(generation);
    assert.throws(() => sessionManager.checkGeneration(generation + 1), {
      name: "RuntimeGenerationChangedError"
    });

    console.log("[A1] Test successful. CDP attached and active.");

  } finally {
    // Cleanup
    await sessionManager.disconnect();
    
    if (process.env.THREADWIRE_ACCEPTANCE_CLEANUP === "1") {
      console.log("[A1] Cleaning up Classic process...");
      await supervisor.stop();
    } else {
      console.log("[A1] Leaving Classic process running as requested (THREADWIRE_ACCEPTANCE_CLEANUP != 1).");
    }
  }
});
