import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { buildXmp, planEmbedded, readEmbedded, segments, stripXmp, writeXmp } from "../src/metadata.ts";
import { IMAGES } from "./helpers.ts";

/** A little-endian EXIF APP1 payload with ImageDescription, Orientation and DateTimeOriginal. */
function exifSegment(description: string, orientation: number, taken: string): Uint8Array {
  const desc = new TextEncoder().encode(`${description}\0`);
  const date = new TextEncoder().encode(`${taken}\0`);
  // Layout: header(8) | IFD0: count(2) + 3 entries(36) + next(4) | ExifIFD: count(2) + 1 entry(12) + next(4) | desc | date
  const ifd0 = 8;
  const exifIfd = ifd0 + 2 + 3 * 12 + 4;
  const descAt = exifIfd + 2 + 12 + 4;
  const dateAt = descAt + desc.length;
  const tiff = new Uint8Array(dateAt + date.length);
  const v = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 0x2a, 0x00]);
  v.setUint32(4, ifd0, true);
  v.setUint16(ifd0, 3, true);
  const entry = (at: number, tag: number, type: number, count: number, value: number, short = false) => {
    v.setUint16(at, tag, true);
    v.setUint16(at + 2, type, true);
    v.setUint32(at + 4, count, true);
    if (short) v.setUint16(at + 8, value, true);
    else v.setUint32(at + 8, value, true);
  };
  entry(ifd0 + 2, 0x010e, 2, desc.length, descAt);
  entry(ifd0 + 14, 0x0112, 3, 1, orientation, true);
  entry(ifd0 + 26, 0x8769, 4, 1, exifIfd);
  v.setUint16(exifIfd, 1, true);
  entry(exifIfd + 2, 0x9003, 2, date.length, dateAt);
  tiff.set(desc, descAt);
  tiff.set(date, dateAt);
  const payload = new Uint8Array(6 + tiff.length);
  payload.set(new TextEncoder().encode("Exif\0\0"));
  payload.set(tiff, 6);
  return payload;
}

function withSegment(jpeg: Uint8Array, marker: number, payload: Uint8Array): Uint8Array {
  const seg = new Uint8Array(4 + payload.length);
  seg.set([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  seg.set(payload, 4);
  const out = new Uint8Array(jpeg.length + seg.length);
  out.set(jpeg.subarray(0, 2));
  out.set(seg, 2);
  out.set(jpeg.subarray(2), 2 + seg.length);
  return out;
}

test("metadata: reads EXIF description, date and orientation", async () => {
  const plain = new Uint8Array(await readFile(join(IMAGES, "house.jpg")));
  const jpeg = withSegment(plain, 0xe1, exifSegment("Old description from the camera", 6, "1999:07:04 10:30:00"));
  const r = readEmbedded(jpeg);
  assert.equal(r.description, "Old description from the camera");
  assert.equal(r.sources.description, "EXIF");
  assert.equal(r.date, "1999-07-04");
  assert.equal(r.orientation, 6);
  assert.equal(r.title, undefined);
});

test("metadata: fills what's missing, and flags what differs instead of overwriting", async () => {
  const plain = new Uint8Array(await readFile(join(IMAGES, "house.jpg")));
  const jpeg = withSegment(plain, 0xe1, exifSegment("Camera text", 1, "1999:07:04 10:30:00"));
  const { values, conflicts } = planEmbedded(readEmbedded(jpeg), { title: "The red house", description: "This is the house we grew up in.", date: "1999-07-04", people: ["Robert Example"] });
  assert.equal(values.title, "The red house", "missing: filled in");
  assert.equal(values.description, "Camera text", "different: kept until the person decides");
  assert.deepEqual(values.people, ["Robert Example"]);
  assert.deepEqual(conflicts.map((c) => c.field), ["description"], "same date is not a conflict");
  assert.equal(conflicts[0].embedded, "Camera text");
  assert.equal(conflicts[0].ours, "This is the house we grew up in.");
});

test("metadata: writes XMP that reads back, carries EXIF over and sets it upright", async () => {
  const plain = new Uint8Array(await readFile(join(IMAGES, "house.jpg")));
  const original = withSegment(plain, 0xe1, exifSegment("Camera text", 6, "1999:07:04 10:30:00"));
  const xmp = buildXmp(
    { title: "The red house & tree", description: "Line one.\nLine <two>.", date: "1965", place: "Elm Street", keywords: ["Robert Example"], people: ["Robert Example"], latitude: 44.5, longitude: -93.25 },
    { photoId: "abc", schemaVersion: "2", faces: [{ x: 0.4, y: 0.5, w: 0.1, h: 0.2, name: "Robert Example" }], width: 800, height: 600 },
  );
  // The working copy was re-encoded (no EXIF); carry it over from the original and replace the description.
  const out = writeXmp(plain, xmp, { carryFrom: original, replaced: ["description"] });
  const r = readEmbedded(out);
  assert.equal(r.title, "The red house & tree");
  assert.equal(r.description, "Line one.\nLine <two>.");
  assert.equal(r.sources.description, "XMP");
  assert.equal(r.date, "1965");
  assert.equal(r.place, "Elm Street");
  assert.deepEqual(r.people, ["Robert Example"]);
  assert.equal(r.orientation, 1, "turned upright");
  // The replaced EXIF description is cleared so other software doesn't show the old one.
  const exifOnly = readEmbedded(stripXmp(out));
  assert.equal(exifOnly.description, undefined);
  assert.equal(exifOnly.date, "1999-07-04", "other EXIF is kept");
  // The image data itself is unchanged.
  const tail = (b: Uint8Array) => b.subarray(segments(b).at(-1)!.end);
  assert.deepEqual(tail(out), tail(plain));
  // Writing again replaces the XMP rather than adding a second packet.
  const again = writeXmp(out, buildXmp({ title: "New title" }));
  assert.equal(segments(again).filter((s) => s.marker === 0xe1 && new TextDecoder().decode(s.data.subarray(0, 28)) === "http://ns.adobe.com/xap/1.0/").length, 1);
  assert.equal(readEmbedded(again).title, "New title");
});
