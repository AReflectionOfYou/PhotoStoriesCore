import assert from "node:assert/strict";
import { test } from "node:test";
import { join, readJson, readText, walk } from "../src/adapter.ts";
import { checkBag, validateBag } from "../src/bagit.ts";
import { edtfInRange, edtfToXmpDate, toEdtf } from "../src/dates.ts";
import { exportBundle } from "../src/export.ts";
import { commitImport, planImport } from "../src/import.ts";
import { migrateBag } from "../src/migrate.ts";
import { nearMatch, reviewNames } from "../src/names.ts";
import { createProject, listPhotoIds, loadProject, readPhoto, saveProject, ensurePerson } from "../src/project.ts";
import { SCHEMA_VERSION, type PhotoDoc } from "../src/schema.ts";
import { unzipTo, findBag } from "../src/zip.ts";
import { NOW, sampleProject, tempAdapter, v1Bag } from "./helpers.ts";

test("dates: EDTF from what people say", () => {
  assert.equal(toEdtf("1965"), "1965");
  assert.equal(toEdtf("about 1965"), "1965~");
  assert.equal(toEdtf("maybe 1965"), "1965?");
  assert.equal(toEdtf("the 1960s"), "196X");
  assert.equal(toEdtf("July 1965"), "1965-07");
  assert.equal(toEdtf("July 4th, 1965"), "1965-07-04");
  assert.equal(toEdtf("summer of 1965"), "1965-22");
  assert.equal(toEdtf("when I was little"), null);
  assert.equal(edtfToXmpDate("1965-22"), "1965");
  assert.equal(edtfToXmpDate("1965-07-04"), "1965-07-04");
  assert.equal(toEdtf("July 4, 2019, 10:30 AM"), "2019-07-04T10:30:00");
  assert.equal(toEdtf("July 4, 2019 at 3:05 pm"), "2019-07-04T15:05:00");
  assert.equal(toEdtf("2019-07-04T10:30:00"), "2019-07-04T10:30:00");
  assert.equal(toEdtf("July 2019, 10:30"), "2019-07");
  assert.equal(edtfToXmpDate("2019-07-04T10:30:00"), "2019-07-04T10:30:00");
  assert.ok(edtfInRange("196X", "1965", "1970"));
  assert.ok(!edtfInRange("1950", "1960", "1970"));
});

test("names: near-matches are flagged, exact matches merge", () => {
  assert.equal(nearMatch("Bob Smith", "Robert Smith"), "nickname");
  assert.equal(nearMatch("Kathryn", "Katheryn"), "spelling");
  assert.equal(nearMatch("Rose", "Grandma Rose"), "part of the name");
  assert.equal(nearMatch("Bob", "Robert Smith"), "nickname");
  assert.equal(nearMatch("Rose", "Walter"), null);
  const r = reviewNames(
    [{ id: "a", display_name: "Robert Smith" }, { id: "b", display_name: "rose", aliases: [] }, { id: "c", display_name: "Walter" }],
    [{ id: "x", display_name: "Bob Smith" }, { id: "y", display_name: "Rose" }],
  );
  assert.deepEqual(r.map((n) => n.status), ["review", "same", "new"]);
});

