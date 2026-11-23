// A project: a folder with the same layout as a bundle's data/ (see schema.ts).
// The desktop app keeps one per collection of special photos. Nothing here
// ever touches the person's own photo library: photos are copied in first.

import { copyFile, join, readJson, writeText, type FileAdapter } from "./adapter.ts";
import { contextFrom, dublinCore } from "./dublin-core.ts";
import { compareVersions, emptyPhotoDoc, LIBRARY, SCHEMA_VERSION, TOP_FILES, type Certainty, type PhotoDoc } from "./schema.ts";
import { canonicalJson, extOf, mimeOf, sha256File, slugPart, sortRows, uuid, type Row } from "./util.ts";

export interface ProjectData {
  group: Row;
  contributors: Row[];
  people: Row[];
  collections: Row[];
  events: Row[];
  consent: Row[];
  usage: Row[];
}

export interface NewProject {
  name: string;
  /** The person whose photos and stories these are; becomes the storyteller. */
  ownerName: string;
  ownerContact?: string;
  /** dc:rights for the photos and stories, e.g. "CC BY 4.0" or "All rights reserved". */
  rights?: string;
  /** Whether the owner is dc:creator (default) or dc:contributor. */
  ownerRole?: "creator" | "contributor";
  collectionName?: string;
  now?: Date;
}

export async function createProject(fs: FileAdapter, root: string, opts: NewProject): Promise<ProjectData> {
  const now = (opts.now ?? new Date()).toISOString();
  const groupId = uuid();
  const ownerId = uuid();
  const group: Row = {
    id: groupId,
    name: opts.name,
    slug: slugPart(opts.name) || "photo-stories",
    status: "active",
    created_at: now,
    closed_at: null,
    delete_after: null,
    // Schema 2:
    owner_name: opts.ownerName,
    owner_contact: opts.ownerContact ?? null,
    owner_role: opts.ownerRole ?? "creator",
    rights: opts.rights ?? null,
    owner_contributor_id: ownerId,
  };
  const data: ProjectData = {
    group,
    contributors: [{ id: ownerId, group_id: groupId, display_name: opts.ownerName, consent_text_version: null, consent_given_at: null, created_at: now }],
    people: [],
    collections: [{ id: uuid(), group_id: groupId, name: opts.collectionName ?? "My photos", description: null, created_by: ownerId, created_at: now }],
    events: [],
    consent: [],
    usage: [],
  };
  await fs.mkdir(join(root, "photos"));
  await saveProject(fs, root, data);
  return data;
}

const fileOf: Record<keyof ProjectData, (typeof TOP_FILES)[number]> = {
  group: "group.json",
  contributors: "contributors.json",
  people: "people.json",
  collections: "collections.json",
  events: "events.json",
  consent: "consent.json",
  usage: "usage.json",
};

export async function loadProject(fs: FileAdapter, root: string): Promise<ProjectData> {
  const read = async (k: keyof ProjectData) => ((await fs.exists(join(root, fileOf[k]))) ? readJson(fs, join(root, fileOf[k])) : k === "group" ? {} : []);
  const [group, contributors, people, collections, events, consent, usage] = await Promise.all(
    (["group", "contributors", "people", "collections", "events", "consent", "usage"] as const).map(read),
  );
  return { group, contributors, people, collections, events, consent, usage } as ProjectData;
}

export async function saveProject(fs: FileAdapter, root: string, data: ProjectData, only?: (keyof ProjectData)[]): Promise<void> {
  for (const k of only ?? (Object.keys(fileOf) as (keyof ProjectData)[])) {
    const v = k === "group" ? data.group : sortRows(data[k] as Row[]);
    await writeText(fs, join(root, fileOf[k]), canonicalJson(v));
  }
}

export async function listPhotoIds(fs: FileAdapter, root: string): Promise<string[]> {
  if (!(await fs.exists(join(root, "photos")))) return [];
  return (await fs.list(join(root, "photos"))).filter((e) => e.isDirectory).map((e) => e.name).sort();
}

