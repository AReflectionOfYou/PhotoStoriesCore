import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join as pjoin } from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { join, readJson } from "../src/adapter.ts";
import { exportBundle } from "../src/export.ts";
import { listPhotoIds } from "../src/project.ts";
import { NOW, sampleProject, tempAdapter, v1Bag } from "./helpers.ts";

const schema = JSON.parse(await readFile(pjoin(import.meta.dirname, "..", "schema", "photo.schema.json"), "utf8"));
const validate = new (Ajv2020 as unknown as typeof Ajv2020.default)({ allErrors: true, strict: false }).compile(schema);

test("schema: exported schema-2 sidecars validate against the JSON Schema", async () => {
  const { fs, dir } = await tempAdapter();
  await sampleProject(fs, join(dir, "p"));
  const r = await exportBundle(fs, join(dir, "p"), join(dir, "out"), { now: NOW, keepFolder: true, includeWithoutStory: true });
  for (const id of await listPhotoIds(fs, join(r.bagDir, "data"))) {
    const doc = await readJson(fs, join(r.bagDir, "data", "photos", id, "photo.json"));
    assert.ok(validate(doc), JSON.stringify(validate.errors));
  }
});

test("schema: the shared online app's schema-1 sidecars validate too", async () => {
  const { fs, dir } = await tempAdapter();
  const { photoId } = await v1Bag(fs, join(dir, "bag"));
  const doc = await readJson(fs, join(dir, "bag", "data", "photos", photoId, "photo.json"));
  assert.ok(validate(doc), JSON.stringify(validate.errors));
});

test("schema: a broken sidecar is caught", () => {
  assert.ok(!validate({ schema_version: "2", photo: { id: "x", original_sha256: "nope" }, files: {} }));
  assert.ok(!validate({ photo: { id: "x" } }));
});
