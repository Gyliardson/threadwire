import assert from "node:assert/strict";
import test from "node:test";
import { CdpSessionManager } from "../../src/cdp/CdpSessionManager.js";
import { loadConfig } from "../../src/config/ControllerConfig.js";
import {
  runtimeGenerationNumber,
  sameRuntimeIdentity,
} from "../../src/domain/RuntimeGeneration.js";
import { ClassicProcessObservation } from "../../src/domain/RuntimeState.js";
import { ClassicSupervisor } from "../../src/runtime/ClassicSupervisor.js";

function identity(process: ClassicProcessObservation) {
  return { pid: process.pid, creationTime: process.creationTime };
}

test(
  "A1 true cold start: full Classic replacement -> localhost CDP attach",
  { skip: process.env.THREADWIRE_ACCEPT_DESTRUCTIVE_TESTS !== "1" },
  async () => {
    assert.equal(
      process.env.THREADWIRE_ACCEPT_DESTRUCTIVE_TESTS,
      "1",
      "A1 requires the destructive acceptance guard to be explicitly enabled.",
    );

    const config = loadConfig();
    assert.equal(config.cdpHost, "127.0.0.1");
    assert.equal(config.cdpPort, 9223, "A1 verifies the established localhost:9223 lab baseline.");

    const supervisor = new ClassicSupervisor(config);
    const sessionManager = new CdpSessionManager(config, supervisor);
    const before = await supervisor.inspect();
    const previousMain = before.mainProcess;
    const previousProcesses = before.processes.map((process) => ({ ...process }));
    const previousChildPids = previousProcesses
      .filter((process) => process.role === "CHILD")
      .map((process) => process.pid);

    console.log(
      `[A1] guard=enabled previousMainPid=${previousMain?.pid ?? "none"} previousChildPids=${previousChildPids.join(",") || "none"}`,
    );

    try {
      const generation = await supervisor.restart();
      assert.equal(
        runtimeGenerationNumber(generation),
        runtimeGenerationNumber(before.generation) + 1,
        "A full replacement must advance runtimeGeneration exactly once.",
      );

      const after = await supervisor.inspect();
      assert.equal(after.isRunning, true);
      if (after.mainProcess === null) {
        throw new Error("A new Main process must be observed.");
      }
      const afterMain: ClassicProcessObservation = after.mainProcess;
      assert.equal(after.pid, afterMain.pid);
      assert.equal(after.generation, generation);

      for (const previous of previousProcesses) {
        assert.equal(
          after.processes.some((current) => sameRuntimeIdentity(identity(current), identity(previous))),
          false,
          `Previous Classic process identity must have exited: PID ${previous.pid}`,
        );
      }

      if (previousMain) {
        assert.equal(
          sameRuntimeIdentity(identity(previousMain), identity(afterMain)),
          false,
          "The new Main identity must differ from the previous Main identity.",
        );
      }

      await sessionManager.connect();
      assert.equal(sessionManager.state, "CONNECTED");
      assert.ok(sessionManager.targetId, "An intended ChatGPT page target must be selected.");
      assert.equal(
        sessionManager.boundGeneration,
        supervisor.currentGeneration,
        "The attached CDP session must be bound to the current runtimeGeneration.",
      );
      sessionManager.assertCurrentRuntime();

      console.log(
        `[A1] newMainPid=${afterMain.pid} generation=${runtimeGenerationNumber(generation)} cdp=127.0.0.1:9223 targetSelected=yes attached=yes`,
      );
    } finally {
      await sessionManager.disconnect();
      if (process.env.THREADWIRE_ACCEPTANCE_CLEANUP === "1") {
        await supervisor.stop();
      }
    }
  },
);