export const photoDir = (root: string, id: string) => join(root, "photos", id);

export async function readPhoto(fs: FileAdapter, root: string, id: string): Promise<PhotoDoc> {
  return readJson<PhotoDoc>(fs, join(photoDir(root, id), "photo.json"));
}

/** Write a photo's sidecar, refreshing its Dublin Core mapping first. */
export async function writePhoto(fs: FileAdapter, root: string, doc: PhotoDoc, project: ProjectData): Promise<void> {
  if (!doc.schema_version || compareVersions(String(doc.schema_version), SCHEMA_VERSION) < 0) doc.schema_version = SCHEMA_VERSION;
  doc.dublin_core = dublinCore(doc, contextFrom(project.group, project.people, project.contributors));
  await writeText(fs, join(photoDir(root, String(doc.photo.id)), "photo.json"), canonicalJson(doc));
}

/** Every photo's id and original checksum, for finding duplicates. */
export async function checksums(fs: FileAdapter, root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of await listPhotoIds(fs, root)) {
    const doc = await readPhoto(fs, root, id).catch(() => null);
    if (doc?.photo.original_sha256) out.set(String(doc.photo.original_sha256), id);
  }
  return out;
}

export interface AddPhoto {
  /** Path the adapter can read: the photo in the person's own library. It is only read. */
  sourcePath: string;
  sourceFilename?: string;
  copySize?: "full" | "resized";
  maxLongEdge?: number | null;
  collectionId?: string;
  app?: { name: string; version: string };
  now?: Date;
}

/**
 * Copy a photo into the project and start its sidecar. If the same photo
 * (by checksum) is already in the project, returns that one instead.
 * The caller writes image.jpg (the working copy) and thumb.jpg afterwards.
 */
export async function addPhoto(fs: FileAdapter, root: string, project: ProjectData, opts: AddPhoto): Promise<{ doc: PhotoDoc; existing: boolean }> {
  const sha = await sha256File(fs, opts.sourcePath);
  const already = (await checksums(fs, root)).get(sha);
  if (already) return { doc: await readPhoto(fs, root, already), existing: true };
  const now = (opts.now ?? new Date()).toISOString();
  const id = uuid();
  const filename = opts.sourceFilename ?? opts.sourcePath.split(/[\\/]/).pop() ?? "photo";
  const original = `original.${extOf(filename)}`;
  await copyFile(fs, opts.sourcePath, join(photoDir(root, id), original));
  const owner = String(project.group.owner_contributor_id ?? project.contributors[0]?.id ?? "");
  const doc = emptyPhotoDoc({
    id,
    group_id: project.group.id,
    collection_id: opts.collectionId ?? project.collections[0]?.id ?? null,
    event_id: null,
    source_mode: "existing",
    original_path: `photos/${id}/${original}`,
    original_sha256: sha,
    original_mime: mimeOf(filename),
    original_filename: filename,
    original_bytes: await fs.size(join(photoDir(root, id), original)),
    derived_path: null,
    crop_params: null,
    hidden: false,
    created_by: owner || null,
    created_at: now,
  });
  doc.files.original = original;
  doc.provenance = {
    source_filename: filename,
    source_path: opts.sourcePath,
    copied_at: now,
    copy_size: opts.copySize ?? "full",
    max_long_edge: opts.copySize === "resized" ? (opts.maxLongEdge ?? null) : null,
    app: opts.app ?? LIBRARY,
  };
  doc.edits = [];
  await writePhoto(fs, root, doc, project);
  return { doc, existing: false };
}

// ---- Editing helpers. Each keeps history in the same shape as the shared online app.

export type DetailField = "caption" | "date_text" | "date_edtf" | "place_text" | "event_text" | "photographer_text" | "original_location_text" | "notes" | "latitude" | "longitude";

