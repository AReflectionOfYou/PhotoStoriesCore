// Test helpers: sample projects and an old-format (schema 1) bundle, built
// from the generated placeholder images in samples/images (no real people).

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { join, writeText, type FileAdapter } from "../src/adapter.ts";
import { finishBag } from "../src/bagit.ts";
import { addFace, addPhoto, createProject, ensurePerson, recordEdit, saveProject, setDetails, setStory, tagFace, writePhoto, type ProjectData } from "../src/project.ts";
import { canonicalJson, sha256File } from "../src/util.ts";
import { VIEWER_FILE, writeViewer } from "../src/viewer.ts";
import { NodeAdapter } from "../src/node-adapter.ts";

export const IMAGES = pjoin(import.meta.dirname, "..", "samples", "images");
export const NOW = new Date("2026-11-20T15:00:00Z");

/** Record sample sources by their path in this repo, never this computer's. */
const scrub = (doc: { provenance?: { source_path?: string } }) => {
  if (doc.provenance?.source_path) doc.provenance.source_path = `samples/images/${doc.provenance.source_path.split("/").pop()}`;
};

export async function tempAdapter() {
  const dir = await mkdtemp(pjoin(tmpdir(), "psc-"));
  return { fs: new NodeAdapter("/"), dir };
}

/** A project with two storied photos (house, boat) and one without a story (hills). */
export async function sampleProject(fs: FileAdapter, root: string, opts: { owner?: string; name?: string } = {}) {
  const project = await createProject(fs, root, { name: opts.name ?? "Rose's photos", ownerName: opts.owner ?? "Rose Example", ownerContact: "rose@example.test", rights: "CC BY 4.0", now: NOW });
  const by = String(project.group.owner_contributor_id);

  const house = (await addPhoto(fs, root, project, { sourcePath: pjoin(IMAGES, "house.jpg"), now: NOW })).doc;
  await fs.writeFile(join(root, "photos", house.photo.id, "image.jpg"), await fs.readFile(pjoin(IMAGES, "house.jpg")));
  await fs.writeFile(join(root, "photos", house.photo.id, "thumb.jpg"), await fs.readFile(pjoin(IMAGES, "house.jpg")));
  scrub(house);
  house.files.image = "image.jpg";
  house.files.thumb = "thumb.jpg";
  setDetails(house, { caption: "The red house on Elm Street", date_text: "summer of 1965", date_edtf: "1965-22", place_text: "Elm Street, Springfield", notes: "Painted red in 1964.", certainty: { date_text: "likely" } }, by, { now: NOW });
  const bob = ensurePerson(project, "Robert Example", by, NOW);
  const face = addFace(house, { x: 0.45, y: 0.6, w: 0.08, h: 0.12 }, by, { detector: "test", now: NOW });
  tagFace(house, String(face.id), String(bob.id), by, { now: NOW });
  setStory(house, { transcript: "um so this is the the house we grew up in", storyText: "This is the house we grew up in.", cleanup: { method: "local" }, transcriptModel: "whisper-small" }, by, NOW);
  recordEdit(house, "crop", { x: 0, y: 0, w: 1, h: 1 }, NOW);
  await writePhoto(fs, root, house, project);

  const boat = (await addPhoto(fs, root, project, { sourcePath: pjoin(IMAGES, "boat.jpg"), now: new Date(NOW.getTime() + 1000) })).doc;
  scrub(boat);
  setDetails(boat, { caption: "Grandpa's sailboat", date_text: "the 1970s", date_edtf: "197X" }, by, { now: NOW });
  setStory(boat, { storyText: "We sailed every Sunday.", cleanup: { method: "local" } }, by, NOW);
  await writePhoto(fs, root, boat, project);

  const hills = (await addPhoto(fs, root, project, { sourcePath: pjoin(IMAGES, "hills.jpg"), now: new Date(NOW.getTime() + 2000) })).doc;
  scrub(hills);
  await writePhoto(fs, root, hills, project);

  await saveProject(fs, root, project);
  return { project, by, house, boat, hills };
}