test("export: a valid BagIt zip with photos, sidecars, thumbnails, readme and viewer", async () => {
  const { fs, dir } = await tempAdapter();
  const root = join(dir, "project");
  const { house, boat, hills } = await sampleProject(fs, root);
  const r = await exportBundle(fs, root, join(dir, "out"), { now: NOW, keepFolder: true, generator: { name: "test-app", version: "9.9.9" } });
  assert.deepEqual(r.problems, []);
  assert.ok(await fs.exists(r.zipPath));
  assert.equal(r.counts.photos, 2, "the photo with no story is left out by default");
  const ids = (await fs.list(join(r.bagDir, "data", "photos"))).map((e) => e.name).sort();
  assert.deepEqual(ids, [house.photo.id, boat.photo.id].sort());
  assert.ok(!ids.includes(hills.photo.id));
  for (const f of ["bagit.txt", "bag-info.txt", "manifest-sha256.txt", "tagmanifest-sha256.txt", "START HERE.html", "data/README.md", "data/manifest.json", `data/photos/${house.photo.id}/thumb.jpg`]) assert.ok(await fs.exists(join(r.bagDir, f)), f);
  const info = await readText(fs, join(r.bagDir, "bag-info.txt"));
  for (const k of ["Source-Organization: Rose Example", "Contact-Email: rose@example.test", "Bagging-Date: 2026-11-20", "External-Description:", "Payload-Oxum:", "Bag-Size:", "Photo-Count: 2"]) assert.ok(info.includes(k), k);
  // The zip unpacks to the same valid bag.
  await unzipTo(fs, r.zipPath, join(dir, "unzipped"));
  assert.deepEqual(await validateBag(fs, await findBag(fs, join(dir, "unzipped"))), []);
  // Dublin Core is in the sidecar.
  const doc = await readJson<PhotoDoc>(fs, join(r.bagDir, "data", "photos", house.photo.id, "photo.json"));
  assert.equal(doc.schema_version, SCHEMA_VERSION);
  assert.equal(doc.dublin_core?.title, "The red house on Elm Street");
  assert.equal(doc.dublin_core?.description, "This is the house we grew up in.");
  assert.deepEqual(doc.dublin_core?.subject, ["Robert Example"]);
  assert.deepEqual(doc.dublin_core?.creator, ["Rose Example"]);
  assert.equal(doc.dublin_core?.coverage, "Elm Street, Springfield");
  assert.equal(doc.dublin_core?.date, "1965-22");
  assert.equal(doc.dublin_core?.source, "house.jpg");
  assert.equal(doc.dublin_core?.rights, "CC BY 4.0");
  // The viewer has the data, the new controls, and the footer.
  const html = await readText(fs, join(r.bagDir, "START HERE.html"));
  for (const s of ["The red house on Elm Street", "ArrowLeft", "Escape", "Show face boxes", "Copyright 2026 Michael A. Heroux", "creativecommons.org/licenses/by/4.0", "opensource.org/license/mit", "data/photos/"]) assert.ok(html.includes(s), s);
  assert.ok(!html.includes("</script><"), "embedded data can't close the script early");
});

test("export: only chosen photos, or every photo", async () => {
  const { fs, dir } = await tempAdapter();
  const root = join(dir, "p");
  const { boat, hills } = await sampleProject(fs, root);
  const one = await exportBundle(fs, root, join(dir, "out"), { photoIds: [boat.photo.id], now: NOW });
  assert.equal(one.counts.photos, 1);
  assert.match(one.bagName, /_1-photos_archive$/);
  const all = await exportBundle(fs, root, join(dir, "out"), { includeWithoutStory: true, now: NOW });
  assert.equal(all.counts.photos, 3);
  assert.match(all.bagName, /_\d{4}-\d{2}-\d{2}_archive$/, "archives are named apart from the project folder");
  assert.ok(all.bagName !== one.bagName);
  void hills;
});

test("round trip: export, import into an empty project, export again, nothing lost", async () => {
  const { fs, dir } = await tempAdapter();
  const a = join(dir, "a");
  await sampleProject(fs, a);
  const first = await exportBundle(fs, a, join(dir, "out1"), { now: NOW, keepFolder: true });

  const b = join(dir, "b");
  await createProject(fs, b, { name: "New computer", ownerName: "Rose Example", rights: "CC BY 4.0", now: NOW });
  const plan = await planImport(fs, first.zipPath, b);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.preview.new, 2);
  assert.equal(plan.preview.duplicates, 0);
  const summary = await commitImport(fs, plan);
  assert.equal(summary.added.length, 2);
  assert.ok(!(await fs.exists(plan.workDir!)), "the unzipped copy is cleaned up");

  const second = await exportBundle(fs, b, join(dir, "out2"), { now: NOW, keepFolder: true });
  assert.deepEqual(second.problems, []);
  const ids = await listPhotoIds(fs, join(first.bagDir, "data"));
  assert.deepEqual(await listPhotoIds(fs, join(second.bagDir, "data")), ids, "photo ids are kept");
  const bp = await loadProject(fs, b);
  for (const id of ids) {
    const x = await readJson<PhotoDoc>(fs, join(first.bagDir, "data", "photos", id, "photo.json"));
    const y = await readJson<PhotoDoc>(fs, join(second.bagDir, "data", "photos", id, "photo.json"));
    // Everything is the same except the project the photo now belongs to.
    const strip = (d: PhotoDoc) => JSON.parse(JSON.stringify(d).replaceAll(String(d.photo.group_id), "G"));
    assert.deepEqual(strip(y), strip(x));
    assert.equal(y.photo.group_id, bp.group.id);
    // Every file is byte-identical.
    for (const f of await walk(fs, join(first.bagDir, "data", "photos", id))) {
      if (f.endsWith("photo.json")) continue;
      const g = f.replace(first.bagDir, second.bagDir);
      assert.deepEqual(await fs.readFile(g), await fs.readFile(f), f);
    }
  }
  // People and storytellers came across.
  assert.ok(bp.people.some((p) => p.display_name === "Robert Example"));
  assert.ok(bp.contributors.some((c) => c.display_name === "Rose Example"));
});

