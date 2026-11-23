import type { FileAdapter } from "./adapter.ts";

export type Row = Record<string, any>;

/** JSON with object keys sorted, so the same data always produces the same bytes. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as Row).sort().map((k) => [k, sort((v as Row)[k])]));
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** Stable order: by a time column, then id. */
export function byTime(col: string) {
  return (a: Row, b: Row) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) || String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

export const sortRows = (rows: Row[], col = "created_at") => [...rows].sort(byTime(col));

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Bytes(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
}

export async function sha256File(fs: FileAdapter, path: string): Promise<string> {
  if (fs.sha256) return fs.sha256(path);
  return sha256Bytes(await fs.readFile(path));
}

export const uuid = () => crypto.randomUUID();

export const uniq = <T>(xs: T[]) => [...new Set(xs)];

export const extOf = (path: string) => (path.includes(".") ? path.split(".").pop()!.toLowerCase() : "bin");

export const slugPart = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);

export const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  gif: "image/gif", tif: "image/tiff", tiff: "image/tiff", webm: "audio/webm", m4a: "audio/mp4", mp4: "audio/mp4",
  aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac", wav: "audio/wav",
};
export const mimeOf = (path: string) => MIME[extOf(path)] ?? "application/octet-stream";
