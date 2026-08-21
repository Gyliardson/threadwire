import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("M5 Network observation dereferences only route classification, redirect presence, and numeric response status", async () => {
  const source = await readFile(
    new URL("../../src/cdp/ChromeRemoteInterfaceSession.ts", import.meta.url),
    "utf8",
  );

  const requestFields = [...source.matchAll(/event\.request\.([A-Za-z0-9_]+)/g)]
    .map((match) => match[1])
    .filter((field): field is string => field !== undefined);
  assert.deepEqual([...new Set(requestFields)].sort(), ["method", "url"]);

  const responseFields = [...source.matchAll(/event\.response\.([A-Za-z0-9_]+)/g)]
    .map((match) => match[1])
    .filter((field): field is string => field !== undefined);
  assert.deepEqual([...new Set(responseFields)].sort(), ["status"]);

  const redirectResponseFields = [...source.matchAll(/event\.redirectResponse\.([A-Za-z0-9_]+)/g)];
  assert.equal(redirectResponseFields.length, 0, "M5 may test redirectResponse presence but must not dereference its payload");
  assert.match(source, /event\.redirectResponse !== undefined/);

  for (const forbidden of [
    "requestWillBeSentExtraInfo",
    "responseReceivedExtraInfo",
    "getResponseBody",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test("M5 transport contract contains no premature response-body ownership seam", async () => {
  const contract = await readFile(new URL("../../src/cdp/CdpTransport.ts", import.meta.url), "utf8");
  assert.equal(contract.includes("CdpResponseObservationHandle"), false);
  assert.equal(contract.includes("responseHandle"), false);
  assert.equal(contract.includes("getResponseBody"), false);
  assert.equal(contract.includes("streamResourceContent"), false);
});

test("M5 Input and Page.navigate protocol failures are caught before raw CRI errors leave the adapter", async () => {
  const source = await readFile(
    new URL("../../src/cdp/ChromeRemoteInterfaceSession.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /Input\.insertText\(\{ text \}\);\s*\} catch \{/s);
  assert.match(source, /Input\.dispatchKeyEvent\(\{[\s\S]*?\}\);\s*\} catch \{/);
  assert.match(source, /Page\.navigate\(\{ url \}\);\s*\} catch \{/s);
  assert.match(source, /CDP Page\.navigate command failed without retained protocol metadata\./);
});

test("navigation defense boundaries reconstruct stable errors without copying low-level messages", async () => {
  const manager = await readFile(new URL("../../src/cdp/CdpSessionManager.ts", import.meta.url), "utf8");
  const router = await readFile(new URL("../../src/routing/ConversationRouter.ts", import.meta.url), "utf8");

  const managerSanitizer = manager.match(/function sanitizedNavigationCause[\s\S]*?\n\}/)?.[0];
  const routerSanitizer = router.match(/function sanitizedRouteNavigationCause[\s\S]*?\n\}/)?.[0];
  assert.ok(managerSanitizer);
  assert.ok(routerSanitizer);
  assert.equal(managerSanitizer.includes("error.message"), false);
  assert.equal(routerSanitizer.includes("error.message"), false);
  assert.match(managerSanitizer, /new CdpNavigationFailedError\(\)/);
  assert.match(routerSanitizer, /new CdpNavigationFailedError\(\)/);
  assert.match(router, /throw new RouteNavigationFailedError\(\);/);
});