/** An export bundle in the shared online app's format (schema 1), as its worker writes it. */
export async function v1Bag(fs: FileAdapter, bag: string): Promise<{ photoId: string; personId: string }> {
  const g = "11111111-1111-4111-8111-111111111111";
  const c = "22222222-2222-4222-8222-222222222222";
  const col = "33333333-3333-4333-8333-333333333333";
  const person = "44444444-4444-4444-8444-444444444444";
  const photo = "55555555-5555-4555-8555-555555555555";
  const t = "2026-10-20T12:00:00.000Z";
  const data = join(bag, "data");
  const put = (p: string, v: unknown) => writeText(fs, join(data, p), canonicalJson(v));
  await put("group.json", { id: g, name: "The Example Family", slug: "the-examples", status: "active", monthly_cost_cap_cents: 1000, use_own_api_keys: false, created_at: t, closed_at: null, delete_after: null });
  await put("contributors.json", [{ id: c, group_id: g, display_name: "Amy", consent_text_version: "v1", consent_given_at: t, created_at: t }]);
  await put("people.json", [{ id: person, group_id: g, display_name: "Bob Example", aliases: ["Bobby"], notes: null, created_by: c, created_at: t, updated_at: t }]);
  await put("collections.json", [{ id: col, group_id: g, name: "Grandma's blue album", description: null, created_by: c, created_at: t }]);
  await put("events.json", []);
  await put("usage.json", []);
  await put("consent.json", [{ version: "v1", text: "I agree my voice is recorded." }]);
  await put("manifest.json", { schema_version: "1", generator: { name: "family-photo-stories-worker", version: "1.0.0" }, scope: { kind: "group" }, contents: "the whole family project", counts: { photos: 1 }, include_removed: false, exported_at: t });
  const dir = join(data, "photos", photo);
  await fs.mkdir(join(dir, "audio", "originals"));
  await fs.writeFile(join(dir, "original.jpg"), await fs.readFile(pjoin(IMAGES, "garden.jpg")));
  await fs.writeFile(join(dir, "image.jpg"), await fs.readFile(pjoin(IMAGES, "garden.jpg")));
  const sha = await sha256File(fs, join(dir, "original.jpg"));
  await put(`photos/${photo}/photo.json`, {
    schema_version: "1",
    photo: { id: photo, group_id: g, collection_id: col, event_id: null, source_mode: "capture", original_path: `groups/${g}/photos/${photo}/original.jpg`, original_sha256: sha, original_mime: "image/jpeg", original_filename: "IMG_0412.jpg", original_bytes: 0, derived_path: null, crop_params: { rotate: 0 }, hidden: false, created_by: c, created_at: t },
    details: { photo_id: photo, group_id: g, caption: "Grandma's garden", date_text: "about 1958", date_edtf: "1958~", date_certainty: "likely", place_text: "Maple Farm", place_certainty: "sure", change_source: "person", updated_by: c, updated_at: t },
    people_in_photo: [{ id: "66666666-6666-4666-8666-666666666666", group_id: g, photo_id: photo, person_id: person, face_id: null, certainty: "sure", source: "person", added_by: c, added_at: t, removed_by: null, removed_at: null }],
    faces: [],
    face_tag_history: [],
    field_history: [],
    contributions: [{ id: "77777777-7777-4777-8777-777777777777", group_id: g, photo_id: photo, contributor_id: c, kind: "story", parent_id: null, prompt_text: "Tell us about this photo.", transcript: "We picked beans here every summer.", transcript_edited_text: null, typed_text: null, created_at: t, updated_at: t, deleted_at: null }],
    contribution_versions: [],
    ai_extractions: [],
    extraction_reviews: [],
    files: { original: "original.jpg", image: "image.jpg", audio: {} },
  });
  await writeText(fs, join(data, "README.md"), "# The Example Family\n");
  await writeViewer(fs, bag);
  await finishBag(fs, bag, { "Source-Organization": "The Example Family", "Bagging-Date": "2026-10-20", "Bag-Software-Agent": "family-photo-stories-worker 1.0.0" }, [VIEWER_FILE]);
  return { photoId: photo, personId: person };
}

export type { ProjectData };
