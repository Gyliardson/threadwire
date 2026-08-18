import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("M5 Network observation dereferences only route classification, redirect presence, and numeric response status", async () => {
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

  const redirectResponseFields = [...source.matchAll(/event\.redirectResponse\.([A-Za-z0-9_]+)/g)];
  assert.equal(redirectResponseFields.length, 0, "M5 may test redirectResponse presence but must not dereference its payload");
  assert.match(source, /event\.redirectResponse !== undefined/);

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

test("M5 Input and Page.navigate protocol failures are caught before raw CRI errors leave the adapter", async () => {
  const source = await readFile(
    new URL("../../src/cdp/ChromeRemoteInterfaceTransport.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /Input\.insertText\(\{ text \}\);\s*\} catch \{/s);
  assert.match(source, /Input\.dispatchKeyEvent\(\{[\s\S]*?\}\);\s*\} catch \{/);
  assert.match(source, /Page\.navigate\(\{ url \}\);\s*\} catch \{/s);
  assert.match(source, /CDP Page\.navigate command failed without retained protocol metadata\./);
});
