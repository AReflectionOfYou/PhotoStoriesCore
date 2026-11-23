// Build the sample packages in samples/ from the generated placeholder images
// (no real people): a schema-2 bundle like the desktop app makes, and a
// schema-1 bundle like the shared online app's worker makes.
//
//   npm run samples

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBundle } from "../src/export.ts";
import { NodeAdapter } from "../src/node-adapter.ts";
import { zipDir } from "../src/zip.ts";
import { NOW, sampleProject, v1Bag } from "../tests/helpers.ts";

const out = join(import.meta.dirname, "..", "samples");
const fs = new NodeAdapter("/");
const work = await mkdtemp(join(tmpdir(), "psc-samples-"));

const project = join(work, "project");
await sampleProject(fs, project, { name: "Sample photo stories", owner: "Rose Example" });
for (const f of ["sample-desktop-v2.zip", "sample-online-v1.zip"]) await rm(join(out, f), { force: true });
const r = await exportBundle(fs, project, work, { now: NOW, includeWithoutStory: true, generator: { name: "photostories-core samples", version: "0.1.0" } });
if (r.problems.length) throw new Error(r.problems.join("\n"));
await fs.copyFile(r.zipPath, join(out, "sample-desktop-v2.zip"));

const old = join(work, "the-examples_2026-10-20");
await v1Bag(fs, old);
await zipDir(fs, old, join(out, "sample-online-v1.zip"));

await rm(work, { recursive: true, force: true });
console.log("wrote samples/sample-desktop-v2.zip and samples/sample-online-v1.zip");
