// File access is passed in, so the same code runs in a Tauri app, a browser
// and Node. Paths are always POSIX-style ("a/b/c.json"), relative to whatever
// root the adapter was made for.

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface FileAdapter {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Entries directly inside a directory. Throws if it does not exist. */
  list(path: string): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;
  /** Create a directory and any missing parents. */
  mkdir(path: string): Promise<void>;
  /** Remove a file or a whole directory tree. Missing paths are not an error. */
  remove(path: string): Promise<void>;
  /** File size in bytes. */
  size(path: string): Promise<number>;

  // Optional fast paths. The core uses them when present (for example, the
  // desktop app does these in Rust so large photos never cross into JS).
  sha256?(path: string): Promise<string>;
  copyFile?(from: string, to: string): Promise<void>;
  /** Zip the directory `dir` (its name becomes the top folder in the zip) into the file `zipPath`. */
  zipDir?(dir: string, zipPath: string): Promise<void>;
  /** Unzip the file `zipPath` into the directory `dir`. */
  unzip?(zipPath: string, dir: string): Promise<void>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export const join = (...parts: string[]) =>
  parts
    .filter((p) => p !== "")
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");

export const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export async function readText(fs: FileAdapter, path: string): Promise<string> {
  return dec.decode(await fs.readFile(path));
}

export async function writeText(fs: FileAdapter, path: string, text: string): Promise<void> {
  const dir = dirname(path);
  if (dir) await fs.mkdir(dir);
  await fs.writeFile(path, enc.encode(text));
}

export async function readJson<T = unknown>(fs: FileAdapter, path: string): Promise<T> {
  return JSON.parse(await readText(fs, path)) as T;
}

/** Every file under `dir`, as paths relative to the adapter root, sorted. */
export async function walk(fs: FileAdapter, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.list(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) out.push(...(await walk(fs, p)));
    else out.push(p);
  }
  return out.sort();
}

export async function copyFile(fs: FileAdapter, from: string, to: string): Promise<void> {
  const dir = dirname(to);
  if (dir) await fs.mkdir(dir);
  if (fs.copyFile) return fs.copyFile(from, to);
  await fs.writeFile(to, await fs.readFile(from));
}

export async function copyTree(fs: FileAdapter, from: string, to: string): Promise<void> {
  for (const f of await walk(fs, from)) await copyFile(fs, f, join(to, f.slice(from.length + 1)));
}

/** An adapter that keeps everything in memory: for tests, previews and the browser. */
export class MemoryAdapter implements FileAdapter {
  files = new Map<string, Uint8Array>();
  dirs = new Set<string>([""]);

  private norm(p: string) {
    return join(p);
  }

  async readFile(path: string) {
    const f = this.files.get(this.norm(path));
    if (!f) throw new Error(`no such file: ${path}`);
    return f;
  }
  async writeFile(path: string, data: Uint8Array) {
    const p = this.norm(path);
    if (!this.dirs.has(dirname(p))) throw new Error(`no such directory: ${dirname(p)}`);
    this.files.set(p, data.slice());
  }
  async list(path: string) {
    const p = this.norm(path);
    if (!this.dirs.has(p)) throw new Error(`no such directory: ${path}`);
    const prefix = p ? `${p}/` : "";
    const names = new Map<string, boolean>();
    for (const d of this.dirs) if (d !== p && d.startsWith(prefix) && !d.slice(prefix.length).includes("/")) names.set(d.slice(prefix.length), true);
    for (const f of this.files.keys()) if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/")) names.set(f.slice(prefix.length), false);
    return [...names].map(([name, isDirectory]) => ({ name, isDirectory }));
  }
  async exists(path: string) {
    const p = this.norm(path);
    return this.files.has(p) || this.dirs.has(p);
  }
  async mkdir(path: string) {
    const parts = this.norm(path).split("/");
    for (let i = 1; i <= parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
  }
  async remove(path: string) {
    const p = this.norm(path);
    this.files.delete(p);
    for (const f of [...this.files.keys()]) if (f.startsWith(`${p}/`)) this.files.delete(f);
    for (const d of [...this.dirs]) if (d === p || d.startsWith(`${p}/`)) this.dirs.delete(d);
  }
  async size(path: string) {
    return (await this.readFile(path)).length;
  }
}
