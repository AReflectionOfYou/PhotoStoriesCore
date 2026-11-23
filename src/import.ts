// Import: bring photo story bundles (from any version of Photo Stories) into a
// project. Two steps, so nothing is written until the person confirms:
//
//   const plan = await planImport(fs, "Downloads/old.zip", project)   // validate, read, compare
//   ... show plan.preview, ask about duplicates and near-match names ...
//   const summary = await commitImport(fs, plan, decisions)           // write
//   await discardImport(fs, plan)                                     // or cancel
//
// The source zip or folder is never modified.

import { basename, copyFile, join, readJson, walk, type FileAdapter } from "./adapter.ts";
import { checkBag } from "./bagit.ts";
import { contextFrom, dublinCore } from "./dublin-core.ts";
import { migratePhotoDoc } from "./migrate.ts";
import { reviewNames, type NameReview } from "./names.ts";
import { checksums, loadProject, photoDir, saveProject, writePhoto, type ProjectData } from "./project.ts";
import { compareVersions, SCHEMA_VERSION, type PhotoDoc } from "./schema.ts";
import { sha256File, uuid, type Row } from "./util.ts";
import { findBag, unzipTo } from "./zip.ts";

export type DuplicateChoice = "skip" | "replace" | "keepBoth";

export interface IncomingPhoto {
  id: string;
  title: string;
  sha256: string;
  status: "new" | "duplicate" | "damaged";
  /** For duplicates: the project photo with the same checksum. */
  duplicateOf?: string;
  /** The sidecar's schema version, as found. */
  schemaVersion: string;
  newerSchema: boolean;
  damagedFiles: string[];
  doc: PhotoDoc;
}

export interface ImportPlan {
  projectRoot: string;
  source: string;
  /** Where the bundle was unzipped (removed by commit or discard), or null if it was a folder. */
  workDir: string | null;
  bag: string;
  /** Checksum problems found. If any, the person chooses to cancel or continue with the valid files only. */
  problems: string[];
  photos: IncomingPhoto[];
  names: NameReview[];
  incoming: { group: Row; contributors: Row[]; people: Row[]; collections: Row[]; events: Row[] };
  preview: {
    photos: number;
    new: number;
    duplicates: number;
    damaged: number;
    newNames: number;
    namesToReview: number;
    sameNames: number;
    newerSchema: number;
    olderSchema: number;
  };
}

/** Validate and read a bundle (a .zip or an unzipped bag folder), and compare it with the project. Writes nothing to the project. */
export async function planImport(fs: FileAdapter, source: string, projectRoot: string, opts: { workDir?: string } = {}): Promise<ImportPlan> {
  let workDir: string | null = null;
  let bag: string;
  if (/\.zip$/i.test(source) && !(await isDir(fs, source))) {
    workDir = opts.workDir ?? join(projectRoot, ".photostories", `import-${Date.now()}`);
    await fs.mkdir(workDir);
    await unzipTo(fs, source, workDir);
    bag = await findBag(fs, workDir);
  } else {
    bag = await findBag(fs, source);
  }
  const { problems, badFiles } = await checkBag(fs, bag);
  const data = join(bag, "data");
  const opt = async (p: string, fallback: unknown) => ((await fs.exists(join(data, p))) ? readJson(fs, join(data, p)) : fallback) as Promise<any>;
  const incoming = {
    group: await opt("group.json", {}),
    contributors: await opt("contributors.json", []),
    people: await opt("people.json", []),
    collections: await opt("collections.json", []),
    events: await opt("events.json", []),
  };
  const ctx = contextFrom(incoming.group, incoming.people, incoming.contributors);
  const project = await loadProject(fs, projectRoot);
  const existing = await checksums(fs, projectRoot);

  const photos: IncomingPhoto[] = [];
  const dirs = (await fs.exists(join(data, "photos"))) ? (await fs.list(join(data, "photos"))).filter((e) => e.isDirectory).map((e) => e.name).sort() : [];
  for (const id of dirs) {
    const dir = join(data, "photos", id);
    const rel = (f: string) => f.slice(bag.length + 1);
    const damagedFiles = (await walk(fs, dir)).map(rel).filter((f) => badFiles.has(f));
    let raw: PhotoDoc | null = null;
    try {
      raw = await readJson<PhotoDoc>(fs, join(dir, "photo.json"));
    } catch {
      damagedFiles.push(`data/photos/${id}/photo.json`);
    }
    if (!raw) continue;
    const m = migratePhotoDoc(raw, ctx);
    const originalFile = m.doc.files?.original ? join(dir, String(m.doc.files.original)) : null;
    const sha = String(m.doc.photo.original_sha256 ?? (originalFile && (await fs.exists(originalFile)) ? await sha256File(fs, originalFile) : ""));
    const dup = existing.get(sha);
    photos.push({
      id,
      title: String(m.doc.details?.caption ?? m.doc.photo.original_filename ?? id),
      sha256: sha,
      status: damagedFiles.length ? "damaged" : dup ? "duplicate" : "new",
      duplicateOf: dup,
      schemaVersion: m.from,
      newerSchema: !!m.newer,
      damagedFiles: [...new Set(damagedFiles)],
      doc: m.doc,
    });
  }

  // Only people who appear in the imported photos, or who were in the bundle's list.
  const names = reviewNames(incoming.people, project.people);
  return {
    projectRoot,
    source,
    workDir,
    bag,
    problems,
    photos,
    names,
    incoming,
    preview: {
      photos: photos.length,
      new: photos.filter((p) => p.status === "new").length,
      duplicates: photos.filter((p) => p.status === "duplicate").length,
      damaged: photos.filter((p) => p.status === "damaged").length,
      newNames: names.filter((n) => n.status === "new").length,
      namesToReview: names.filter((n) => n.status === "review").length,
      sameNames: names.filter((n) => n.status === "same").length,
      newerSchema: photos.filter((p) => p.newerSchema).length,
      olderSchema: photos.filter((p) => compareVersions(p.schemaVersion, SCHEMA_VERSION) < 0).length,
    },
  };
}

