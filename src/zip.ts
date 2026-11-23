// Zipping and unzipping bags. Adapters with native zip support (the desktop
// app's Rust layer) are used when present; otherwise fflate does it in memory,
// which is fine for small bags, tests and the browser.

import { unzipSync, zipSync, type Zippable } from "fflate";
import { basename, dirname, join, walk, type FileAdapter } from "./adapter.ts";

/** Zip directory `dir` into `zipPath`; the zip's top folder is the directory's name. */
export async function zipDir(fs: FileAdapter, dir: string, zipPath: string): Promise<void> {
  if (fs.zipDir) return fs.zipDir(dir, zipPath);
  const top = basename(dir);
  const tree: Zippable = {};
  for (const f of await walk(fs, dir)) {
    // Photos and audio are already compressed; store them as they are.
    tree[`${top}/${f.slice(dir.length + 1)}`] = [await fs.readFile(f), { level: /\.(json|txt|html|md)$/i.test(f) ? 6 : 0 }];
  }
  const d = dirname(zipPath);
  if (d) await fs.mkdir(d);
  await fs.writeFile(zipPath, zipSync(tree, { mtime: new Date("2000-01-01T00:00:00Z") }));
}

/** Unzip `zipPath` into directory `dir`. Paths that try to leave `dir` are refused. */
export async function unzipTo(fs: FileAdapter, zipPath: string, dir: string): Promise<void> {
  if (fs.unzip) return fs.unzip(zipPath, dir);
  const entries = unzipSync(await fs.readFile(zipPath));
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    if (name.startsWith("/") || name.split("/").includes("..") || name.includes("\\")) throw new Error(`unsafe path in zip: ${name}`);
    if (name.startsWith("__MACOSX/") || name.endsWith(".DS_Store")) continue;
    const target = join(dir, name);
    await fs.mkdir(dirname(target));
    await fs.writeFile(target, bytes);
  }
}

/** Find the folder holding bagit.txt: `dir` itself or one level down. */
export async function findBag(fs: FileAdapter, dir: string): Promise<string> {
  if (await fs.exists(join(dir, "bagit.txt"))) return dir;
  for (const e of await fs.list(dir)) {
    if (e.isDirectory && (await fs.exists(join(dir, e.name, "bagit.txt")))) return join(dir, e.name);
  }
  throw new Error("no BagIt bag found (bagit.txt is missing)");
}