test("import: duplicates are found by checksum and handled as chosen", async () => {
  const { fs, dir } = await tempAdapter();
  const root = join(dir, "p");
  await sampleProject(fs, root);
  const out = await exportBundle(fs, root, join(dir, "out"), { now: NOW });

  const skip = await planImport(fs, out.zipPath, root);
  assert.equal(skip.preview.duplicates, 2);
  assert.equal(skip.preview.new, 0);
  const s1 = await commitImport(fs, skip, { allDuplicates: "skip" });
  assert.equal(s1.skipped.length, 2);
  assert.equal((await listPhotoIds(fs, root)).length, 3);

  const both = await planImport(fs, out.zipPath, root);
  const s2 = await commitImport(fs, both, { allDuplicates: "keepBoth" });
  assert.equal(s2.keptBoth.length, 2);
  const ids = await listPhotoIds(fs, root);
  assert.equal(ids.length, 5, "kept both: new ids for the copies");
  for (const id of ids) {
    const d = await readPhoto(fs, root, id);
    assert.equal(d.photo.id, id);
    for (const f of d.faces) assert.equal(f.photo_id, id);
  }

  const rep = await planImport(fs, out.zipPath, root);
  const first = rep.photos[0];
  const s3 = await commitImport(fs, rep, { duplicates: { [first.id]: "replace" }, allDuplicates: "skip" });
  assert.equal(s3.replaced.length, 1);
  assert.equal(s3.skipped.length, 1);
  assert.ok(await fs.exists(join(root, "photos", first.id, "photo.json")));
});

test("import: near-match names wait for a decision; merges keep the other name as an alias", async () => {
  const { fs, dir } = await tempAdapter();
  const a = join(dir, "a");
  await sampleProject(fs, a); // has "Robert Example"
  const out = await exportBundle(fs, a, join(dir, "out"), { now: NOW });

  const b = join(dir, "b");
  const pb = await createProject(fs, b, { name: "Other", ownerName: "Sam", now: NOW });
  const bob = ensurePerson(pb, "Bob Example", String(pb.group.owner_contributor_id), NOW);
  await saveProject(fs, b, pb);

  const plan = await planImport(fs, out.zipPath, b);
  assert.equal(plan.preview.namesToReview, 1);
  const review = plan.names.find((n) => n.status === "review")!;
  assert.equal(review.matches[0].person.id, bob.id);
  const summary = await commitImport(fs, plan, { names: { [review.incoming.id]: String(bob.id) } });
  assert.deepEqual(summary.peopleMerged, [{ from: "Robert Example", into: "Bob Example" }]);
  const after = await loadProject(fs, b);
  assert.equal(after.people.length, 1);
  assert.deepEqual(after.people[0].aliases, ["Robert Example"]);
  // The face in the imported photo now points at Bob.
  const house = (await Promise.all((await listPhotoIds(fs, b)).map((id) => readPhoto(fs, b, id)))).find((d) => d.faces.length)!;
  assert.equal(house.faces[0].person_id, bob.id);
  assert.deepEqual(house.dublin_core?.subject, ["Bob Example"]);
});

test("import: damaged files are reported, and only valid photos come in unless asked", async () => {
  const { fs, dir } = await tempAdapter();
  const root = join(dir, "p");
  const { boat } = await sampleProject(fs, root);
  const out = await exportBundle(fs, root, join(dir, "out"), { now: NOW, keepFolder: true });
  const bad = join(out.bagDir, "data", "photos", boat.photo.id, "original.jpg");
  const bytes = await fs.readFile(bad);
  bytes[bytes.length - 10] ^= 0xff;
  await fs.writeFile(bad, bytes);
  const before = await fs.readFile(bad);

  const fresh = join(dir, "fresh");
  await createProject(fs, fresh, { name: "Fresh", ownerName: "Rose Example", now: NOW });
  const plan = await planImport(fs, out.bagDir, fresh);
  assert.ok(plan.problems.some((p) => p.includes("checksum mismatch") && p.includes(boat.photo.id)));
  assert.equal(plan.preview.damaged, 1);
  const s = await commitImport(fs, plan);
  assert.deepEqual(s.damagedSkipped, [boat.photo.id]);
  assert.equal(s.added.length, 1);
  assert.deepEqual(await fs.readFile(bad), before, "the source bag is never modified");
});