async function isDir(fs: FileAdapter, p: string) {
  try {
    await fs.list(p);
    return true;
  } catch {
    return false;
  }
}

export interface ImportDecisions {
  /** Per incoming photo id; falls back to `allDuplicates`, then "skip". */
  duplicates?: Record<string, DuplicateChoice>;
  allDuplicates?: DuplicateChoice;
  /** Per incoming person id (for names to review): an existing person id to merge into, or "separate". Unanswered names stay separate. */
  names?: Record<string, string>;
  /** Import photos whose files failed their checksums anyway (default false: only valid files). */
  includeDamaged?: boolean;
  /** Who is importing (recorded as the changer in history). Default: the project owner. */
  by?: string;
}

export interface ImportSummary {
  added: string[];
  skipped: string[];
  replaced: string[];
  keptBoth: string[];
  damagedSkipped: string[];
  peopleAdded: string[];
  peopleMerged: { from: string; into: string }[];
  newerSchema: string[];
}

/** Write the import into the project, as decided. */
export async function commitImport(fs: FileAdapter, plan: ImportPlan, decisions: ImportDecisions = {}): Promise<ImportSummary> {
  const root = plan.projectRoot;
  const project = await loadProject(fs, root);
  const groupId = String(project.group.id);
  const summary: ImportSummary = { added: [], skipped: [], replaced: [], keptBoth: [], damagedSkipped: [], peopleAdded: [], peopleMerged: [], newerSchema: [] };

  // People: same -> existing; review -> as decided; new -> added.
  const personMap = new Map<string, string>();
  for (const n of plan.names) {
    const inc = n.incoming;
    let target: Row | undefined;
    if (n.status === "same") target = n.matches[0].person;
    else if (n.status === "review") {
      const choice = decisions.names?.[inc.id];
      if (choice && choice !== "separate") target = project.people.find((p) => p.id === choice);
    }
    if (target) {
      personMap.set(String(inc.id), String(target.id));
      const live = project.people.find((p) => p.id === target!.id)!;
      const aliases = new Set<string>(live.aliases ?? []);
      for (const a of [inc.display_name, ...(inc.aliases ?? [])]) if (a && a !== live.display_name) aliases.add(String(a));
      live.aliases = [...aliases];
      if (inc.display_name !== live.display_name) summary.peopleMerged.push({ from: String(inc.display_name), into: String(live.display_name) });
    } else {
      const id = project.people.some((p) => p.id === inc.id) ? uuid() : String(inc.id);
      personMap.set(String(inc.id), id);
      project.people.push({ ...inc, id, group_id: groupId });
      summary.peopleAdded.push(String(inc.display_name));
    }
  }
  // Contributors, collections and events: add the ones the project doesn't have (by id).
  const addMissing = (list: Row[], rows: Row[]) => {
    for (const r of rows) if (!list.some((x) => x.id === r.id)) list.push({ ...r, group_id: groupId });
  };
  addMissing(project.contributors, plan.incoming.contributors.map(({ auth_user_id: _a, ...c }) => c));
  addMissing(project.collections, plan.incoming.collections);
  addMissing(project.events, plan.incoming.events);

  const existingIds = new Set((await fs.exists(join(root, "photos"))) ? (await fs.list(join(root, "photos"))).map((e) => e.name) : []);
  const data = join(plan.bag, "data");
  for (const p of plan.photos) {
    if (p.newerSchema) summary.newerSchema.push(p.id);
    if (p.status === "damaged" && !decisions.includeDamaged) {
      summary.damagedSkipped.push(p.id);
      continue;
    }
    let targetId = p.id;
    if (p.status === "duplicate") {
      const choice = decisions.duplicates?.[p.id] ?? decisions.allDuplicates ?? "skip";
      if (choice === "skip") {
        summary.skipped.push(p.id);
        continue;
      }
      if (choice === "replace") {
        await fs.remove(photoDir(root, p.duplicateOf!));
        existingIds.delete(p.duplicateOf!);
        summary.replaced.push(p.id);
      } else summary.keptBoth.push(p.id);
    }
    if (existingIds.has(targetId)) targetId = uuid();
    const doc = remap(p.doc, { photoId: targetId, groupId, people: personMap });
    pinAuthorship(doc, project);
    const src = join(data, "photos", p.id);
    for (const f of await walk(fs, src)) {
      if (basename(f) === "photo.json") continue;
      await copyFile(fs, f, join(photoDir(root, targetId), f.slice(src.length + 1)));
    }
    await writePhoto(fs, root, doc, project);
    existingIds.add(targetId);
    if (p.status !== "duplicate") summary.added.push(targetId);
  }
  await saveProject(fs, root, project, ["people", "contributors", "collections", "events"]);
  await discardImport(fs, plan);
  return summary;
}

