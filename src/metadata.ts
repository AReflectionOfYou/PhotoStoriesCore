// Embedded photo metadata (EXIF, IPTC, XMP) for JPEG files, with no
// dependencies so it runs in Node, browsers and the desktop app alike.
//
// Reading gives the values other software already wrote, so the app can fill
// in only what is missing and ask before replacing anything. Writing puts the
// chosen values into image.jpg (the working copy) as XMP, the way the shared
// online app does: the sidecar stays the source of truth, and the untouched
// original.* keeps whatever metadata it came with.

import { contextFrom, peopleNames, type DcContext } from "./dublin-core.ts";
import { edtfToXmpDate } from "./dates.ts";
import { storyWords, type PhotoDoc } from "./schema.ts";
import type { Row } from "./util.ts";

export interface EmbeddedValues {
  title?: string;
  description?: string;
  date?: string;
  place?: string;
  keywords?: string[];
  people?: string[];
  latitude?: number;
  longitude?: number;
}

export interface EmbeddedRead extends EmbeddedValues {
  /** Which standard each value was found in, e.g. { description: "EXIF" }. */
  sources: Partial<Record<keyof EmbeddedValues, "EXIF" | "IPTC" | "XMP">>;
  orientation?: number;
  width?: number;
  height?: number;
}

const XMP_HEADER = "http://ns.adobe.com/xap/1.0/\0";
const EXIF_HEADER = "Exif\0\0";
const utf8 = new TextDecoder();
const latin1 = new TextDecoder("latin1");

interface Segment {
  marker: number;
  start: number; // offset of the 0xFF marker byte
  end: number; // offset just past the segment
  data: Uint8Array; // payload (after the 2 length bytes)
}

/** The JPEG's header segments, up to the start of the image data. */
export function segments(jpeg: Uint8Array): Segment[] {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a JPEG file");
  const out: Segment[] = [];
  let i = 2;
  while (i + 4 <= jpeg.length) {
    if (jpeg[i] !== 0xff) break;
    const marker = jpeg[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    const len = (jpeg[i + 2] << 8) | jpeg[i + 3];
    out.push({ marker, start: i, end: i + 2 + len, data: jpeg.subarray(i + 4, i + 2 + len) });
    i += 2 + len;
  }
  return out;
}

const startsWith = (data: Uint8Array, text: string) => latin1.decode(data.subarray(0, text.length)) === text;

// ---- EXIF

interface ExifTags {
  ImageDescription?: { value: string; offset: number; length: number };
  DateTimeOriginal?: string;
  Orientation?: { value: number; offset: number };
  GPS?: { lat?: number; lon?: number };
  width?: number;
  height?: number;
}

function readExif(tiff: Uint8Array): ExifTags {
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const le = tiff[0] === 0x49;
  const u16 = (o: number) => view.getUint16(o, le);
  const u32 = (o: number) => view.getUint32(o, le);
  const out: ExifTags = {};
  const ascii = (count: number, valOff: number) => {
    const at = count <= 4 ? valOff : u32(valOff);
    return { value: latin1.decode(tiff.subarray(at, at + count)).replace(/\0+$/, "").trim(), offset: at, length: count };
  };
  const rationals = (count: number, valOff: number) => {
    const at = u32(valOff);
    return Array.from({ length: count }, (_, k) => u32(at + k * 8) / (u32(at + k * 8 + 4) || 1));
  };
  const ifd = (off: number, each: (tag: number, type: number, count: number, valOff: number) => void) => {
    if (off + 2 > tiff.length) return;
    const n = u16(off);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      if (e + 12 > tiff.length) return;
      each(u16(e), u16(e + 2), u32(e + 4), e + 8);
    }
  };
  let exifIfd = 0;
  let gpsIfd = 0;
  ifd(u32(4), (tag, type, count, v) => {
    if (tag === 0x010e && type === 2) out.ImageDescription = ascii(count, v);
    if (tag === 0x0112) out.Orientation = { value: u16(v), offset: v };
    if (tag === 0x8769) exifIfd = u32(v);
    if (tag === 0x8825) gpsIfd = u32(v);
  });
  if (exifIfd)
    ifd(exifIfd, (tag, type, count, v) => {
      if (tag === 0x9003 && type === 2) out.DateTimeOriginal = ascii(count, v).value;
      if (tag === 0xa002) out.width = type === 3 ? u16(v) : u32(v);
      if (tag === 0xa003) out.height = type === 3 ? u16(v) : u32(v);
    });
  if (gpsIfd) {
    let latRef = "N", lonRef = "E";
    let lat: number[] | null = null, lon: number[] | null = null;
    ifd(gpsIfd, (tag, _type, count, v) => {
      if (tag === 1) latRef = String.fromCharCode(tiff[v]);
      if (tag === 2) lat = rationals(count, v);
      if (tag === 3) lonRef = String.fromCharCode(tiff[v]);
      if (tag === 4) lon = rationals(count, v);
    });
    const deg = (d: number[] | null, ref: string, neg: string) => (d ? (d[0] + (d[1] ?? 0) / 60 + (d[2] ?? 0) / 3600) * (ref === neg ? -1 : 1) : undefined);
    out.GPS = { lat: deg(lat, latRef, "S"), lon: deg(lon, lonRef, "W") };
  }
  return out;
}

