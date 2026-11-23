// Export: one validated BagIt zip holding the photos, their sidecars,
// thumbnails, a readme, and the START HERE.html viewer. The payload layout is
// the same as the shared online app's bundle, so all versions interchange.

import { copyTree, join, readJson, writeText, type FileAdapter } from "./adapter.ts";
import { checkBag, finishBag } from "./bagit.ts";
import { contextFrom, dublinCore } from "./dublin-core.ts";
import { migratePhotoDoc } from "./migrate.ts";
import { hasStory, listPhotoIds, loadProject, readPhoto } from "./project.ts";
import { compareVersions, LIBRARY, SCHEMA_VERSION, TOP_FILES, type PhotoDoc } from "./schema.ts";
import { canonicalJson, slugPart, sortRows } from "./util.ts";
import { VIEWER_FILE, writeViewer } from "./viewer.ts";
import { zipDir } from "./zip.ts";


export interface ExportOptions {
  /** Only these photos. Default: every photo with a saved story or title. */
  photoIds?: string[];
  /** Also include photos with no saved story (ignored when photoIds is given). */
  includeWithoutStory?: boolean;
  /** The app making the bundle, for bag-info.txt and manifest.json. */
  generator?: { name: string; version: string };
  /** Keep the unzipped bag folder beside the zip (default: remove it). */
  keepFolder?: boolean;
  now?: Date;
}

export interface ExportResult {
  bagName: string;
  bagDir: string;
  zipPath: string;
  counts: Record<string, number>;
  /** Validation problems; empty means the bag validated. */
  problems: string[];
}

const humanSize = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export async function exportBundle(fs: FileAdapter, projectRoot: string, outDir: string, opts: ExportOptions = {}): Promise<ExportResult> {
  const now = opts.now ?? new Date();
  const generator = opts.generator ?? LIBRARY;
  const project = await loadProject(fs, projectRoot);
  const ctx = contextFrom(project.group, project.people, project.contributors);

  const all = await listPhotoIds(fs, projectRoot);
  const docs: PhotoDoc[] = [];
  for (const id of opts.photoIds ?? all) {
    if (!all.includes(id)) throw new Error(`no photo ${id} in the project`);
    const doc = migratePhotoDoc(await readPhoto(fs, projectRoot, id), ctx).doc;
    if (opts.photoIds || opts.includeWithoutStory || hasStory(doc)) docs.push(doc);
  }
  if (!docs.length) throw new Error("there are no photos with a saved story to export yet");
  const selection = docs.length < all.length;

  const date = now.toISOString().slice(0, 10);
  // "_archive" keeps the unzipped folder's name distinct from the project folder it came from.
  let bagName = `${project.group.slug || slugPart(String(project.group.name)) || "photo-stories"}_${date}${selection ? `_${docs.length}-photos` : ""}_archive`;
  await fs.mkdir(outDir);
  for (let n = 2; (await fs.exists(join(outDir, bagName))) || (await fs.exists(join(outDir, `${bagName}.zip`))); n++) bagName = `${bagName.replace(/-\d+$/, "")}-${n}`;
  const bag = join(outDir, bagName);
  const data = join(bag, "data");
  await fs.mkdir(join(data, "photos"));

  for (const f of TOP_FILES) {
    const src = join(projectRoot, f);
    const v = (await fs.exists(src)) ? await readJson(fs, src) : f === "group.json" ? {} : [];
    await writeText(fs, join(data, f), canonicalJson(Array.isArray(v) ? sortRows(v) : v));
  }

  let recordings = 0;
  let faces = 0;
  for (const doc of docs) {
    const id = String(doc.photo.id);
    await copyTree(fs, join(projectRoot, "photos", id), join(data, "photos", id));
    if (compareVersions(String(doc.schema_version ?? "1"), SCHEMA_VERSION) < 0) doc.schema_version = SCHEMA_VERSION;
    doc.dublin_core = dublinCore(doc, ctx);
    await writeText(fs, join(data, "photos", id, "photo.json"), canonicalJson(doc));
    recordings += Object.keys(doc.files.audio ?? {}).length;
    faces += doc.faces.filter((x) => !x.dismissed).length;
  }

  const counts = {
    photos: docs.length,
    contributions: docs.reduce((n, d) => n + d.contributions.filter((c) => !c.deleted_at).length, 0),
    recordings,
    people: project.people.length,
    faces,
    collections: project.collections.length,
  };
  const about = selection ? `${docs.length} chosen photos` : "the whole project";
  await writeText(fs, join(data, "manifest.json"), canonicalJson({
    schema_version: SCHEMA_VERSION,
    generator,
    library: LIBRARY,
    scope: selection ? { kind: "selection", photo_ids: docs.map((d) => String(d.photo.id)) } : { kind: "group" },
    contents: about,
    counts,
    include_removed: false,
    exported_at: now.toISOString(),
  }));
  await writeText(fs, join(data, "README.md"), readme(String(project.group.name), about, counts));
  await writeViewer(fs, bag);

  const owner = String(project.group.owner_name ?? project.group.name);
  const info: Record<string, string> = {
    "Source-Organization": owner,
    ...(project.group.owner_name ? { "Contact-Name": owner } : {}),
    ...(project.group.owner_contact ? { "Contact-Email": String(project.group.owner_contact) } : {}),
    "Bagging-Date": date,
    "External-Description": `Photo Stories archive for ${project.group.name}: ${counts.photos} photos with their stories, the people in them, and everything recorded about them.`,
    "Bag-Software-Agent": `${generator.name} ${generator.version} (${LIBRARY.name} ${LIBRARY.version})`,
    "Bag-Group-Identifier": String(project.group.slug ?? ""),
    "Photo-Count": String(counts.photos),
  };
  const { bytes } = await finishBag(fs, bag, { ...info, "Bag-Size": "pending" }, [VIEWER_FILE]);
  // Bag-Size needs the payload size, known only after the first pass.
  await finishBag(fs, bag, { ...info, "Bag-Size": humanSize(bytes) }, [VIEWER_FILE]);

  const { problems } = await checkBag(fs, bag);
  const zipPath = join(outDir, `${bagName}.zip`);
  if (!problems.length) {
    await zipDir(fs, bag, zipPath);
    if (!opts.keepFolder) await fs.remove(bag);
  }
  return { bagName, bagDir: bag, zipPath, counts, problems };
}

