import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("M5 Network observation dereferences only route classification fields and numeric response status", async () => {
  const source = await readFile(
    new URL("../../src/cdp/ChromeRemoteInterfaceTransport.ts", import.meta.url),
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

  for (const forbidden of [
    "requestWillBeSentExtraInfo",
    "responseReceivedExtraInfo",
    "getResponseBody",
    "streamResourceContent",
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
