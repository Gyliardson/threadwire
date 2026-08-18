import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = fileURLToPath(new URL("../../src/", import.meta.url));

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return await collectTypeScriptFiles(absolute);
      }
      return entry.isFile() && entry.name.endsWith(".ts") ? [absolute] : [];
    }),
  );
  return nested.flat();
}

test("chrome-remote-interface remains isolated to the production transport adapter", async () => {
  const files = await collectTypeScriptFiles(srcRoot);
  const importers: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (source.includes('from "chrome-remote-interface"')) {
      importers.push(path.relative(srcRoot, file).split(path.sep).join("/"));
    }
  }
  assert.deepEqual(importers, ["cdp/ChromeRemoteInterfaceTransport.ts"]);
});

test("M5 executor contains no navigation, reload, Runtime.evaluate, raw CRI, or response-body path", async () => {
  const source = await readFile(new URL("../../src/turn/TurnExecutor.ts", import.meta.url), "utf8");
  for (const forbidden of [
    "Page.navigate",
    "Page.reload",
    "Runtime.evaluate",
    "chrome-remote-interface",
    "getResponseBody",
    "streamResourceContent",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("M5 CDP boundary adds no arbitrary send, reload, Runtime.evaluate, or response-body primitive", async () => {
  const transportContract = await readFile(new URL("../../src/cdp/CdpTransport.ts", import.meta.url), "utf8");
  const productionTransport = await readFile(
    new URL("../../src/cdp/ChromeRemoteInterfaceTransport.ts", import.meta.url),
    "utf8",
  );
  const combined = `${transportContract}\n${productionTransport}`;

  for (const forbidden of [
    "Runtime.evaluate",
    "Page.reload",
    "getResponseBody",
    "streamResourceContent",
    "send(method",
  ]) {
    assert.equal(combined.includes(forbidden), false, forbidden);
  }
});

test("route operations remain ROUTE and TurnExecutor owns TURN scheduling", async () => {
  const router = await readFile(new URL("../../src/routing/ConversationRouter.ts", import.meta.url), "utf8");
  const turnExecutor = await readFile(new URL("../../src/turn/TurnExecutor.ts", import.meta.url), "utf8");

  assert.match(router, /schedule\(\s*"ROUTE"/);
  assert.match(turnExecutor, /schedule\(\s*"TURN"/);
});
