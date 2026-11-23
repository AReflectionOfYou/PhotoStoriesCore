// "START HERE.html": a browsable page for an export bundle. Like every renderer
// it is made from the bundle alone, so it can also be added to (or regenerated
// in) a bundle made earlier.
//
// The page is one self-contained file at the top of the bag (an extra BagIt
// tag file, listed in tagmanifest-sha256.txt). Its data is embedded, and it
// refers to photos and recordings by relative paths into data/, so it works
// straight from the unzipped folder in any browser, with no internet.
//
// It matches the shared online app's viewer (family-photo-stories-worker 1.0.0)
// and adds: thumbnails, previous/next with arrow keys, Escape back to the grid,
// an optional face-box toggle, notes, and the copyright and license footer.

import { join, readJson, writeText, type FileAdapter } from "./adapter.ts";
import { storyWords } from "./schema.ts";
import type { Row } from "./util.ts";

export const VIEWER_FILE = "START HERE.html";
export const COPYRIGHT = { year: "2026", holder: "Michael A. Heroux" };

const CERTAINTY: Record<string, string> = { sure: "sure", likely: "think so", guess: "guessing" };

/** The trimmed, readable data the page shows. */
export async function viewerData(fs: FileAdapter, bag: string) {
  const data = join(bag, "data");
  const json = <T = any>(p: string) => readJson<T>(fs, join(data, p));
  const opt = async (p: string, fallback: unknown): Promise<any> => ((await fs.exists(join(data, p))) ? json(p) : fallback);
  const [group, manifest, people, collections, events, contributors] = await Promise.all([
    json("group.json"), opt("manifest.json", {}), opt("people.json", []), opt("collections.json", []), opt("events.json", []), opt("contributors.json", []),
  ]);
  const personName = new Map<string, string>(people.map((p: Row) => [p.id, p.display_name]));
  const byId = new Map<string, Row>(contributors.map((c: Row) => [c.id, c]));
  // Someone who joined twice shows under one name.
  const who = (id: string) => byId.get(byId.get(id)?.merged_into ?? id)?.display_name ?? byId.get(id)?.display_name ?? "Someone";
  const eventName = new Map<string, string>(events.map((e: Row) => [e.id, e.name]));

  const dirs = (await fs.exists(join(data, "photos"))) ? (await fs.list(join(data, "photos"))).filter((d) => d.isDirectory).map((d) => d.name).sort() : [];
  const photos = [];
  for (const id of dirs) {
    if (!(await fs.exists(join(data, "photos", id, "photo.json")))) continue;
    const doc = await json(`photos/${id}/photo.json`);
    const p = doc.photo as Row;
    const f = (doc.details ?? {}) as Row;
    const files = (doc.files ?? {}) as Row;
    const base = `data/photos/${id}/`;
    const detail = (label: string, text: unknown, certainty?: unknown) => (text ? { label, text: String(text), sure: CERTAINTY[String(certainty)] ?? "" } : null);
    const contributions = ((doc.contributions ?? []) as Row[]).filter((c) => !c.deleted_at).map((c) => {
      const audio = (files.audio ?? {})[c.id] as Row | undefined;
      return {
        id: c.id,
        parent: c.parent_id ?? null,
        kind: ({ story: "Story", followup_answer: "Answer", memory: "Memory", comment: "Comment" } as Record<string, string>)[c.kind] ?? "Story",
        who: who(c.contributor_id),
        date: String(c.created_at).slice(0, 10),
        question: c.kind === "followup_answer" ? c.prompt_text : "",
        words: storyWords(c),
        corrected: !c.story_text && !!c.transcript_edited_text,
        typed: c.typed_text ?? "",
        audio: audio ? { flac: audio.archive ? base + audio.archive : "", original: audio.original ? base + audio.original : "", mime: c.audio_original_mime ?? "" } : null,
      };
    });
    const liveFaces = ((doc.faces ?? []) as Row[]).filter((x) => !x.dismissed && (x.image ?? "front") === "front");
    const faceNames = liveFaces.filter((x) => x.person_id).map((x) => personName.get(x.person_id)).filter(Boolean);
    const inPhoto = ((doc.people_in_photo ?? []) as Row[]).filter((x) => !x.removed_at).map((x) => personName.get(x.person_id)).filter(Boolean);
    const image = files.image ? base + files.image : files.original ? base + files.original : "";
    photos.push({
      id,
      order: String(p.created_at),
      collection: p.collection_id,
      event: p.event_id ? (eventName.get(p.event_id) ?? "") : "",
      added: String(p.created_at).slice(0, 10),
      addedBy: p.created_by ? who(p.created_by) : "",
      hidden: !!p.hidden,
      image,
      thumb: files.thumb ? base + files.thumb : image,
      back: files.back_image ? base + files.back_image : files.back_original ? base + files.back_original : "",
      caption: f.caption ?? "",
      people: [...new Set([...inPhoto, ...faceNames])],
      // Face boxes are drawn on image.jpg only, and only when it is the edited copy they were measured on.
      faces: files.image ? liveFaces.map((x) => ({ x: +x.bbox_x, y: +x.bbox_y, w: +x.bbox_w, h: +x.bbox_h, name: x.person_id ? (personName.get(x.person_id) ?? "") : "" })) : [],
      details: [
        detail("When", f.date_text ?? f.date_edtf, f.date_certainty),
        detail("Where", f.place_text, f.place_certainty),
        detail("What was happening", f.event_text, f.event_certainty),
        detail("Who took it", f.photographer_text, f.photographer_certainty),
        detail("Where the print is kept", f.original_location_text, f.original_location_certainty),
      ].filter(Boolean),
      notes: f.notes ?? "",
      contributions,
    });
  }
  // In the order they were added.
  photos.sort((a, b) => a.order.localeCompare(b.order) || a.id.localeCompare(b.id));
  return {
    family: group.name,
    // What this download holds, when it isn't everything.
    contents: manifest.contents && manifest.contents !== "the whole family project" && manifest.contents !== "the whole project" ? String(manifest.contents) : "",
    madeOn: String(manifest.exported_at ?? "").slice(0, 10),
    collections: collections.map((c: Row) => ({ id: c.id, name: c.name })),
    photos,
  };
}