// ---- IPTC (Photoshop APP13, IPTC-IIM records)

function readIptc(app13: Uint8Array): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!startsWith(app13, "Photoshop 3.0\0")) return out;
  let i = 14;
  while (i + 12 <= app13.length && startsWith(app13.subarray(i), "8BIM")) {
    const id = (app13[i + 4] << 8) | app13[i + 5];
    const nameLen = app13[i + 6];
    let p = i + 7 + nameLen;
    if ((nameLen + 1) % 2) p++;
    const size = (app13[p] << 24) | (app13[p + 1] << 16) | (app13[p + 2] << 8) | app13[p + 3];
    const body = app13.subarray(p + 4, p + 4 + size);
    if (id === 0x0404) {
      let j = 0;
      while (j + 5 <= body.length && body[j] === 0x1c) {
        const rec = body[j + 1], ds = body[j + 2];
        const len = (body[j + 3] << 8) | body[j + 4];
        const key = `${rec}:${ds}`;
        (out[key] ??= []).push(utf8.decode(body.subarray(j + 5, j + 5 + len)).trim());
        j += 5 + len;
      }
    }
    i = p + 4 + size + (size % 2);
  }
  return out;
}

// ---- XMP (just the properties Photo Stories uses)

const xmlUnescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&");
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function xmpProp(xml: string, name: string): string[] {
  const out: string[] = [];
  // Attribute form: dc:title="..."
  const attr = new RegExp(`\\s${name}="([^"]*)"`).exec(xml);
  if (attr) out.push(xmlUnescape(attr[1]));
  // Element form, possibly holding an Alt/Bag/Seq of rdf:li.
  const el = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  if (el) {
    const items = [...el[1].matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)].map((m) => xmlUnescape(m[1].trim()));
    out.push(...(items.length ? items : [xmlUnescape(el[1].trim())]).filter((x) => x && !x.startsWith("<")));
  }
  return out;
}

