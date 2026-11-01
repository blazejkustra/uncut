// The footage index's storage and search: passages with word timecodes, ranking and fallbacks,
// visual descriptions, clips shared between projects, and pruning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FootageStore, matchedWords, PASSAGE_WORDS, speechPassages, termsOf, type Place } from "../../apps/server/src/footage/footageStore.ts";

const timed = (text: string, from = 0) => text.split(" ").map((word, i) => ({ text: word, start: from + i, end: from + i + 0.5 }));

const place = (over: Partial<Place> & { fingerprint: string }): Place => ({
  dir: "/p/one.uncut",
  project: "One",
  mediaId: over.fingerprint,
  path: `/footage/${over.fingerprint}.mp4`,
  stamp: "1:1",
  name: `${over.fingerprint}.mp4`,
  kind: "video",
  ...over,
});

function storeWith(clips: Record<string, string>) {
  const store = new FootageStore(":memory:");
  for (const [fingerprint, text] of Object.entries(clips)) {
    store.setPlaces(`/p/${fingerprint}`, [place({ fingerprint, dir: `/p/${fingerprint}` })]);
    store.putSpeech(fingerprint, speechPassages(timed(text)));
  }
  return store;
}

test("a phrase across a passage seam is in one passage, and every word keeps its time", () => {
  const words = timed(Array.from({ length: 100 }, (_, i) => `w${i}`).join(" "));
  const passages = speechPassages(words);
  assert.ok(passages.length >= 3);
  for (const passage of passages) assert.equal(passage.times.length, passage.text.split(" ").length * 2);
  const seam = PASSAGE_WORDS - 1;
  assert.ok(passages.some((p) => p.text.includes(`w${seam} w${seam + 1}`)));
  assert.equal(passages.at(-1)!.text.split(" ").at(-1), "w99");
  assert.deepEqual(speechPassages([]), []);
});

test("search gives the matched words' timecodes with the words around them", () => {
  const store = storeWith({ a: "we shipped the new render pipeline on friday afternoon" });
  const [hit] = store.search({ query: "render pipeline", limit: 5 });
  assert.equal(hit!.match, "render pipeline");
  assert.equal(hit!.start, 4);
  assert.equal(hit!.end, 5.5);
  assert.equal(hit!.before, "we shipped the new");
  assert.equal(hit!.after, "on friday afternoon");
  assert.equal(hit!.places[0]!.path, "/footage/a.mp4");
});

test("words match by prefix, ignore case and diacritics, and fall back to any word", () => {
  const store = storeWith({ a: "Zażółć kamera nagrywa", b: "the deployment finished" });
  assert.equal(store.search({ query: "deploy", limit: 5 })[0]!.fingerprint, "b");
  assert.equal(store.search({ query: "KAMERA", limit: 5 })[0]!.match, "kamera");
  assert.equal(store.search({ query: "zazołc", limit: 5 })[0]!.fingerprint, "a");
  assert.equal(store.search({ query: "deployment nonsense", limit: 5 })[0]!.fingerprint, "b");
  assert.deepEqual(store.search({ query: "nothing", limit: 5 }), []);
  assert.deepEqual(store.search({ query: `*:"()`, limit: 5 }), []);
});

test("quotes make a phrase", () => {
  const store = storeWith({ a: "green tree by the river", b: "tree green" });
  assert.equal(store.search({ query: "green tree", limit: 5 }).length, 2);
  const exact = store.search({ query: '"green tree"', limit: 5 });
  assert.deepEqual(
    exact.map((hit) => hit.fingerprint),
    ["a"],
  );
});

test("overlapping passages give a moment once", () => {
  const filler = Array.from({ length: 35 }, (_, i) => `x${i}`).join(" ");
  const store = storeWith({ a: `${filler} needle ${filler}` });
  assert.equal(store.search({ query: "needle", limit: 5 }).length, 1);
});

test("a description is found with its range, and a new one replaces what it overlaps", () => {
  const store = storeWith({ a: "words" });
  store.putNotes("a", [{ start: 2, end: 6, text: "a red bicycle  on a bridge" }]);
  const [hit] = store.search({ query: "bicycle", limit: 5 });
  assert.equal(hit!.source, "visual");
  assert.equal(hit!.start, 2);
  assert.equal(hit!.end, 6);
  assert.equal(hit!.match, "a red bicycle on a bridge");
  store.putNotes("a", [{ start: 5, end: 8, text: "a blue car" }]);
  assert.deepEqual(store.search({ query: "bicycle", limit: 5 }), []);
  assert.equal(store.search({ query: "car", limit: 5 }).length, 1);
});

test("re-indexing a clip's speech replaces it and keeps its descriptions", () => {
  const store = storeWith({ a: "first version" });
  store.putNotes("a", [{ start: 0, end: 1, text: "sunset" }]);
  store.putSpeech("a", speechPassages(timed("second take")));
  assert.deepEqual(store.search({ query: "first", limit: 5 }), []);
  assert.equal(store.search({ query: "second", limit: 5 }).length, 1);
  assert.equal(store.search({ query: "sunset", limit: 5 }).length, 1);
});

test("a search can stay in one project; a copied clip is one clip in two places", () => {
  const store = new FootageStore(":memory:");
  store.setPlaces("/p/one", [place({ fingerprint: "shared", dir: "/p/one" }), place({ fingerprint: "own", dir: "/p/one" })]);
  store.setPlaces("/p/two", [place({ fingerprint: "shared", dir: "/p/two" })]);
  store.putSpeech("shared", speechPassages(timed("common words")));
  store.putSpeech("own", speechPassages(timed("common own")));
  assert.equal(store.search({ query: "common", limit: 5 }).length, 2);
  assert.deepEqual(
    store.search({ query: "common", dir: "/p/two", limit: 5 }).map((hit) => hit.fingerprint),
    ["shared"],
  );
  assert.equal(store.search({ query: "words", limit: 5 })[0]!.places.length, 2);
  assert.deepEqual(store.counts("/p/two"), { clips: 1, indexed: 1, everywhere: 2 });
});

test("pruning forgets gone projects and every trace of clips nobody holds", () => {
  const store = storeWith({ a: "keep this", b: "drop this" });
  store.putNotes("b", [{ start: 0, end: 1, text: "gone picture" }]);
  store.prune(["/p/b"]);
  assert.equal(store.isIndexed("b"), false);
  assert.deepEqual(store.search({ query: "drop", limit: 5 }), []);
  assert.deepEqual(store.search({ query: "picture", limit: 5 }), []);
  assert.equal(store.search({ query: "keep", limit: 5 }).length, 1);
});

test("a damaged file is started over", () => {
  const dir = mkdtempSync(join(tmpdir(), "uncut-footage-"));
  try {
    const file = join(dir, "footage-index.db");
    writeFileSync(file, "not a database, not at all, ".repeat(100));
    const store = new FootageStore(file);
    store.setPlaces("/p/a", [place({ fingerprint: "a", dir: "/p/a" })]);
    store.putSpeech("a", speechPassages(timed("back again")));
    assert.equal(store.search({ query: "back", limit: 5 }).length, 1);
    store.close();
    const reopened = new FootageStore(file);
    assert.equal(reopened.search({ query: "back", limit: 5 }).length, 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("matchedWords picks the tightest run", () => {
  assert.deepEqual(matchedWords("red car and a red bus".split(" "), termsOf("red bus")), [4, 5]);
  assert.equal(matchedWords(["nothing"], ["else"]), undefined);
});