/** Change details (title, date, place, notes...), recording each change in field_history. */
export function setDetails(doc: PhotoDoc, patch: Partial<Record<DetailField, unknown>> & { certainty?: Partial<Record<string, Certainty | null>> }, by: string, opts: { source?: string; now?: Date } = {}) {
  const now = (opts.now ?? new Date()).toISOString();
  const f: Row = doc.details ?? { photo_id: doc.photo.id, group_id: doc.photo.group_id };
  for (const [field, value] of Object.entries(patch)) {
    if (field === "certainty") continue;
    const v = value === "" ? null : (value ?? null);
    if ((f[field] ?? null) === v) continue;
    doc.field_history.push({ id: uuid(), group_id: doc.photo.group_id, photo_id: doc.photo.id, field, old_value: f[field] ?? null, new_value: v, certainty: patch.certainty?.[field] ?? null, changed_by: by, changed_at: now, source: opts.source ?? "person" });
    f[field] = v;
  }
  for (const [field, c] of Object.entries(patch.certainty ?? {})) f[`${field.replace(/_text$/, "")}_certainty`] = c ?? null;
  f.change_source = opts.source ?? "person";
  f.updated_by = by;
  f.updated_at = now;
  doc.details = f;
}

/** Find a person by name or alias (ignoring case), or add them. */
export function ensurePerson(project: ProjectData, name: string, by: string, now = new Date()): Row {
  const n = name.trim();
  const key = n.toLowerCase();
  const found = project.people.find((p) => String(p.display_name).toLowerCase() === key || (p.aliases ?? []).some((a: string) => a.toLowerCase() === key));
  if (found) return found;
  const person = { id: uuid(), group_id: project.group.id, display_name: n, aliases: [], notes: null, created_by: by, created_at: now.toISOString(), updated_at: now.toISOString() };
  project.people.push(person);
  return person;
}