function readme(name: string, what: string, counts: Record<string, number>): string {
  return `# ${name}: Photo Stories archive

This folder is a permanent, self-contained archive of ${what}: ${counts.photos} photos, ${counts.contributions} stories, and ${counts.people} people. It needs no app or website. Keep it somewhere safe and make copies.

## Start here

Double-click **START HERE.html** at the top of this folder (next to the \`data\` folder). It opens in your web browser and shows every photo with its story and details. It needs no internet. If the photos don't appear, make sure the archive was unzipped first (on Windows: right-click the .zip file and choose Extract All).

## Looking at the photos

Every photo has its own folder in \`data/photos/\`:

- \`original.*\`: the picture exactly as it was copied in, never changed.
- \`image.jpg\`: the cropped and cleaned-up picture. Its title, story, date, place and the names of the people in it are written inside the file, so most photo programs show them.
- \`thumb.jpg\`: a small preview.
- \`photo.json\`: everything recorded about the photo (see below).

## What's in the JSON files

The \`.json\` files are plain text, readable in any text editor.

- \`photo.json\`: the photo's title, date and place (each with how sure the teller was), the story in the teller's own words and the raw transcript, who is in the photo and where their faces are, notes, where the photo came from, what edits were made, the full history of every change, and a Dublin Core description (\`dublin_core\`) for libraries and archives.
- \`people.json\`: everyone named, with other names they go by.
- \`contributors.json\`: who told the stories.
- \`collections.json\`, \`events.json\`: how the photos were grouped.
- \`group.json\`: the project itself.
- \`manifest.json\`: what this archive covers, the schema version, and when it was made.

Everything is linked by ids (long codes such as \`3f2c…\`): for example, a face's \`person_id\` matches an \`id\` in \`people.json\`.

### Dates

Dates are kept as they were said (\`date_text\`) and in the Library of Congress Extended Date/Time Format (\`date_edtf\`): \`1965\` a year, \`1965-07\` a month, \`1965~\` about 1965, \`1965?\` maybe 1965, \`196X\` sometime in the 1960s, \`1965-22\` summer 1965.

### Face regions

\`faces\` in \`photo.json\` give each face's box as fractions of \`image.jpg\`'s width and height (\`bbox_x\`, \`bbox_y\` = top-left corner, \`bbox_w\`, \`bbox_h\` = size).

## Checking the archive is complete

This folder is a BagIt "bag" (a Library of Congress standard). \`manifest-sha256.txt\` lists a checksum for every file, so you can confirm nothing has been damaged or lost, for example with the Library of Congress \`bagit\` tool: \`bagit.py --validate <this folder>\`.

## Bringing it back to life

Any version of Photo Stories can import this archive to restore the collection, move it to a new computer, or combine it with another.
`;
}