/** Write START HERE.html at the top of the bag. */
export async function writeViewer(fs: FileAdapter, bag: string) {
  const data = await viewerData(fs, bag);
  await writeText(fs, join(bag, VIEWER_FILE), viewerPage(data));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

export function viewerPage(data: Awaited<ReturnType<typeof viewerData>>): string {
  // Keep the embedded JSON from ever closing the <script> element early.
  const embedded = JSON.stringify(data).replace(/</g, "\\u003c");
  const family = String(data.family ?? "Photo Stories");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(family)}: family photo stories</title>
<style>
:root { --bg: #fbf8f2; --surface: #ffffff; --text: #1c1b19; --muted: #4a4740; --accent: #2f4a3a; --accent-text: #fff; --line: #d8d2c4; --warn: #9b1c1c; color-scheme: light dark; font-size: 20px; }
@media (prefers-color-scheme: dark) { :root { --bg: #161513; --surface: #23211e; --text: #f4f1ea; --muted: #c9c4b8; --accent: #9fd0b2; --accent-text: #10201a; --line: #3a3833; --warn: #ff9b9b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; line-height: 1.5; }
main { max-width: 64rem; margin: 0 auto; padding: 24px 20px 48px; display: flex; flex-direction: column; gap: 20px; }
h1 { font-size: 1.7rem; line-height: 1.2; margin: 0; color: var(--accent); }
h2 { font-size: 1.25rem; margin: 0; }
p { margin: 0; }
.muted { color: var(--muted); }
button, select, input { font: inherit; min-height: 52px; border-radius: 12px; }
button { border: 2px solid var(--accent); background: var(--surface); color: var(--accent); font-weight: 600; padding: 0 1.1rem; cursor: pointer; }
button.primary { background: var(--accent); color: var(--accent-text); }
button:disabled { opacity: 0.4; cursor: default; }
input, select { border: 2px solid var(--muted); background: var(--surface); color: var(--text); padding: 0 0.8rem; width: 100%; }
:focus-visible { outline: 3px solid #b45309; outline-offset: 3px; }
.tools { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 12px; }
@media (max-width: 600px) { .tools { grid-template-columns: 1fr; } }
label { display: flex; flex-direction: column; gap: 4px; font-weight: 600; }
.grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 14px; }
.grid a { display: flex; flex-direction: column; gap: 6px; color: var(--text); text-decoration: none; }
.grid img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 10px; background: var(--surface); border: 1px solid var(--line); }
.grid .cap { font-size: 0.85rem; line-height: 1.3; }
.badge { display: inline-block; font-size: 0.75rem; padding: 1px 8px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); }
.notice { border-left: 6px solid var(--warn); background: var(--surface); padding: 14px 16px; border-radius: 8px; display: flex; flex-direction: column; gap: 8px; }
.photo { display: flex; flex-direction: column; gap: 16px; }
.frame { position: relative; align-self: center; max-width: 100%; line-height: 0; }
.frame img.big { display: block; max-width: 100%; max-height: 75vh; width: auto; height: auto; object-fit: contain; background: var(--surface); border-radius: 10px; }
.face { position: absolute; border: 3px solid #f5c542; border-radius: 6px; box-shadow: 0 0 0 1px #000a; pointer-events: none; }
.face span { position: absolute; left: -3px; top: 100%; margin-top: 4px; background: #000c; color: #fff; font-size: 0.7rem; line-height: 1.3; padding: 1px 6px; border-radius: 4px; white-space: nowrap; }
.nav { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
.story .answer { margin-left: 12px; border-left: 4px solid var(--line); padding-left: 12px; display: flex; flex-direction: column; gap: 6px; }
audio { width: 100%; }
.words { white-space: pre-wrap; }
.row { display: flex; flex-wrap: wrap; gap: 10px; }
a { color: var(--accent); }
footer { max-width: 64rem; margin: 0 auto; padding: 0 20px 28px; color: var(--muted); font-size: 0.7rem; line-height: 1.5; }
footer a { color: inherit; }
</style>
</head>
<body>
<main id="app">
  <h1>${esc(family)}</h1>
  <p>Loading the family's photos…</p>
  <noscript><p class="notice">This page needs JavaScript, which your browser has turned off. You can still open the photos directly: they're in the <b>data/photos</b> folder (each photo's <b>image.jpg</b>).</p></noscript>
</main>
<footer>Copyright ${COPYRIGHT.year} ${COPYRIGHT.holder}. This page's code is under the <a href="https://opensource.org/license/mit">MIT License</a>; its documents and visual design are under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. The photos and stories belong to the people who shared them.</footer>
<script type="application/json" id="data">${embedded}</script>
<script>
(function () {
  var D = JSON.parse(document.getElementById("data").textContent);
  var app = document.getElementById("app");
  var state = { q: "", collection: "", showHidden: false, faces: false };
  var brokenImages = 0, loadedImages = 0;

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) { if (k === "text") e.textContent = attrs[k]; else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function img(src, alt, cls) {
    var i = el("img", { src: src, alt: alt, loading: "lazy" });
    if (cls) i.className = cls;
    i.addEventListener("load", function () { loadedImages++; });
    i.addEventListener("error", function () { i.style.visibility = "hidden"; brokenImages++; if (brokenImages >= 3 && loadedImages === 0) unzipWarning(); });
    return i;
  }
  var warned = false;
  function unzipWarning() {
    if (warned) return; warned = true;
    app.insertBefore(el("div", { class: "notice", role: "alert" }, [
      el("h2", { text: "Please unzip the archive first" }),
      el("p", { text: "The photos can't be shown because this page was opened from inside the zipped file." }),
      el("p", { text: "On Windows: close this page, right-click the downloaded .zip file, choose Extract All, then open the new folder and double-click START HERE." }),
      el("p", { text: "On a Mac: double-click the .zip file to unzip it, then open the new folder and double-click START HERE." }),
      el("p", { text: "On a phone or tablet, please use a computer instead: phones usually can't open this page properly." })
    ]), app.firstChild);
  }
  function day(iso) { return iso ? new Date(iso + "T12:00:00").toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : ""; }
  var collectionName = {};
  D.collections.forEach(function (c) { collectionName[c.id] = c.name; });
  function label(p) { return p.caption || (p.people.length ? p.people.join(", ") : "") || [p.details[0] && p.details[0].text, p.details[1] && p.details[1].text].filter(Boolean).join(", ") || "A family photo"; }
  function haystack(p) {
    return [p.caption, p.event, p.notes, collectionName[p.collection]].concat(p.people, p.details.map(function (d) { return d.text; }), p.contributions.map(function (c) { return c.who + " " + c.words + " " + c.typed; })).join(" ").toLowerCase();
  }
  function visible() {
    return D.photos.filter(function (p) {
      return (state.showHidden || !p.hidden) && (!state.collection || p.collection === state.collection) && (!state.q || haystack(p).indexOf(state.q.toLowerCase()) >= 0);
    });
  }

  function home() {
    var hiddenCount = D.photos.filter(function (p) { return p.hidden; }).length;
    var search = el("input", { id: "q", type: "search", value: state.q, placeholder: "A name, a place, a year…" });
    search.addEventListener("input", function () { state.q = search.value; renderGrid(); });
    var pick = el("select", { id: "collection" }, [el("option", { value: "", text: "All of them" })].concat(D.collections.map(function (c) { return el("option", { value: c.id, text: c.name }); })));
    pick.value = state.collection;
    pick.addEventListener("change", function () { state.collection = pick.value; renderGrid(); });
    var grid = el("ul", { class: "grid" });
    var count = el("p", { class: "muted" });
    function renderGrid() {
      var shown = visible();
      grid.textContent = "";
      shown.forEach(function (p) {
        grid.appendChild(el("li", {}, [el("a", { href: "#photo-" + p.id }, [
          img(p.thumb, "", ""), el("span", { class: "cap", text: label(p) }), p.hidden ? el("span", { class: "badge", text: "Hidden by the family" }) : null
        ])]));
      });
      count.textContent = shown.length === 1 ? "1 photo" : shown.length + " photos";
    }
    renderGrid();
    var kids = [
      el("h1", { text: D.family }),
      D.contents ? el("p", { class: "notice", text: "This copy holds only some of the family's photos: " + D.contents + "." }) : null,
      el("p", { class: "muted", text: D.photos.length + " photos and their stories" + (D.madeOn ? ", saved on " + day(D.madeOn) : "") + ". This page works without internet. Keep this whole folder together." }),
      el("div", { class: "tools" }, [el("label", { for: "q" }, ["Find", search]), D.collections.length > 1 ? el("label", { for: "collection" }, ["Box or album", pick]) : null]),
      count, grid
    ];
    if (hiddenCount) kids.push(el("button", { onclick: function () { state.showHidden = !state.showHidden; render(); } }, [state.showHidden ? "Leave out the photos the family hid" : "Also show the " + hiddenCount + " photo" + (hiddenCount === 1 ? "" : "s") + " the family hid"]));
    return kids;
  }

  function go(p) { location.hash = p ? "#photo-" + p.id : "#"; }
  function neighbours(p) {
    var list = visible(), i = list.indexOf(p);
    if (i < 0) { list = D.photos; i = list.indexOf(p); }
    return { prev: i > 0 ? list[i - 1] : null, next: i >= 0 && i < list.length - 1 ? list[i + 1] : null, at: i + 1, of: list.length };
  }

  function photo(p) {
    var showBack = false;
    var n = neighbours(p);
    var big = img(p.image, label(p), "big");
    var frame = el("div", { class: "frame" }, [big]);
    function drawFaces() {
      Array.prototype.slice.call(frame.querySelectorAll(".face")).forEach(function (f) { f.remove(); });
      if (!state.faces || showBack) return;
      p.faces.forEach(function (f) {
        frame.appendChild(el("div", { class: "face", style: "left:" + f.x * 100 + "%;top:" + f.y * 100 + "%;width:" + f.w * 100 + "%;height:" + f.h * 100 + "%" }, [f.name ? el("span", { text: f.name }) : null]));
      });
    }
    var kids = [
      el("div", { class: "nav" }, [
        el("a", { href: "#", text: "\\u2190 All the photos" }),
        el("div", { class: "row" }, [
          el("button", { onclick: function () { go(n.prev); }, "aria-label": "Previous photo" }, ["\\u2039 Previous"]),
          el("span", { class: "muted", style: "align-self:center", text: n.at + " of " + n.of }),
          el("button", { onclick: function () { go(n.next); }, "aria-label": "Next photo" }, ["Next \\u203a"])
        ])
      ]),
      el("h1", { text: label(p) }),
      p.hidden ? el("p", { class: "notice", text: "The family chose to hide this photo for now." }) : null,
      frame
    ];
    var navButtons = kids[0].querySelectorAll("button");
    if (!n.prev) navButtons[0].disabled = true;
    if (!n.next) navButtons[1].disabled = true;
    var controls = el("div", { class: "row" });
    if (p.back) controls.appendChild(el("button", { onclick: function (e) { showBack = !showBack; big.src = showBack ? p.back : p.image; e.currentTarget.textContent = showBack ? "Show the front" : "Show the back of the print"; drawFaces(); } }, ["Show the back of the print"]));
    if (p.faces.length) controls.appendChild(el("button", { "aria-pressed": String(state.faces), onclick: function (e) { state.faces = !state.faces; e.currentTarget.setAttribute("aria-pressed", String(state.faces)); e.currentTarget.textContent = state.faces ? "Hide face boxes" : "Show face boxes"; drawFaces(); } }, [state.faces ? "Hide face boxes" : "Show face boxes"]));
    if (controls.childNodes.length) kids.push(controls);
    drawFaces();
    var details = [el("h2", { text: "Details" })];
    if (p.people.length) details.push(el("p", {}, [el("b", { text: "Who: " }), p.people.join(", ")]));
    p.details.forEach(function (d) { details.push(el("p", {}, [el("b", { text: d.label + ": " }), d.text, d.sure ? el("span", { class: "muted", text: " (" + d.sure + ")" }) : null])); });
    if (p.event) details.push(el("p", {}, [el("b", { text: "Occasion: " }), p.event]));
    if (p.notes) details.push(el("p", { class: "words" }, [el("b", { text: "Notes: " }), p.notes]));
    details.push(el("p", { class: "muted", text: "In \\u201c" + (collectionName[p.collection] || "the family's photos") + "\\u201d. Added " + day(p.added) + (p.addedBy ? " by " + p.addedBy : "") + "." }));
    kids.push(el("section", { class: "card" }, details));

    kids.push(el("h2", { text: "Stories and memories" }));
    var top = p.contributions.filter(function (c) { return !c.parent; });
    if (!top.length) kids.push(el("p", { class: "muted", text: "No stories were recorded for this photo." }));
    top.forEach(function (c) {
      var card = storyCard(c);
      p.contributions.filter(function (a) { return a.parent === c.id; }).forEach(function (a) { card.appendChild(el("div", { class: "answer" }, storyBody(a))); });
      kids.push(card);
    });
    return kids;
  }
  function storyBody(c) {
    var out = [el("p", {}, [el("b", { text: c.who }), el("span", { class: "muted", text: " \\u00b7 " + c.kind + " \\u00b7 " + day(c.date) })])];
    if (c.question) out.push(el("p", { class: "muted", text: "Answering: \\u201c" + c.question + "\\u201d" }));
    if (c.audio) {
      var a = el("audio", { controls: "", preload: "none" });
      if (c.audio.flac) a.appendChild(el("source", { src: c.audio.flac, type: "audio/flac" }));
      if (c.audio.original) a.appendChild(el("source", { src: c.audio.original, type: c.audio.mime || "" }));
      out.push(a);
    }
    if (c.words) out.push(el("p", { class: "words", text: c.words }));
    if (c.corrected) out.push(el("p", { class: "muted", text: "Words corrected by the speaker." }));
    if (c.typed) out.push(el("p", { class: "words", text: c.typed }));
    return out;
  }
  function storyCard(c) { return el("article", { class: "card story" }, storyBody(c)); }

  var current = null;
  function render() {
    var m = /^#photo-(.+)$/.exec(location.hash);
    var p = m && D.photos.filter(function (x) { return x.id === m[1]; })[0];
    current = p || null;
    app.textContent = "";
    (p ? photo(p) : home()).forEach(function (k) { if (k) app.appendChild(k); });
    if (warned) { warned = false; unzipWarning(); }
    window.scrollTo(0, 0);
  }
  document.addEventListener("keydown", function (e) {
    if (!current || e.altKey || e.ctrlKey || e.metaKey) return;
    var t = e.target && e.target.tagName;
    if (t === "INPUT" || t === "SELECT" || t === "TEXTAREA" || t === "AUDIO") return;
    var n = neighbours(current);
    if (e.key === "ArrowLeft" && n.prev) { e.preventDefault(); go(n.prev); }
    else if (e.key === "ArrowRight" && n.next) { e.preventDefault(); go(n.next); }
    else if (e.key === "Escape") { e.preventDefault(); go(null); }
  });
  window.addEventListener("hashchange", render);
  render();
})();
</script>
</body>
</html>
`;
}
