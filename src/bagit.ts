// BagIt 1.0 (RFC 8493, the Library of Congress packaging standard).

import { join, readText, walk, writeText, type FileAdapter } from "./adapter.ts";
import { sha256File } from "./util.ts";

/**
 * Write the tag files for a bag whose payload is already in <bag>/data.
 * `extraTags` are other files at the top of the bag (such as START HERE.html),
 * covered by the tag manifest so damage to them is detected too.
 */
export async function finishBag(fs: FileAdapter, bag: string, info: Record<string, string>, extraTags: string[] = []) {
  const files = await walk(fs, join(bag, "data"));
  let bytes = 0;
  const lines: string[] = [];
  for (const f of files) {
    bytes += await fs.size(f);
    lines.push(`${await sha256File(fs, f)}  ${rel(bag, f)}`);
  }
  await writeText(fs, join(bag, "bagit.txt"), "BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n");
  await writeText(fs, join(bag, "manifest-sha256.txt"), `${lines.join("\n")}\n`);
  const allInfo = { ...info, "Payload-Oxum": `${bytes}.${files.length}` };
  await writeText(fs, join(bag, "bag-info.txt"), `${Object.entries(allInfo).map(([k, v]) => `${k}: ${v.replace(/\n/g, " ")}`).join("\n")}\n`);
  const tags = [];
  for (const t of ["bagit.txt", "bag-info.txt", "manifest-sha256.txt", ...extraTags]) tags.push(`${await sha256File(fs, join(bag, t))}  ${t}`);
  await writeText(fs, join(bag, "tagmanifest-sha256.txt"), `${tags.join("\n")}\n`);
  return { files: files.length, bytes };
}

const rel = (bag: string, f: string) => (bag ? f.slice(bag.length + 1) : f);

export interface BagCheck {
  /** Everything wrong, in words. Empty means the bag is valid. */
  problems: string[];
  /** Payload paths (relative to the bag, "data/...") that are missing or damaged. */
  badFiles: Set<string>;
}

/** Check a bag: required tag files, every checksum, no missing or extra payload files, Payload-Oxum. */
export async function checkBag(fs: FileAdapter, bag: string): Promise<BagCheck> {
  const problems: string[] = [];
  const badFiles = new Set<string>();
  const read = async (f: string) => (await readText(fs, join(bag, f))).replace(/\r\n/g, "\n");
  let declaration = "";
  try {
    declaration = await read("bagit.txt");
  } catch {
    return { problems: ["bagit.txt is missing"], badFiles };
  }
  if (!/^BagIt-Version: 1\.0\nTag-File-Character-Encoding: UTF-8\n?$/.test(declaration)) problems.push("bagit.txt is not a BagIt 1.0 declaration");

  const check = async (manifest: string, required: boolean) => {
    let text = "";
    try {
      text = await read(manifest);
    } catch {
      if (required) problems.push(`${manifest} is missing`);
      return new Set<string>();
    }
    const listed = new Set<string>();
    for (const line of text.split("\n").filter(Boolean)) {
      const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line);
      if (!m) {
        problems.push(`${manifest}: bad line "${line}"`);
        continue;
      }
      listed.add(m[2]);
      if (!(await fs.exists(join(bag, m[2])))) {
        problems.push(`missing file: ${m[2]}`);
        badFiles.add(m[2]);
      } else if ((await sha256File(fs, join(bag, m[2]))) !== m[1]) {
        problems.push(`checksum mismatch: ${m[2]}`);
        badFiles.add(m[2]);
      }
    }
    return listed;
  };

  const listed = await check("manifest-sha256.txt", true);
  await check("tagmanifest-sha256.txt", false);
  const actual = (await walk(fs, join(bag, "data"))).map((f) => rel(bag, f));
  for (const f of actual) if (!listed.has(f)) problems.push(`file not in manifest: ${f}`);

  const oxum = /Payload-Oxum:\s*(\d+)\.(\d+)/.exec(await read("bag-info.txt").catch(() => ""));
  if (oxum) {
    let bytes = 0;
    for (const f of actual) bytes += await fs.size(join(bag, f));
    if (Number(oxum[1]) !== bytes || Number(oxum[2]) !== actual.length) problems.push(`Payload-Oxum ${oxum[1]}.${oxum[2]} doesn't match ${bytes}.${actual.length}`);
  }
  return { problems, badFiles };
}

/** Problems with a bag, in words; empty when valid. */
export async function validateBag(fs: FileAdapter, bag: string): Promise<string[]> {
  return (await checkBag(fs, bag)).problems;
}

/** bag-info.txt as key/value pairs. */
export async function readBagInfo(fs: FileAdapter, bag: string): Promise<Record<string, string>> {
  const text = await readText(fs, join(bag, "bag-info.txt")).catch(() => "");
  return Object.fromEntries(
    text
      .split("\n")
      .filter((l) => l.includes(":"))
      .map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]),
  );
}
