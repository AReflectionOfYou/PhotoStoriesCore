// A file adapter for Node, rooted at a folder. Paths given to it are relative
// to that root (or absolute, when the root is "/").

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DirEntry, FileAdapter } from "./adapter.ts";

export class NodeAdapter implements FileAdapter {
  readonly root: string;
  constructor(root = "/") {
    this.root = root;
  }
  private abs(p: string) {
    return resolve(this.root, p);
  }
  async readFile(p: string) {
    return new Uint8Array(await readFile(this.abs(p)));
  }
  async writeFile(p: string, data: Uint8Array) {
    await writeFile(this.abs(p), data);
  }
  async list(p: string): Promise<DirEntry[]> {
    return (await readdir(this.abs(p), { withFileTypes: true }))
      .filter((e) => e.name !== ".DS_Store")
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  }
  async exists(p: string) {
    return stat(this.abs(p)).then(() => true, () => false);
  }
  async mkdir(p: string) {
    await mkdir(this.abs(p), { recursive: true });
  }
  async remove(p: string) {
    await rm(this.abs(p), { recursive: true, force: true });
  }
  async size(p: string) {
    return (await stat(this.abs(p))).size;
  }
  sha256(p: string) {
    return new Promise<string>((ok, fail) => {
      const h = createHash("sha256");
      createReadStream(this.abs(p)).on("data", (c) => h.update(c)).on("end", () => ok(h.digest("hex"))).on("error", fail);
    });
  }
  async copyFile(from: string, to: string) {
    await mkdir(dirname(this.abs(to)), { recursive: true });
    await copyFile(this.abs(from), this.abs(to));
  }
}