/** Remove the unzipped working copy (the source itself is never touched). */
export async function discardImport(fs: FileAdapter, plan: ImportPlan): Promise<void> {
  if (plan.workDir) await fs.remove(plan.workDir);
}

/** Keep the creator and rights the photo had in its own project, when they differ from this project's. */
function pinAuthorship(doc: PhotoDoc, project: ProjectData) {
  const dc = doc.dublin_core;
  if (!dc) return;
  const mine = contextFrom(project.group, project.people, project.contributors);
  const ours = dublinCore(doc, mine);
  const f: Row = (doc.details ??= { photo_id: doc.photo.id, group_id: doc.photo.group_id });
  if (dc.rights && dc.rights !== ours.rights && !f.rights) f.rights = dc.rights;
  if (dc.creator?.length && JSON.stringify(dc.creator) !== JSON.stringify(ours.creator ?? []) && !f.creator) f.creator = dc.creator;
}

/** Give a sidecar a new photo id and group id, and map its people to the project's. */
function remap(input: PhotoDoc, m: { photoId: string; groupId: string; people: Map<string, string> }): PhotoDoc {
  const oldId = String(input.photo.id);
  const walkRow = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walkRow(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, walkRow(x, k)]));
    if (typeof v !== "string") return v;
    if (key === "group_id") return m.groupId;
    if (key === "photo_id" && v === oldId) return m.photoId;
    if ((key === "person_id" || key === "old_person_id" || key === "new_person_id") && m.people.has(v)) return m.people.get(v);
    return v;
  };
  const doc = walkRow(input) as PhotoDoc;
  if (oldId !== m.photoId) {
    doc.photo.id = m.photoId;
    for (const k of ["original_path", "derived_path", "back_original_path", "back_derived_path"]) {
      if (typeof doc.photo[k] === "string") doc.photo[k] = doc.photo[k].split(oldId).join(m.photoId);
    }
    if (doc.dublin_core) doc.dublin_core.identifier = m.photoId;
  }
  return doc;
}

export type { ProjectData };
