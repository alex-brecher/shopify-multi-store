import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { daysUntilEndOfSupport, endOfSupport, PINNED_API_VERSIONS, releaseDate } from "../dist/api-versions.js";
import { DEFAULT_API_VERSION } from "../dist/constants.js";

const WARNING_DAYS = 60;

test("support dates derive from the version string: twelve months after the quarterly release", () => {
  assert.equal(releaseDate("2026-04").toISOString(), "2026-04-01T00:00:00.000Z");
  assert.equal(endOfSupport("2026-04").toISOString(), "2027-04-01T00:00:00.000Z");
  assert.equal(endOfSupport("2026-10").toISOString(), "2027-10-01T00:00:00.000Z");
  assert.equal(daysUntilEndOfSupport("2026-04", new Date("2027-01-31T00:00:00Z")), 60);
  assert.equal(daysUntilEndOfSupport("2026-04", new Date("2027-04-02T00:00:00Z")), -1);
  assert.throws(() => releaseDate("2026-05"), /quarterly/);
});

test(`every pinned Admin API version has more than ${WARNING_DAYS} days of Shopify support left`, () => {
  const pinned = { ...PINNED_API_VERSIONS, DEFAULT_API_VERSION };
  for (const [name, version] of Object.entries(pinned)) {
    const days = daysUntilEndOfSupport(version);
    assert.ok(
      days > WARNING_DAYS,
      `${name} pins ${version}, which Shopify stops supporting on ${endOfSupport(version).toISOString().slice(0, 10)} (${days} days). Move it to a newer version in src/api-versions.ts or src/constants.ts, bundle that schema, and revalidate the documents.`,
    );
  }
});

test("no Admin API version is pinned outside src/api-versions.ts and src/constants.ts", async () => {
  for (const file of ["../src/parity-tools.ts", "../src/admin-workflows.ts", "../src/read-tools.ts", "../src/admin-tools.ts"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /["']20\d\d-(01|04|07|10)["']/, `${file} pins a version literal`);
  }
});