/** Read the values other software already put in a JPEG. */
export function readEmbedded(jpeg: Uint8Array): EmbeddedRead {
  const r: EmbeddedRead = { sources: {} };
  const set = <K extends keyof EmbeddedValues>(k: K, v: EmbeddedValues[K] | undefined, src: "EXIF" | "IPTC" | "XMP") => {
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length) || r[k] !== undefined) return;
    (r as Row)[k] = v;
    r.sources[k] = src;
  };
  const segs = segments(jpeg);
  // XMP first: it is the most complete and the most recent standard.
  for (const s of segs) {
    if (s.marker !== 0xe1 || !startsWith(s.data, XMP_HEADER)) continue;
    const xml = utf8.decode(s.data.subarray(XMP_HEADER.length));
    set("title", xmpProp(xml, "dc:title")[0], "XMP");
    set("description", xmpProp(xml, "dc:description")[0], "XMP");
    set("date", xmpProp(xml, "photoshop:DateCreated")[0] ?? xmpProp(xml, "xmp:CreateDate")[0], "XMP");
    set("place", xmpProp(xml, "Iptc4xmpCore:Location")[0] ?? xmpProp(xml, "photoshop:City")[0], "XMP");
    set("keywords", xmpProp(xml, "dc:subject"), "XMP");
    set("people", xmpProp(xml, "Iptc4xmpExt:PersonInImage"), "XMP");
  }
  for (const s of segs) {
    if (s.marker !== 0xed) continue;
    const iptc = readIptc(s.data);
    set("title", iptc["2:5"]?.[0], "IPTC");
    set("description", iptc["2:120"]?.[0], "IPTC");
    const d = iptc["2:55"]?.[0];
    set("date", d && /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : undefined, "IPTC");
    set("place", [iptc["2:92"]?.[0], iptc["2:90"]?.[0], iptc["2:95"]?.[0], iptc["2:101"]?.[0]].filter(Boolean).join(", ") || undefined, "IPTC");
    set("keywords", iptc["2:25"], "IPTC");
  }
  for (const s of segs) {
    if (s.marker !== 0xe1 || !startsWith(s.data, EXIF_HEADER)) continue;
    const exif = readExif(s.data.subarray(6));
    set("description", exif.ImageDescription?.value, "EXIF");
    const dt = exif.DateTimeOriginal && /^(\d{4}):(\d{2}):(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?/.exec(exif.DateTimeOriginal);
    set("date", dt && dt[1] !== "0000" ? `${dt[1]}-${dt[2]}-${dt[3]}${dt[4] ? `T${dt[4]}:${dt[5]}:${dt[6]}` : ""}` : undefined, "EXIF");
    if (exif.GPS?.lat !== undefined && exif.GPS?.lon !== undefined && r.latitude === undefined) {
      r.latitude = exif.GPS.lat;
      r.longitude = exif.GPS.lon;
      r.sources.latitude = r.sources.longitude = "EXIF";
    }
    r.orientation ??= exif.Orientation?.value;
    r.width ??= exif.width;
    r.height ??= exif.height;
  }
  return r;
}

// ---- Choosing values: fill what's missing, flag what differs.

