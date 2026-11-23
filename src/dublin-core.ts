// Dublin Core mapping (schema 2). Computed from the photo's own fields, so it
// can always be regenerated; it is stored in photo.json for other software.
//
//   title           -> dc:title        (details.caption)
//   story           -> dc:description  (the stories' words)
//   people in photo -> dc:subject
//   storytellers    -> dc:contributor
//   project owner   -> dc:creator or dc:contributor (group.owner_role)
//   place           -> dc:coverage
//   date            -> dc:date         (EDTF when known, else as said)
//   original file   -> dc:source
//   license         -> dc:rights       (group.rights)
//
// A photo imported from another project keeps that project's creator and
// rights, pinned in details.creator and details.rights.

import { storyWords, type DublinCore, type PhotoDoc } from "./schema.ts";
import { uniq, type Row } from "./util.ts";

export interface DcContext {
  group: Row;
  /** person id -> display name */
  personName: Map<string, string>;
  /** contributor id -> display name */
  contributorName: Map<string, string>;
}

export function contextFrom(group: Row, people: Row[], contributors: Row[]): DcContext {
  return {
    group,
    personName: new Map(people.map((p) => [String(p.id), String(p.display_name)])),
    contributorName: new Map(contributors.map((c) => [String(c.id), String(c.display_name)])),
  };
}

/** Names of the people in a photo: listed people plus named faces, in a stable order. */
export function peopleNames(doc: PhotoDoc, personName: Map<string, string>): string[] {
  const listed = (doc.people_in_photo ?? []).filter((x) => !x.removed_at).map((x) => personName.get(String(x.person_id)));
  const faces = (doc.faces ?? []).filter((x) => x.person_id && !x.dismissed).map((x) => personName.get(String(x.person_id)));
  return uniq([...listed, ...faces].filter(Boolean) as string[]);
}

export function dublinCore(doc: PhotoDoc, ctx: DcContext): DublinCore {
  const f = doc.details ?? {};
  const stories = (doc.contributions ?? []).filter((c) => !c.deleted_at);
  const description = stories.map((c) => storyWords(c) || c.typed_text || "").filter(Boolean).join("\n\n");
  const tellers = uniq(stories.map((c) => ctx.contributorName.get(String(c.contributor_id))).filter(Boolean) as string[]);
  // A photo imported from someone else's project keeps its own creator and rights (details.creator, details.rights).
  const pinned: string[] | null = Array.isArray(f.creator) ? f.creator : f.creator ? [String(f.creator)] : null;
  const owner = ctx.group.owner_name ? String(ctx.group.owner_name) : "";
  const ownerAsCreator = !pinned && owner && (ctx.group.owner_role ?? "creator") === "creator";
  const dc: DublinCore = {
    title: f.caption || undefined,
    description: description || undefined,
    subject: peopleNames(doc, ctx.personName),
    creator: pinned ?? (ownerAsCreator ? [owner] : []),
    contributor: uniq([...tellers, ...(owner && !pinned && !ownerAsCreator ? [owner] : [])]).filter((n) => !(ownerAsCreator && n === owner) && !(pinned ?? []).includes(n)),
    coverage: f.place_text || undefined,
    date: f.date_edtf || f.date_text || undefined,
    source: doc.photo.original_filename || doc.provenance?.source_filename || undefined,
    rights: f.rights || ctx.group.rights || undefined,
    type: "StillImage",
    format: doc.photo.original_mime || undefined,
    identifier: String(doc.photo.id),
  };
  for (const k of Object.keys(dc) as (keyof DublinCore)[]) {
    const v = dc[k];
    if (v === undefined || (Array.isArray(v) && !v.length)) delete dc[k];
  }
  return dc;
}
