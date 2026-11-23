# Photo Stories package schema

Schema version **2**. The machine-readable definition is [`schema/photo.schema.json`](../schema/photo.schema.json) (JSON Schema 2020-12). This page explains it for people.

## Rules that never change

- Field names are stable. A new schema version adds fields; it never renames or removes one, and never changes what an existing field means.
- Readers keep fields they don't understand. Every object allows extra properties.
- Every sidecar says its `schema_version`. Readers upgrade older sidecars on import (backing up first) and read newer ones as far as they can, with a warning.
- All JSON is canonical: keys sorted, two-space indent, trailing newline. The same data always gives the same bytes.
- Ids are UUIDs and never change, including across export and import. A photo's id is also its folder name.

## Version history

| Version | Made by | What changed |
|---|---|---|
| 1 | Shared online app (`family-photo-stories-worker` 1.0.0) | The baseline. |
| 2 | photostories-core 0.1.0 | Added `dublin_core`, `provenance`, `edits`, `files.thumb`, `details.notes`, `details.latitude`, `details.longitude`, `details.creator`, `details.rights`, `contributions[].story_text`, `contributions[].story_cleanup`, and in `group.json`: `owner_name`, `owner_contact`, `owner_role`, `rights`, `owner_contributor_id`. `manifest.json` gains `library` and, after a migration, `migrated_from_schema_version`. |

## Top-level files

| File | Holds |
|---|---|
| `group.json` | The project: `id`, `name`, `slug`, `created_at`, and (v2) the owner's name, contact, whether they are `dc:creator` or `dc:contributor`, and the license (`rights`). |
| `contributors.json` | The storytellers: `id`, `display_name`. Someone merged into another has `merged_into`. |
| `people.json` | Everyone named: `id`, `display_name`, `aliases` (other names, nicknames), `notes`. |
| `collections.json`, `events.json` | Albums or boxes, and occasions within them. |
| `consent.json` | Consent statements agreed to before recording (the shared online app). Empty for a personal project. |
| `usage.json` | AI services used, with estimated cost. May be empty. |
| `manifest.json` | Bundles only: `schema_version`, `generator`, `library`, `scope`, `contents`, `counts`, `exported_at`. |

## `photos/<id>/photo.json`

| Field | Meaning |
|---|---|
| `schema_version` | `"1"` or `"2"`. |
| `photo` | The photo itself: `id`, `collection_id`, `original_sha256` (used to find duplicates), `original_filename`, `original_mime`, `crop_params`, `hidden`, `created_by`, `created_at`. |
| `details` | What's known about it, each with a certainty (`sure`, `likely`, `guess`) where it applies: `caption` (the title), `date_text` (as said) and `date_edtf` (EDTF), `place_text`, `event_text`, `photographer_text`, `original_location_text`, and (v2) `notes`, `latitude`, `longitude`. A photo imported from someone else's project keeps its own `creator` and `rights` here. |
| `faces` | Face boxes as fractions of `image.jpg`'s size: `bbox_x`, `bbox_y` (top-left corner), `bbox_w`, `bbox_h`; `person_id`; `detector`; `dismissed` (a false box is dismissed, never deleted). |
| `people_in_photo` | Who is in it (with or without a face box), with when they were added or removed. |
| `contributions` | Stories, memories, comments and follow-up answers: `kind`, `contributor_id`, `prompt_text`, `transcript` (raw), `transcript_edited_text` (the speaker's corrections), `typed_text`, and (v2) `story_text` (the cleaned story, the speaker's own words lightly polished) and `story_cleanup` (`{method: "none" \| "local" \| "anthropic" \| "openai", model}`). |
| `contribution_versions` | Earlier wording of a contribution, whenever it changed. |
| `field_history`, `face_tag_history` | Every change to details and face names: old value, new value, who, when, how. |
| `ai_extractions`, `extraction_reviews` | What AI suggested and what was decided (the shared online app). |
| `files` | File names in the photo's folder: `original`, `image`, `thumb` (v2), `back_original`, `back_image`, `audio`. |
| `provenance` (v2) | Where the copy came from: `source_filename`, `source_path`, `copied_at`, `copy_size` (`full` or `resized`), `max_long_edge`, `app`. For provenance only. |
| `edits` (v2) | A summary of edits to the working copy: `{at, action, params}` with actions such as `crop`, `rotate`, `brightness`, `contrast`, `auto_enhance`, `reset`. |
| `dublin_core` (v2) | The Dublin Core description, computed from the fields above; see the README for the mapping. |

## Dates (EDTF)

`1965` a year, `1965-07` a month, `1965-07-04` a day, `1965~` about 1965, `1965?` maybe 1965, `1965%` about and maybe, `196X` the 1960s, `1965-21` spring, `-22` summer, `-23` autumn, `-24` winter.

## Embedded metadata in `image.jpg`

`dc:title`, `dc:description` (the story, unless turned off), `dc:subject` and `Iptc4xmpExt:PersonInImage` (the people), `photoshop:DateCreated`, `Iptc4xmpCore:Location`, GPS when known, `xmpMM:DocumentID` and `fps:PhotoId` (the photo id), and MWG face regions with names. The `fps` namespace is `https://maherou.github.io/PhotoStories/ns/1.0/`, as in the shared online app. Values already embedded are kept unless the person chooses to replace them. `original.*` is never changed.
