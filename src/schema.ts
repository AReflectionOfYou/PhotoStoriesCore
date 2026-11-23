// The package format. A project folder (on a computer) and the data/ folder of
// an export bundle have the same layout, so a bundle can be read like a project:
//
//   group.json         the project ("group" in the shared online app)
//   contributors.json  who told the stories
//   people.json        everyone named in the photos, with aliases
//   collections.json   how photos are grouped (albums, boxes)
//   events.json        occasions within collections
//   consent.json       consent statements (empty for a personal desktop project)
//   usage.json         AI services used (may be empty)
//   photos/<id>/photo.json   the sidecar: everything about one photo
//   photos/<id>/original.*   the photo exactly as copied in, never changed
//   photos/<id>/image.jpg    the edited copy (crop, rotate, cleanup), with XMP
//   photos/<id>/thumb.jpg    a small preview (schema 2)
//   photos/<id>/audio/...    recordings, when kept
//
// Schema version 1 is the shared online app's bundle (family-photo-stories-worker
// 1.0.0). Version 2 adds fields; it never renames or removes any.

import type { Row } from "./util.ts";

export const SCHEMA_VERSION = "2";
export const KNOWN_SCHEMA_VERSIONS = ["1", "2"] as const;
export const LIBRARY = { name: "photostories-core", version: "0.1.1" };

/** Data files at the top of a project or bundle payload. */
export const TOP_FILES = ["group.json", "contributors.json", "people.json", "collections.json", "events.json", "consent.json", "usage.json"] as const;

export type Certainty = "sure" | "likely" | "guess";

export interface DublinCore {
  title?: string;
  description?: string;
  subject?: string[];
  creator?: string[];
  contributor?: string[];
  coverage?: string;
  date?: string;
  source?: string;
  rights?: string;
  type?: string;
  format?: string;
  identifier?: string;
}

/** Where the copy came from (schema 2). For provenance only. */
export interface Provenance {
  source_filename?: string;
  source_path?: string;
  copied_at?: string;
  copy_size?: "full" | "resized";
  max_long_edge?: number | null;
  app?: { name: string; version: string };
}

/** One step in the edit history summary (schema 2). */
export interface EditStep {
  at: string;
  action: "crop" | "rotate" | "brightness" | "contrast" | "auto_enhance" | "reset" | string;
  params?: Row;
}

export interface PhotoDoc {
  schema_version: string;
  photo: Row;
  details: Row | null;
  people_in_photo: Row[];
  faces: Row[];
  face_tag_history: Row[];
  field_history: Row[];
  contributions: Row[];
  contribution_versions: Row[];
  ai_extractions: Row[];
  extraction_reviews: Row[];
  files: { original?: string; image?: string; thumb?: string; back_original?: string; back_image?: string; audio?: Record<string, Row>; [k: string]: unknown };
  // Schema 2:
  provenance?: Provenance;
  edits?: EditStep[];
  dublin_core?: DublinCore;
  [k: string]: unknown;
}

export const emptyPhotoDoc = (photo: Row): PhotoDoc => ({
  schema_version: SCHEMA_VERSION,
  photo,
  details: null,
  people_in_photo: [],
  faces: [],
  face_tag_history: [],
  field_history: [],
  contributions: [],
  contribution_versions: [],
  ai_extractions: [],
  extraction_reviews: [],
  files: { audio: {} },
});

/** Compare schema versions numerically: <0 older, 0 same, >0 newer. */
export const compareVersions = (a: string, b: string) => Number(a) - Number(b);

/** The words a story shows: the cleaned story, else the speaker's corrections, else the raw transcript. */
export const storyWords = (c: Row): string => c.story_text ?? c.transcript_edited_text ?? c.transcript ?? "";
