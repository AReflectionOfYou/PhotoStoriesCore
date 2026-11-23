// People-name merging: exact matches (by name or alias, ignoring case and
// accents) merge on their own; near-matches (Bob and Robert, Katherine and
// Kathryn, "Rose" and "Grandma Rose") are flagged for a person to decide.

import type { Row } from "./util.ts";

// Common English nickname groups. Any two names in a group are a near-match.
const NICKNAMES: string[][] = [
  ["robert", "rob", "robbie", "bob", "bobby", "bert"],
  ["william", "will", "willie", "bill", "billy", "liam"],
  ["richard", "rick", "ricky", "rich", "dick"],
  ["james", "jim", "jimmy", "jamie"],
  ["john", "johnny", "jack", "jon"],
  ["joseph", "joe", "joey"],
  ["thomas", "tom", "tommy"],
  ["michael", "mike", "mikey", "mick"],
  ["charles", "charlie", "chuck", "chas"],
  ["edward", "ed", "eddie", "ted", "teddy", "ned"],
  ["anthony", "tony"],
  ["daniel", "dan", "danny"],
  ["david", "dave", "davey"],
  ["steven", "stephen", "steve"],
  ["christopher", "chris", "kit"],
  ["matthew", "matt"],
  ["andrew", "andy", "drew"],
  ["nicholas", "nick", "nicky"],
  ["alexander", "alex", "sandy", "xander"],
  ["benjamin", "ben", "benny"],
  ["samuel", "sam", "sammy"],
  ["henry", "hank", "harry"],
  ["lawrence", "larry"],
  ["gerald", "gerry", "jerry"],
  ["ronald", "ron", "ronnie"],
  ["donald", "don", "donnie"],
  ["kenneth", "ken", "kenny"],
  ["leonard", "leo", "len", "lenny"],
  ["frederick", "fred", "freddie"],
  ["francis", "frank", "frankie"],
  ["peter", "pete"],
  ["patrick", "pat", "paddy"],
  ["elizabeth", "liz", "lizzie", "beth", "betty", "betsy", "eliza", "libby", "bess"],
  ["margaret", "maggie", "meg", "peggy", "marge", "margie", "greta"],
  ["katherine", "catherine", "kathryn", "kate", "katie", "kathy", "cathy", "kat", "kay"],
  ["patricia", "pat", "patty", "trish", "tricia"],
  ["jennifer", "jen", "jenny"],
  ["susan", "sue", "susie", "suzanne"],
  ["deborah", "debra", "deb", "debbie"],
  ["barbara", "barb", "babs"],
  ["dorothy", "dot", "dottie", "dolly"],
  ["rebecca", "becky", "becca"],
  ["victoria", "vicky", "tori"],
  ["jacqueline", "jackie"],
  ["christine", "christina", "chris", "tina", "chrissy"],
  ["abigail", "abby"],
  ["virginia", "ginny", "ginger"],
  ["theresa", "teresa", "terry", "tess"],
  ["mary", "molly", "polly", "mae", "mamie"],
  ["helen", "nell", "nellie", "ellie"],
  ["eleanor", "ellie", "nora", "nell"],
  ["josephine", "jo", "josie"],
  ["madeline", "madeleine", "maddie", "maddy"],
  ["samantha", "sam", "sammy"],
  ["alexandra", "alex", "sandra", "sandy", "lexi"],
];

const groupsOf = new Map<string, number[]>();
NICKNAMES.forEach((g, i) => g.forEach((n) => groupsOf.set(n, [...(groupsOf.get(n) ?? []), i])));

export const normName = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const TITLES = new Set(["grandma", "grandpa", "granny", "nana", "nanna", "papa", "pop", "mom", "mother", "dad", "father", "aunt", "auntie", "uncle", "cousin", "mr", "mrs", "ms", "miss", "dr", "great", "grandmother", "grandfather"]);

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const nicknamesMatch = (a: string, b: string) => (groupsOf.get(a) ?? []).some((g) => (groupsOf.get(b) ?? []).includes(g));

/** Why two different names might be the same person, or null if they don't look alike. */
export function nearMatch(a: string, b: string): string | null {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y || x === y) return null;
  const tx = x.split(" ");
  const ty = y.split(" ");
  // Same rest of the name, nickname-equivalent first names: Bob Smith / Robert Smith.
  if (tx.length === ty.length && tx.slice(1).join(" ") === ty.slice(1).join(" ") && nicknamesMatch(tx[0], ty[0])) return "nickname";
  // Small spelling differences: Kathryn / Katheryn, Jon Smith / John Smith.
  const limit = Math.max(x.length, y.length) <= 5 ? 1 : 2;
  if (distance(x, y) <= limit) return "spelling";
  // One name is part of the other once titles are set aside: Rose / Grandma Rose, Rose / Rose Smith.
  const core = (t: string[]) => t.filter((w) => !TITLES.has(w));
  const cx = core(tx);
  const cy = core(ty);
  if (cx.length && cy.length) {
    const [short, long] = cx.length <= cy.length ? [cx, cy] : [cy, cx];
    if (short.every((w) => long.includes(w))) return "part of the name";
    if (short.length === 1 && long.some((w) => nicknamesMatch(w, short[0]))) return "nickname";
  }
  return null;
}

/** Does `name` equal a person's display name or alias (ignoring case and accents)? */
export const sameName = (person: Row, name: string) => {
  const n = normName(name);
  return normName(String(person.display_name)) === n || (person.aliases ?? []).some((a: string) => normName(a) === n);
};

export interface NameReview {
  incoming: Row;
  status: "same" | "new" | "review";
  /** For "same": the existing person; for "review": the closest candidates. */
  matches: { person: Row; reason: string }[];
}

/** Classify each incoming person against the project's people list. */
export function reviewNames(incoming: Row[], existing: Row[]): NameReview[] {
  return incoming.map((p) => {
    const byId = existing.find((e) => e.id === p.id);
    if (byId) return { incoming: p, status: "same" as const, matches: [{ person: byId, reason: "same person" }] };
    const names = [String(p.display_name), ...(p.aliases ?? [])];
    const same = existing.find((e) => names.some((n) => sameName(e, n)));
    if (same) return { incoming: p, status: "same" as const, matches: [{ person: same, reason: "same name" }] };
    const near = existing
      .map((e) => ({ person: e, reason: names.map((n) => [String(e.display_name), ...(e.aliases ?? [])].map((m) => nearMatch(n, m)).find(Boolean)).find(Boolean) ?? null }))
      .filter((m): m is { person: Row; reason: string } => !!m.reason);
    return near.length ? { incoming: p, status: "review" as const, matches: near } : { incoming: p, status: "new" as const, matches: [] };
  });
}
