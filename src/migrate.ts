// Schema migration. Reads an older sidecar and adds the new fields without
// losing or changing anything already there. Runs automatically on import,
// and can be run on a project folder or an export bundle (backed up first).

import { copyTree, join, readJson, writeText, type FileAdapter } from "./adapter.ts";
import { checkBag, finishBag, readBagInfo } from "./bagit.ts";
import { contextFrom, dublinCore, type DcContext } from "./dublin-core.ts";
import { loadProject, listPhotoIds } from "./project.ts";
import { compareVersions, SCHEMA_VERSION, type PhotoDoc } from "./schema.ts";
import { canonicalJson, type Row } from "./util.ts";

export interface MigrateResult {
  doc: PhotoDoc;
  from: string;
  changed: boolean;
  /** Set when the sidecar is newer than this library understands; it is left as it is. */
  newer?: boolean;
}

/** Upgrade one sidecar in memory. */
export function migratePhotoDoc(input: PhotoDoc, ctx: DcContext): MigrateResult {
  const from = String(input.schema_version ?? "1");
  if (compareVersions(from, SCHEMA_VERSION) > 0) return { doc: input, from, changed: false, newer: true };
  if (from === SCHEMA_VERSION) return { doc: input, from, changed: false };
  const doc = structuredClone(input);
  // 1 -> 2: Dublin Core mapping, provenance, edit history summary.
  if (compareVersions(from, "2") < 0) {
    doc.files ??= {};
    doc.files.audio ??= {};
    doc.provenance ??= doc.photo.original_filename ? { source_filename: String(doc.photo.original_filename) } : {};
    doc.edits ??= doc.photo.crop_params ? [{ at: String(doc.photo.created_at ?? ""), action: "crop", params: doc.photo.crop_params as Row }] : [];
    doc.schema_version = "2";
    doc.dublin_core = dublinCore(doc, ctx);
  }
  return { doc, from, changed: true };
}

export interface FolderMigration {
  migrated: number;
  unchanged: number;
  newer: string[];
  backup: string | null;
}

/** Upgrade every sidecar in a project folder (or a bundle's data/ folder) in place. */
export async function migrateFolder(fs: FileAdapter, root: string, opts: { backupTo?: string | null } = {}): Promise<FolderMigration> {
  const project = await loadProject(fs, root);
  const ctx = contextFrom(project.group, project.people, project.contributors);
  const ids = await listPhotoIds(fs, root);
  const plans: { id: string; r: MigrateResult }[] = [];
  for (const id of ids) plans.push({ id, r: migratePhotoDoc(await readJson<PhotoDoc>(fs, join(root, "photos", id, "photo.json")), ctx) });
  const out: FolderMigration = { migrated: 0, unchanged: 0, newer: plans.filter((p) => p.r.newer).map((p) => p.id), backup: null };
  if (!plans.some((p) => p.r.changed)) {
    out.unchanged = plans.length;
    return out;
  }
  if (opts.backupTo !== null) {
    out.backup = opts.backupTo ?? `${root}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyTree(fs, root, out.backup);
  }
  for (const { id, r } of plans) {
    if (!r.changed) {
      out.unchanged++;
      continue;
    }
    await writeText(fs, join(root, "photos", id, "photo.json"), canonicalJson(r.doc));
    out.migrated++;
  }
  if (await fs.exists(join(root, "manifest.json"))) {
    const m = await readJson<Row>(fs, join(root, "manifest.json"));
    if (compareVersions(String(m.schema_version ?? "1"), SCHEMA_VERSION) < 0) {
      m.migrated_from_schema_version = m.schema_version ?? "1";
      m.schema_version = SCHEMA_VERSION;
      await writeText(fs, join(root, "manifest.json"), canonicalJson(m));
    }
  }
  return out;
}

/**
 * Upgrade an unzipped bundle in place: back it up, migrate data/, regenerate
 * the viewer and the BagIt manifests and checksums, then validate.
 */
export async function migrateBag(fs: FileAdapter, bag: string, opts: { backupTo?: string | null } = {}): Promise<FolderMigration & { problems: string[] }> {
  const before = await checkBag(fs, bag);
  if (before.problems.length) throw new Error(`the bundle failed validation, so it was left as it is:\n  ${before.problems.join("\n  ")}`);
  let backup: string | null = null;
  if (opts.backupTo !== null) {
    backup = opts.backupTo ?? `${bag}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await copyTree(fs, bag, backup);
  }
  const r = await migrateFolder(fs, join(bag, "data"), { backupTo: null });
  if (!r.migrated) return { ...r, backup, problems: [] };
  const { VIEWER_FILE, writeViewer } = await import("./viewer.ts");
  await writeViewer(fs, bag);
  const { "Payload-Oxum": _o, ...info } = await readBagInfo(fs, bag);
  await finishBag(fs, bag, info, [VIEWER_FILE]);
  const after = await checkBag(fs, bag);
  return { ...r, backup, problems: after.problems };
}
