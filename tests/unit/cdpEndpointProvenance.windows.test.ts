import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import test from "node:test";
import { RuntimeGenerationTracker, RuntimeLease } from "../../src/domain/RuntimeGeneration.js";
import { RuntimeProvenanceUnverifiedError } from "../../src/domain/errors.js";
import { WindowsCdpEndpointProvenance } from "../../src/runtime/CdpEndpointProvenance.js";
import { NodeCommandRunner } from "../../src/runtime/CommandRunner.js";

const WINDOWS_ONLY = process.platform !== "win32";
const FIXTURE_TIMEOUT_MS = 5000;

type ListenerFixture = Readonly<{ child: ChildProcess; port: number }>;

const CREATION_TIME_SCRIPT = `
$ErrorActionPreference = 'Stop'
$fixturePid = [int]$env:THREADWIRE_FIXTURE_PID
$matches = @(Get-CimInstance Win32_Process -Filter "ProcessId = $fixturePid" -ErrorAction Stop)
if ($matches.Count -ne 1) {
  throw 'Fixture process identity is not uniquely observable.'
}
$matches[0].CreationDate.ToUniversalTime().ToString('O')
`;

const LISTENER_CHILD_SOURCE = `
import net from "node:net";
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") process.exit(2);
  process.stdout.write(String(address.port) + "\\n");
});
setInterval(() => {}, 1000);
`;

const KEEPER_CHILD_SOURCE = `setInterval(() => {}, 1000);`;

async function creationTimeForPid(pid: number): Promise<string> {
  const runner = new NodeCommandRunner();
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const result = await runner.run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", CREATION_TIME_SCRIPT],
        { env: { ...process.env, THREADWIRE_FIXTURE_PID: String(pid) } },
      );
      const creationTime = result.stdout.trim();
      if (creationTime.length !== 0) return creationTime;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Fixture process creation time was not observed.");
}

async function leaseForPid(pid: number): Promise<RuntimeLease> {
  const tracker = new RuntimeGenerationTracker();
  tracker.observe({ pid, creationTime: await creationTimeForPid(pid) });
  return tracker.getCurrentRuntimeLease();
}

function spawnKeeper(): ChildProcess {
  return spawn(process.execPath, ["--input-type=module", "-e", KEEPER_CHILD_SOURCE], {
    stdio: "ignore",
    windowsHide: true,
  });
}

async function spawnListener(): Promise<ListenerFixture> {
  const child = spawn(process.execPath, ["--input-type=module", "-e", LISTENER_CHILD_SOURCE], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (child.stdout === null) {
    child.kill();
    throw new Error("Fixture listener stdout is unavailable.");
  }

  return await new Promise<ListenerFixture>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error("Fixture listener did not report its port."));
    }, FIXTURE_TIMEOUT_MS);

    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.removeListener("data", onData);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error("Fixture listener exited before reporting its port."));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      if (buffer.length > 64) {
        cleanup();
        child.kill();
        reject(new Error("Fixture listener emitted unexpected output."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const port = Number(buffer.slice(0, newline).trim());
      cleanup();
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
        child.kill();
        reject(new Error("Fixture listener reported an invalid port."));
        return;
      }
      resolve({ child, port });
    };

    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 1000);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", onExit);
    if (!child.kill()) {
      child.removeListener("exit", onExit);
      clearTimeout(timer);
      resolve();
    }
  });
}

test(
  "Windows fixture proves owned listener ancestry through the production provenance seam",
  { skip: WINDOWS_ONLY },
  async (t) => {
    const listener = await spawnListener();
    t.after(async () => await stopOwnedChild(listener.child));
    const expected = await leaseForPid(process.pid);
    const provenance = new WindowsCdpEndpointProvenance({
      cdpHost: "127.0.0.1",
      cdpPort: listener.port,
      classicPolicy: "BOUND_EXISTING",
    });

    await provenance.assertOwnedByRuntime(expected);
  },
);

test(
  "Windows fixture rejects a foreign sibling listener with unprovable ancestry",
  { skip: WINDOWS_ONLY },
  async (t) => {
    const admitted = spawnKeeper();
    const listener = await spawnListener();
    t.after(async () => {
      await stopOwnedChild(listener.child);
      await stopOwnedChild(admitted);
    });
    assert.notEqual(admitted.pid, undefined);
    const expected = await leaseForPid(admitted.pid!);
    const provenance = new WindowsCdpEndpointProvenance({
      cdpHost: "127.0.0.1",
      cdpPort: listener.port,
      classicPolicy: "BOUND_EXISTING",
    });

    await assert.rejects(
      provenance.assertOwnedByRuntime(expected),
      RuntimeProvenanceUnverifiedError,
    );
  },
);

test(
  "Windows fixture rejects listener-owner exit after a previously valid proof",
  { skip: WINDOWS_ONLY },
  async () => {
    const listener = await spawnListener();
    const expected = await leaseForPid(process.pid);
    const provenance = new WindowsCdpEndpointProvenance({
      cdpHost: "127.0.0.1",
      cdpPort: listener.port,
      classicPolicy: "BOUND_EXISTING",
    });

    await provenance.assertOwnedByRuntime(expected);
    await stopOwnedChild(listener.child);
    await assert.rejects(
      provenance.assertOwnedByRuntime(expected),
      RuntimeProvenanceUnverifiedError,
    );
  },
);

test("Windows fixture rejects admitted PID identity mismatch", { skip: WINDOWS_ONLY }, async (t) => {
  const listener = await spawnListener();
  t.after(async () => await stopOwnedChild(listener.child));
  const tracker = new RuntimeGenerationTracker();
  tracker.observe({ pid: process.pid, creationTime: "2000-01-01T00:00:00.0000000Z" });
  const provenance = new WindowsCdpEndpointProvenance({
    cdpHost: "127.0.0.1",
    cdpPort: listener.port,
    classicPolicy: "BOUND_EXISTING",
  });

  await assert.rejects(
    provenance.assertOwnedByRuntime(tracker.getCurrentRuntimeLease()),
    RuntimeProvenanceUnverifiedError,
  );
});
