# Photo Stories Core

The shared library behind every version of Photo Stories: the sidecar schema, the Dublin Core mapping, schema versioning and migration, BagIt export and import with checksum validation, duplicate detection, people-name merging, embedded photo metadata, and the offline HTML viewer that ships inside every export.

Every app reads and writes packages through this code, so output from the desktop app, the mobile app and the shared online collection is interchangeable, and a fix lands everywhere at once.

Part of the [A Reflection of You](https://github.com/AReflectionOfYou) collection, with [PhotoStoriesDesktop](https://github.com/AReflectionOfYou/PhotoStoriesDesktop) and the mobile app.

## Status

Version 0.1.1. Schema version 2. Tested in Node; used by PhotoStoriesDesktop.

## What's inside

| Module | What it does |
|---|---|
| `adapter.ts` | The `FileAdapter` interface (file access is passed in), plus an in-memory adapter. `photostories-core/node` has a Node adapter; the desktop app supplies a Tauri one. |
| `schema.ts` | The package layout and sidecar (`photo.json`) types. The language-neutral [JSON Schema](schema/photo.schema.json) is in `schema/`. |
| `project.ts` | Create a project, copy photos in (never touching the originals), and edit details, faces and stories with full history. |
| `dublin-core.ts` | The Dublin Core mapping stored in every sidecar. |
| `migrate.ts` | Upgrade older sidecars, projects and bundles; backs up first and re-checksums bundles. |
| `export.ts` | One validated BagIt zip with photos, sidecars, thumbnails, a readme and `START HERE.html`. |
| `import.ts` | Validate a bundle, preview what's new, duplicate or damaged, review near-match names, then commit. |
| `names.ts` | Name matching: exact matches merge; near-matches (Bob/Robert, Kathryn/Katheryn, Rose/Grandma Rose) are flagged. |
| `metadata.ts` | Read EXIF, IPTC and XMP from a JPEG; fill only what's missing and flag what differs; write XMP. No dependencies. |
| `viewer.ts` | `START HERE.html`: a self-contained page that opens by double-click, offline. |
| `bagit.ts`, `zip.ts` | BagIt 1.0 (RFC 8493) writing and validation; zipping. |

## The package format

A project folder and the `data/` folder of an export bundle have the same layout:

```
group.json  contributors.json  people.json  collections.json  events.json  consent.json  usage.json
photos/<id>/photo.json     the sidecar: everything about one photo
photos/<id>/original.*     the photo exactly as copied in, never changed
photos/<id>/image.jpg      the edited working copy, with XMP
photos/<id>/thumb.jpg      a small preview
```

An export bundle wraps that in a BagIt bag:

```
<name>_<date>/
  bagit.txt  bag-info.txt  manifest-sha256.txt  tagmanifest-sha256.txt
  START HERE.html
  data/  (as above, plus manifest.json and README.md)
```

**Schema versions.** Version 1 is the shared online app's bundle format (`family-photo-stories-worker` 1.0.0), the baseline everything conforms to. Version 2 adds `dublin_core`, `provenance`, `edits`, `files.thumb`, `details.notes`/`latitude`/`longitude`, and `story_text`/`story_cleanup` on stories. Field names are stable; later versions add fields and never rename or remove them. Older sidecars are upgraded on import; newer ones are flagged and read as far as possible. See [docs/schema.md](docs/schema.md) for every field.

**Dublin Core.** title → `dc:title`, story → `dc:description`, people in the photo → `dc:subject`, storytellers → `dc:contributor`, project owner → `dc:creator` (or `dc:contributor`, by setting), place → `dc:coverage`, date → `dc:date`, original file name → `dc:source`, license → `dc:rights`.

## Using it

```ts
import { createProject, addPhoto, setDetails, setStory, writePhoto, exportBundle, planImport, commitImport } from "photostories-core";
import { NodeAdapter } from "photostories-core/node";

const fs = new NodeAdapter("/");
const project = await createProject(fs, "/path/to/project", { name: "Rose's photos", ownerName: "Rose", rights: "CC BY 4.0" });
const { doc } = await addPhoto(fs, "/path/to/project", project, { sourcePath: "/path/to/IMG_0412.jpg" });
setDetails(doc, { caption: "The red house", date_text: "summer of 1965", date_edtf: "1965-22" }, project.group.owner_contributor_id);
setStory(doc, { transcript: "um this is the house", storyText: "This is the house.", cleanup: { method: "local" } }, project.group.owner_contributor_id);
await writePhoto(fs, "/path/to/project", doc, project);

const { zipPath, problems } = await exportBundle(fs, "/path/to/project", "/path/to/exports");

const plan = await planImport(fs, "/path/to/old-bundle.zip", "/path/to/project");
// show plan.preview, plan.problems, plan.photos (new / duplicate / damaged), plan.names (same / new / review)
const summary = await commitImport(fs, plan, { allDuplicates: "skip", names: { /* incoming person id -> existing id */ } });
```

To use it from an app, pin a version: `"photostories-core": "github:AReflectionOfYou/PhotoStoriesCore#v0.1.1"`. The library and the schema have separate version numbers (`LIBRARY.version`, `SCHEMA_VERSION`); apps upgrade deliberately.

## Development

```sh
npm install
npm test          # the shared conformance suite
npm run typecheck
npm run samples   # rebuild samples/*.zip
```

`samples/` holds generated placeholder images and two sample packages: `sample-desktop-v2.zip` (schema 2) and `sample-online-v1.zip` (schema 1, as the shared online app writes it). Both validate with the Library of Congress `bagit.py`. The tests include round trips (export, import, export again, compare), duplicate handling, name merging, damaged bundles, migration and JSON Schema conformance.

## License

Code is under the [MIT License](LICENSE). Documents, written content, images, audio, and video are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); see [LICENSE-CONTENT](LICENSE-CONTENT). © 2026 Michael A. Heroux.

## Image policy

No photos or likenesses of any real person, living or dead, appear in this repo or on anything built from it. All images are created together with Claude, so Michael A. Heroux owns them and they are licensed CC BY 4.0. The only exception is Michael himself: his standard professional portrait and an occasional informal photo. Any other exception needs Michael's explicit approval for that specific case. Future contributors, including AI coding sessions, must follow this policy. Photos that people capture with the apps stay in their own storage and are not part of this repo.
