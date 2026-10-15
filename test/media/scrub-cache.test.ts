// D221: the scrub frame cache's pure parts (apps/web/src/preview/scrub.ts): the LRU's byte bound and
// eviction order (closing what it drops), the decode window in the direction of travel, the frame
// size cap, the file-changed check on range responses, and media ids of preview URLs (a media item
// played from another URL drops the old frames).
import { test } from "node:test";
import assert from "node:assert/strict";

import { cachedSize, decoderColour, FrameLru, liftsTone, mediaIdOf, sameFile, SCRUB_BUDGET, SCRUB_MAX_SIDE, windowRanks } from "../../apps/web/src/preview/scrub.ts";

test("D221: the LRU never holds more than its budget, drops the least recently used first and closes it", () => {
  const closed: Array<string> = [];
  const lru = new FrameLru<string>(100);
  const put = (k: string, bytes: number) => lru.put(k, k, bytes, () => closed.push(k));
  put("a", 40);
  put("b", 40);
  assert.equal(lru.get("a"), "a", "a is now the most recent");
  put("c", 40);
  assert.deepEqual(closed, ["b"], "b was the least recently used");
  assert.ok(lru.bytes <= 100);
  assert.equal(lru.has("a") && lru.has("c"), true);
  // Replacing a key closes the old value and counts the new size.
  put("a", 10);
  assert.deepEqual(closed, ["b", "a"]);
  assert.equal(lru.bytes, 50);
  // Bigger than the whole budget: refused and closed at once.
  assert.equal(put("huge", 101), false);
  assert.equal(lru.has("huge"), false);
  assert.equal(closed.at(-1), "huge");
  // A smaller budget evicts at once; dropWhere closes what matches.
  lru.setBudget(30);
  assert.ok(lru.bytes <= 30);
  put("x|1", 5);
  put("x|2", 5);
  lru.dropWhere((k) => k.startsWith("x|"));
  assert.equal(lru.has("x|1") || lru.has("x|2"), false);
  // A long random run stays within the budget and closes every value it lets go.
  const big = new FrameLru<number>(SCRUB_BUDGET);
  let live = 0;
  let seed = 7;
  for (let i = 0; i < 5000; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const bytes = 1 + (seed % (12 * 1024 * 1024));
    live++;
    big.put(`k${seed % 400}`, i, bytes, () => live--);
    assert.ok(big.bytes <= SCRUB_BUDGET, `${big.bytes} over the budget at step ${i}`);
  }
  assert.equal(live, big.size, "every dropped value was closed exactly once");
  big.clear();
  assert.equal(big.bytes, 0);
  assert.equal(live, 0);
});

test("D221: the decode window leads in the direction of travel, nearest first", () => {
  assert.deepEqual(windowRanks(10, 100, 1, 4), [10, 11, 9, 12, 8, 13, 14]);
  assert.deepEqual(windowRanks(10, 100, -1, 4), [10, 9, 11, 8, 12, 7, 6]);
  assert.deepEqual(windowRanks(10, 100, 0, 4), [10, 11, 9, 12, 8]);
  assert.deepEqual(windowRanks(0, 3, -1, 4), [0, 1, 2]);
  assert.deepEqual(windowRanks(2, 3, 1, 4), [2, 1, 0]);
});

test("D221: cached frames are capped on their long side; a changed file is noticed on any range read", () => {
  assert.deepEqual(cachedSize(1280, 720), { w: 1280, h: 720 });
  assert.deepEqual(cachedSize(3840, 2160), { w: SCRUB_MAX_SIDE, h: 1080 });
  assert.deepEqual(cachedSize(2160, 3840), { w: 1080, h: SCRUB_MAX_SIDE });
  const known = { size: 1000, modified: "Wed, 15 Oct 2026 10:00:00 GMT" };
  assert.equal(sameFile(known, "bytes 0-15/1000", "Wed, 15 Oct 2026 10:00:00 GMT"), true);
  assert.equal(sameFile(known, "bytes 0-15/1001", "Wed, 15 Oct 2026 10:00:00 GMT"), false, "another size");
  assert.equal(sameFile(known, "bytes 0-15/1000", "Wed, 15 Oct 2026 10:00:01 GMT"), false, "rewritten");
  assert.equal(sameFile(known, null, null), true, "no headers to tell");
});

test("D221: an original and its proxy are the same media item (switching drops the other's frames)", () => {
  const a = mediaIdOf("http://127.0.0.1:5000/media/file/m-drone?token=t&v=abc");
  const b = mediaIdOf("http://127.0.0.1:5000/media/proxy/m-drone?token=t&v=key");
  assert.equal(a, "m-drone");
  assert.equal(a, b);
});

test("D221: footage decodes in the colour space the <video> shows it in, and BT.709 is the one macOS lifts", () => {
  // Says nothing: BT.601 below 720 lines, BT.709 from there (Chromium's guess, measured).
  assert.deepEqual(decoderColour({}, 180), { matrix: "smpte170m", primaries: "smpte170m", transfer: "smpte170m", fullRange: false });
  assert.deepEqual(decoderColour({}, 720), { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: false });
  // Says it: kept, full range too.
  assert.deepEqual(decoderColour({ primaries: 1, transfer: 1, matrix: 1, fullRange: true }, 360), { matrix: "bt709", primaries: "bt709", transfer: "bt709", fullRange: true });
  assert.deepEqual(decoderColour({ matrix: 5 }, 1080), { matrix: "bt470bg", primaries: "smpte170m", transfer: "bt709", fullRange: false });
  // A code WebCodecs has no name for, or a stream that didn't parse: WebCodecs' own reading.
  assert.equal(decoderColour({ matrix: 4 }, 1080), undefined);
  assert.equal(decoderColour(undefined, 1080), undefined);
  assert.equal(liftsTone({}, 1080), true);
  assert.equal(liftsTone({}, 360), false);
  assert.equal(liftsTone({ transfer: 1 }, 360), true);
  assert.equal(liftsTone({ transfer: 13 }, 1080), false, "sRGB");
  assert.equal(liftsTone({ transfer: 6 }, 1080), false, "BT.601");
});
