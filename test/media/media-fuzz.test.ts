// A repeatable fuzz run against the release `uncut-media`: thousands of seeded mutations of
// real (small, generated) files go through the helper in batches, the way the server sends
// them. Every request must get a reply, the helper must survive, and it must stay small and fast.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const BIN = resolve("native/media/target/release/uncut-media");
const hasFfmpeg = !spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).error;
const skip = !existsSync(BIN) ? "media core not built (run pnpm build)" : !hasFfmpeg ? "needs ffmpeg to make seed files" : false;
const MUTATIONS = 20000;
const BATCH = 250;

// The 64-byte file that once overflowed the box walker.
const OVERFLOW = Buffer.from(
  "000000106674797069736f6d00000000000000306d6f6f760000000866726565000000017472616bfffffffffffffff800000000000000000000000000000000",
  "hex",
);

let dir: string;
const seeds: Array<Buffer> = [];
before(() => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "uncut-fuzz-"));
  const ff = (...args: Array<string>) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
  const make = (name: string, ...args: Array<string>) => {
    ff(...args, join(dir, name));
    seeds.push(readFileSync(join(dir, name)));
  };
  make(
    "v.mp4",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=160x120:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=duration=0.5",
    "-t",
    "0.5",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
  );
  make("v.mov", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=25", "-t", "0.4", "-c:v", "libx264");
  make("frag.mp4", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=30", "-t", "0.5", "-c:v", "libx264", "-movflags", "frag_keyframe+empty_moov");
  make("a.m4a", "-f", "lavfi", "-i", "sine=duration=0.5", "-c:a", "aac");
  make("i.png", "-f", "lavfi", "-i", "testsrc=size=64x48", "-frames:v", "1");
  make("i.jpg", "-f", "lavfi", "-i", "testsrc=size=64x48", "-frames:v", "1");
  seeds.push(OVERFLOW);
});
after(() => dir && rmSync(dir, { recursive: true, force: true }));

function* mutations(seed: number) {
  let x = BigInt(seed) | 1n;
  const rnd = () => {
    x ^= (x << 13n) & 0xffffffffffffffffn;
    x ^= x >> 7n;
    x ^= (x << 17n) & 0xffffffffffffffffn;
    return Number(x & 0xffffffffn);
  };
  const extremes = [0, 1, 7, 8, 16, 0xffffffff, 0x7fffffff, 0x80000000];
  for (let i = 0; ; i++) {
    const f = Buffer.from(seeds[i % seeds.length]!);
    let out = f;
    for (let k = 0, n = 1 + (rnd() % 4); k < n; k++) {
      const at = rnd() % out.length;
      switch (rnd() % 5) {
        case 0:
          out[at] = rnd() & 0xff;
          break;
        case 1:
          if (at + 4 <= out.length) out.writeUInt32BE(extremes[rnd() % extremes.length]!, at);
          break;
        case 2:
          out = out.subarray(0, Math.max(1, at));
          break;
        case 3:
          out = Buffer.concat([out.subarray(0, at), out.subarray(at, at + 64), out.subarray(at)]);
          break;
        default:
          out.fill(0xff, at, Math.min(out.length, at + 8));
      }
    }
    yield out;
  }
}

/** One helper, `paths.length` requests: replies, how long, and the helper's peak memory. */
interface Batch {
  replies: Array<any>;
  code: number | null;
  signal: NodeJS.Signals | null;
  peakKb: number;
}

function runBatch(paths: ReadonlyArray<string>) {
  return new Promise<Batch>((resolveBatch, reject) => {
    // /usr/bin/time -l reports the helper's peak resident memory when it exits.
    const child = spawn("/usr/bin/time", ["-l", BIN], { stdio: ["pipe", "pipe", "pipe"] });
    const replies: Array<any> = [];
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`batch hung after ${replies.length}/${paths.length} replies`));
    }, 20000);
    createInterface({ input: child.stdout }).on("line", (line) => replies.push(JSON.parse(line)));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const peakKb = Number(/(\d+)\s+maximum resident set size/.exec(stderr)?.[1] ?? 0) / 1024;
      resolveBatch({ replies, code, signal, peakKb });
    });
    child.stdin.end(paths.map((path, id) => `${JSON.stringify({ id, method: "probe", params: { path } })}\n`).join(""));
  });
}

test(`${MUTATIONS} seeded mutations: every request answered, no crash, no hang, small memory`, { skip, timeout: 60000 }, async () => {
  const gen = mutations(20261011);
  const started = Date.now();
  let worstKb = 0;
  const outcomes: Record<string, number> = {};
  for (let done = 0; done < MUTATIONS; done += BATCH) {
    const paths: Array<string> = [];
    for (let i = 0; i < BATCH; i++) {
      const path = join(dir, `m${i}.bin`);
      writeFileSync(path, gen.next().value!);
      paths.push(path);
    }
    const { replies, code, signal, peakKb } = await runBatch(paths);
    assert.equal(signal, null, `helper killed by ${signal} in batch at ${done}`);
    assert.equal(code, 0, `helper exited ${code} in batch at ${done}`);
    assert.equal(replies.length, BATCH, `batch at ${done}: ${replies.length} replies`);
    assert.deepEqual(
      replies.map((r: any) => r.id),
      paths.map((_, i) => i),
    );
    for (const r of replies) {
      const key = r.result ? `ok:${r.result.kind}` : `error:${r.error.code}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      assert.ok(r.result || ["unsupported", "unreadable", "not-found"].includes(r.error.code), JSON.stringify(r));
    }
    worstKb = Math.max(worstKb, peakKb);
  }
  const ms = Date.now() - started;
  console.log(`# fuzz: ${MUTATIONS} mutations in ${ms} ms, peak helper RSS ${(worstKb / 1024).toFixed(1)} MB, outcomes ${JSON.stringify(outcomes)}`);
  assert.ok(ms < 30000, `took ${ms} ms`);
  assert.ok(worstKb < 300 * 1024, `peak RSS ${worstKb} KB`);
});