export interface MetadataConflict {
  field: keyof EmbeddedValues;
  embedded: unknown;
  ours: unknown;
  source: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(Array.isArray(a) ? [...a].sort() : a) === JSON.stringify(Array.isArray(b) ? [...b].sort() : b);

/**
 * Values that agree, though not character for character: the same date at a
 * different precision ("2019-07-04" and "2019-07-04T10:30:00-05:00"), or the
 * same spot on the map to within about a metre.
 */
function agree(field: keyof EmbeddedValues, e: unknown, o: unknown): boolean {
  if (same(e, o)) return true;
  if (field === "date") {
    const a = String(e).replace(/(\.\d+)?([+-]\d{2}:?\d{2}|Z)$/, ""), b = String(o).replace(/(\.\d+)?([+-]\d{2}:?\d{2}|Z)$/, "");
    return a.startsWith(b) || b.startsWith(a);
  }
  if (field === "latitude" || field === "longitude") return Math.abs(Number(e) - Number(o)) < 1e-5;
  return false;
}

/**
 * Compare the photo's own values with what was already embedded. Missing
 * fields are filled from ours; fields that differ are returned as conflicts
 * for the person to decide (until then, the embedded value is kept). Values
 * that agree at different precision are not conflicts; the embedded one is kept.
 */
export function planEmbedded(embedded: EmbeddedRead, ours: EmbeddedValues): { values: EmbeddedValues; conflicts: MetadataConflict[] } {
  const values: EmbeddedValues = {};
  const conflicts: MetadataConflict[] = [];
  for (const k of ["title", "description", "date", "place", "keywords", "people", "latitude", "longitude"] as (keyof EmbeddedValues)[]) {
    const e = embedded[k];
    const o = ours[k];
    const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
    if (empty(e)) {
      if (!empty(o)) (values as Row)[k] = o;
    } else {
      (values as Row)[k] = e;
      if (!empty(o) && !agree(k, e, o)) conflicts.push({ field: k, embedded: e, ours: o, source: embedded.sources[k] ?? "XMP" });
    }
  }
  return { values, conflicts };
}

/** The values Photo Stories would embed for a photo, from its sidecar. */
export function valuesFor(doc: PhotoDoc, ctx: DcContext, opts: { includeStory?: boolean } = {}): EmbeddedValues {
  const f = doc.details ?? {};
  const people = peopleNames(doc, ctx.personName);
  const story = (doc.contributions ?? []).filter((c) => !c.deleted_at).map((c) => storyWords(c) || c.typed_text || "").filter(Boolean).join("\n\n");
  const v: EmbeddedValues = {
    title: f.caption || undefined,
    description: opts.includeStory === false ? undefined : story || undefined,
    date: edtfToXmpDate(f.date_edtf) ?? undefined,
    place: f.place_text || undefined,
    keywords: people.length ? people : undefined,
    people: people.length ? people : undefined,
    latitude: typeof f.latitude === "number" ? f.latitude : undefined,
    longitude: typeof f.longitude === "number" ? f.longitude : undefined,
  };
  for (const k of Object.keys(v) as (keyof EmbeddedValues)[]) if (v[k] === undefined) delete v[k];
  return v;
}

export { contextFrom };

// ---- Writing

const FPS_NS = "https://maherou.github.io/PhotoStories/ns/1.0/";

function gpsCoord(deg: number, pos: string, neg: string) {
  const a = Math.abs(deg);
  const d = Math.floor(a);
  return `${d},${((a - d) * 60).toFixed(6)}${deg < 0 ? neg : pos}`;
}

/** An XMP packet with the given values, Photo Stories' photo id, and named face regions. */
export function buildXmp(values: EmbeddedValues, extra: { photoId?: string; schemaVersion?: string; faces?: { x: number; y: number; w: number; h: number; name?: string }[]; width?: number; height?: number } = {}): string {
  const alt = (name: string, v?: string) => (v ? `<${name}><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(v)}</rdf:li></rdf:Alt></${name}>` : "");
  const bag = (name: string, vs?: string[]) => (vs?.length ? `<${name}><rdf:Bag>${vs.map((x) => `<rdf:li>${xmlEscape(x)}</rdf:li>`).join("")}</rdf:Bag></${name}>` : "");
  const simple = (name: string, v?: string) => (v ? `<${name}>${xmlEscape(v)}</${name}>` : "");
  const regions = extra.faces?.length && extra.width && extra.height
    ? `<mwg-rs:Regions rdf:parseType="Resource"><mwg-rs:AppliedToDimensions stDim:w="${extra.width}" stDim:h="${extra.height}" stDim:unit="pixel"/><mwg-rs:RegionList><rdf:Bag>${extra.faces
        .map((f) => `<rdf:li rdf:parseType="Resource">${f.name ? `<mwg-rs:Name>${xmlEscape(f.name)}</mwg-rs:Name>` : ""}<mwg-rs:Type>Face</mwg-rs:Type><mwg-rs:Area stArea:x="${(f.x + f.w / 2).toFixed(6)}" stArea:y="${(f.y + f.h / 2).toFixed(6)}" stArea:w="${f.w.toFixed(6)}" stArea:h="${f.h.toFixed(6)}" stArea:unit="normalized"/></rdf:li>`)
        .join("")}</rdf:Bag></mwg-rs:RegionList></mwg-rs:Regions>`
    : "";
  const body = [
    alt("dc:title", values.title),
    alt("dc:description", values.description),
    bag("dc:subject", values.keywords),
    bag("Iptc4xmpExt:PersonInImage", values.people),
    simple("photoshop:DateCreated", values.date),
    simple("Iptc4xmpCore:Location", values.place),
    values.latitude !== undefined && values.longitude !== undefined ? simple("exif:GPSLatitude", gpsCoord(values.latitude, "N", "S")) + simple("exif:GPSLongitude", gpsCoord(values.longitude, "E", "W")) : "",
    simple("xmpMM:DocumentID", extra.photoId),
    simple("fps:PhotoId", extra.photoId),
    simple("fps:SchemaVersion", extra.schemaVersion),
    regions,
  ].join("");
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:mwg-rs="http://www.metadataworkinggroup.com/schemas/regions/" xmlns:stDim="http://ns.adobe.com/xap/1.0/sType/Dimensions#" xmlns:stArea="http://ns.adobe.com/xmp/sType/Area#" xmlns:fps="${FPS_NS}">${body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

const segmentBytes = (marker: number, payload: Uint8Array) => {
  if (payload.length + 2 > 0xffff) throw new Error("metadata too large for one JPEG segment");
  const out = new Uint8Array(payload.length + 4);
  out.set([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  out.set(payload, 4);
  return out;
};

export interface WriteOptions {
  /** Copy EXIF and IPTC from this JPEG (the original), e.g. after the working copy was re-encoded. */
  carryFrom?: Uint8Array;
  /** The image was already turned upright, so EXIF Orientation is set to 1. Default true when carrying. */
  resetOrientation?: boolean;
  /** Fields the person chose to replace: their old EXIF/IPTC copies are cleared so readers don't show the old value. */
  replaced?: (keyof EmbeddedValues)[];
}

/**
 * Return the JPEG with a new XMP packet (replacing any XMP it had), optionally
 * carrying EXIF and IPTC over from another JPEG.
 */
export function writeXmp(jpeg: Uint8Array, xmp: string, opts: WriteOptions = {}): Uint8Array {
  const segs = segments(jpeg);
  const keep = segs.filter((s) => !(s.marker === 0xe1 && (startsWith(s.data, XMP_HEADER) || (opts.carryFrom && startsWith(s.data, EXIF_HEADER)))) && !(opts.carryFrom && s.marker === 0xed));
  const added: Uint8Array[] = [];
  if (opts.carryFrom) {
    for (const s of segments(opts.carryFrom)) {
      if (s.marker === 0xe1 && startsWith(s.data, EXIF_HEADER)) {
        const data = s.data.slice();
        const exif = readExif(data.subarray(6));
        if (exif.Orientation && opts.resetOrientation !== false) {
          const le = data[6] === 0x49;
          data[6 + exif.Orientation.offset] = le ? 1 : 0;
          data[6 + exif.Orientation.offset + 1] = le ? 0 : 1;
        }
        if (opts.replaced?.includes("description") && exif.ImageDescription) data.fill(0, 6 + exif.ImageDescription.offset, 6 + exif.ImageDescription.offset + exif.ImageDescription.length);
        added.push(segmentBytes(0xe1, data));
      }
      // IPTC is carried only if none of its fields were replaced; XMP holds the chosen values either way.
      if (s.marker === 0xed && !opts.replaced?.some((f) => ["title", "description", "date", "place", "keywords"].includes(f))) added.push(segmentBytes(0xed, s.data));
    }
  }
  added.push(segmentBytes(0xe1, new TextEncoder().encode(XMP_HEADER + xmp)));
  // New segments go after JFIF/APP0, before everything else.
  const app0 = keep.filter((s) => s.marker === 0xe0);
  const rest = keep.filter((s) => s.marker !== 0xe0);
  const headerEnd = segs.length ? segs[segs.length - 1].end : 2;
  const parts = [new Uint8Array([0xff, 0xd8]), ...app0.map((s) => jpeg.subarray(s.start, s.end)), ...added, ...rest.map((s) => jpeg.subarray(s.start, s.end)), jpeg.subarray(headerEnd)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Remove all XMP (e.g. to compare images regardless of metadata). */
export function stripXmp(jpeg: Uint8Array): Uint8Array {
  const segs = segments(jpeg);
  const xmp = segs.filter((s) => s.marker === 0xe1 && startsWith(s.data, XMP_HEADER));
  if (!xmp.length) return jpeg;
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const s of xmp) {
    parts.push(jpeg.subarray(at, s.start));
    at = s.end;
  }
  parts.push(jpeg.subarray(at));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