test("migration: an old (schema 1) bundle is upgraded on import, nothing lost", async () => {
  const { fs, dir } = await tempAdapter();
  const bag = join(dir, "old-bag");
  const { photoId, personId } = await v1Bag(fs, bag);
  assert.deepEqual(await validateBag(fs, bag), []);
  const original = await readJson<PhotoDoc>(fs, join(bag, "data", "photos", photoId, "photo.json"));

  const root = join(dir, "p");
  await createProject(fs, root, { name: "Desktop", ownerName: "Amy", now: NOW });
  const plan = await planImport(fs, bag, root);
  assert.equal(plan.preview.olderSchema, 1);
  await commitImport(fs, plan);
  const doc = await readPhoto(fs, root, photoId);
  assert.equal(doc.schema_version, "2");
  assert.equal(doc.dublin_core?.title, "Grandma's garden");
  assert.equal(doc.dublin_core?.description, "We picked beans here every summer.");
  assert.equal(doc.dublin_core?.coverage, "Maple Farm");
  assert.equal(doc.dublin_core?.date, "1958~");
  assert.deepEqual(doc.dublin_core?.subject, ["Bob Example"]);
  // Every v1 field is still there with the same value (only group_id now names the new project).
  const regroup = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(regroup) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "group_id" ? "G" : regroup(x)])) : v;
  for (const k of Object.keys(original) as (keyof PhotoDoc)[]) {
    if (k === "schema_version") continue;
    const after = regroup(doc[k]) as Record<string, unknown>;
    const before = regroup(original[k]) as Record<string, unknown>;
    // The migration may add fields (e.g. pinned creator and rights in details), never change or drop old ones.
    if (before && typeof before === "object" && !Array.isArray(before)) for (const f of Object.keys(before)) assert.deepEqual(after[f], before[f], `${String(k)}.${f}`);
    else assert.deepEqual(after, before, String(k));
  }
  assert.equal(doc.people_in_photo[0].person_id, personId);
});

test("migration: an old bundle upgraded in place is backed up, re-checksummed and valid", async () => {
  const { fs, dir } = await tempAdapter();
  const bag = join(dir, "old-bag");
  const { photoId } = await v1Bag(fs, bag);
  const r = await migrateBag(fs, bag);
  assert.equal(r.migrated, 1);
  assert.deepEqual(r.problems, []);
  assert.ok(r.backup && (await fs.exists(join(r.backup, "data", "photos", photoId, "photo.json"))));
  assert.equal((await readJson<PhotoDoc>(fs, join(r.backup!, "data", "photos", photoId, "photo.json"))).schema_version, "1");
  const doc = await readJson<PhotoDoc>(fs, join(bag, "data", "photos", photoId, "photo.json"));
  assert.equal(doc.schema_version, "2");
  assert.equal((await readJson<any>(fs, join(bag, "data", "manifest.json"))).schema_version, "2");
  assert.deepEqual((await checkBag(fs, bag)).problems, []);
  // Running it again changes nothing.
  assert.equal((await migrateBag(fs, bag)).migrated, 0);
});

test("import: a sidecar newer than this library is flagged and read as far as possible", async () => {
  const { fs, dir } = await tempAdapter();
  const root = join(dir, "p");
  await sampleProject(fs, root);
  const out = await exportBundle(fs, root, join(dir, "out"), { now: NOW, keepFolder: true });
  const id = (await listPhotoIds(fs, join(out.bagDir, "data")))[0];
  const p = join(out.bagDir, "data", "photos", id, "photo.json");
  const doc = await readJson<PhotoDoc>(fs, p);
  doc.schema_version = "99";
  const { canonicalJson } = await import("../src/util.ts");
  const { finishBag } = await import("../src/bagit.ts");
  await fs.writeFile(p, new TextEncoder().encode(canonicalJson(doc)));
  const { readBagInfo } = await import("../src/bagit.ts");
  const { "Payload-Oxum": _o, ...info } = await readBagInfo(fs, out.bagDir);
  await finishBag(fs, out.bagDir, info, ["START HERE.html"]);
  const fresh = join(dir, "fresh");
  await createProject(fs, fresh, { name: "F", ownerName: "Rose Example", now: NOW });
  const plan = await planImport(fs, out.bagDir, fresh);
  assert.equal(plan.preview.newerSchema, 1);
  const s = await commitImport(fs, plan);
  assert.deepEqual(s.newerSchema, [id]);
  assert.equal(s.added.length, 2);
});

test("import: photos from someone else's project keep their own creator and rights", async () => {
  const { fs, dir } = await tempAdapter();
  const a = join(dir, "a");
  const { house } = await sampleProject(fs, a);
  const out = await exportBundle(fs, a, join(dir, "out"), { now: NOW });
  const b = join(dir, "b");
  await createProject(fs, b, { name: "Sam's", ownerName: "Sam Other", rights: "All rights reserved", now: NOW });
  await commitImport(fs, await planImport(fs, out.zipPath, b));
  const doc = await readPhoto(fs, b, house.photo.id);
  assert.deepEqual(doc.dublin_core?.creator, ["Rose Example"]);
  assert.equal(doc.dublin_core?.rights, "CC BY 4.0");
});