export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Add a face box (fractions of image.jpg's size, top-left corner + size). */
export function addFace(doc: PhotoDoc, box: FaceBox, by: string, opts: { detector?: string; confidence?: number | null; now?: Date } = {}): Row {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const face = {
    id: uuid(),
    group_id: doc.photo.group_id,
    photo_id: doc.photo.id,
    image: "front",
    bbox_x: clamp(box.x),
    bbox_y: clamp(box.y),
    bbox_w: Math.max(0.001, Math.min(1 - clamp(box.x), box.w)),
    bbox_h: Math.max(0.001, Math.min(1 - clamp(box.y), box.h)),
    detector: opts.detector ?? "manual",
    detector_confidence: opts.confidence ?? null,
    person_id: null,
    tag_certainty: null,
    tagged_by: null,
    tagged_at: null,
    dismissed: false,
    created_by: by,
    created_at: (opts.now ?? new Date()).toISOString(),
  };
  doc.faces.push(face);
  return face;
}

/** Name a face (or clear its name with null), keeping people_in_photo in step. */
export function tagFace(doc: PhotoDoc, faceId: string, personId: string | null, by: string, opts: { certainty?: Certainty | null; now?: Date } = {}) {
  const now = (opts.now ?? new Date()).toISOString();
  const face = doc.faces.find((f) => f.id === faceId);
  if (!face) throw new Error(`no face ${faceId}`);
  if (face.person_id === personId) return;
  doc.face_tag_history.push({ id: uuid(), group_id: doc.photo.group_id, face_id: faceId, old_person_id: face.person_id, new_person_id: personId, old_certainty: face.tag_certainty, new_certainty: opts.certainty ?? null, changed_by: by, changed_at: now, source: "person" });
  const old = face.person_id;
  face.person_id = personId;
  face.tag_certainty = opts.certainty ?? null;
  face.tagged_by = by;
  face.tagged_at = now;
  if (old && !doc.faces.some((f) => f.person_id === old && !f.dismissed)) {
    for (const pp of doc.people_in_photo) if (pp.person_id === old && !pp.removed_at) Object.assign(pp, { removed_by: by, removed_at: now });
  }
  if (personId && !doc.people_in_photo.some((pp) => pp.person_id === personId && !pp.removed_at)) {
    doc.people_in_photo.push({ id: uuid(), group_id: doc.photo.group_id, photo_id: doc.photo.id, person_id: personId, face_id: faceId, certainty: opts.certainty ?? null, source: "person", added_by: by, added_at: now, removed_by: null, removed_at: null });
  }
}

/** A false box is dismissed, never deleted, as in the shared online app. */
export function dismissFace(doc: PhotoDoc, faceId: string, by: string, now = new Date()) {
  const face = doc.faces.find((f) => f.id === faceId);
  if (!face) return;
  if (face.person_id) tagFace(doc, faceId, null, by, { now });
  face.dismissed = true;
}

export interface StoryInput {
  /** The raw transcript, exactly as recognized. */
  transcript?: string | null;
  transcriptModel?: string | null;
  /** The cleaned, reviewed story. */
  storyText?: string | null;
  cleanup?: { method: "none" | "local" | "anthropic" | "openai" | string; model?: string | null } | null;
  typedText?: string | null;
  prompt?: string;
}

/**
 * Set the photo's main story (the first "story" contribution), keeping the
 * previous wording in contribution_versions whenever it changes.
 */
export function setStory(doc: PhotoDoc, input: StoryInput, by: string, now = new Date()): Row {
  const at = now.toISOString();
  let c = doc.contributions.find((x) => x.kind === "story" && !x.parent_id && !x.deleted_at);
  if (!c) {
    c = {
      id: uuid(), group_id: doc.photo.group_id, photo_id: doc.photo.id, contributor_id: by, kind: "story", parent_id: null,
      prompt_text: input.prompt ?? "Tell the story of this photo.", audio_path: null, audio_original_mime: null, audio_sha256: null,
      audio_duration_s: null, audio_archive_path: null, transcript: null, transcript_model: null, transcript_edited_text: null,
      typed_text: null, story_text: null, story_cleanup: null, client_created_at: at, created_at: at, updated_at: at, deleted_at: null,
    };
    doc.contributions.push(c);
  } else {
    const changed =
      (input.transcript !== undefined && input.transcript !== c.transcript) ||
      (input.storyText !== undefined && input.storyText !== c.story_text) ||
      (input.typedText !== undefined && input.typedText !== c.typed_text);
    if (changed) {
      const { id: _id, ...snapshot } = c;
      doc.contribution_versions.push({ id: uuid(), group_id: doc.photo.group_id, contribution_id: c.id, snapshot, replaced_by: by, replaced_at: at });
    }
  }
  if (input.transcript !== undefined) c.transcript = input.transcript;
  if (input.transcriptModel !== undefined) c.transcript_model = input.transcriptModel;
  if (input.storyText !== undefined) c.story_text = input.storyText;
  if (input.cleanup !== undefined) c.story_cleanup = input.cleanup;
  if (input.typedText !== undefined) c.typed_text = input.typedText;
  c.updated_at = at;
  return c;
}

/** Record an edit step (crop, rotate, ...) in the photo's edit history summary. */
export function recordEdit(doc: PhotoDoc, action: string, params?: Row, now = new Date()) {
  (doc.edits ??= []).push({ at: now.toISOString(), action, ...(params ? { params } : {}) });
  if (action === "crop") doc.photo.crop_params = params ?? null;
  if (action === "reset") doc.photo.crop_params = null;
}

/** Does this photo have a saved story or title? (Photos without one are left out of exports by default.) */
export const hasStory = (doc: PhotoDoc) =>
  doc.contributions.some((c) => !c.deleted_at && (c.story_text || c.transcript || c.transcript_edited_text || c.typed_text)) || !!doc.details?.caption;
