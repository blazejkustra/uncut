// Builds uncut-vision (the Apple Vision helper of plugins/apple-vision) into native/vision/out: one
// universal binary (arm64 and x86_64, macOS 13 or later) from Sources/*.swift with swiftc from
// Xcode's command line tools, stripped and ad-hoc signed. Used by pnpm build and dev; the packaged
// app ships it as Resources/bin/uncut-vision.
//   node native/vision/build.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HERE = import.meta.dirname;
const OUT = join(HERE, "out");
const WORK = join(OUT, "work");
const BINARY = join(OUT, "uncut-vision");
const MACOS_TARGET = "13.0";
const ARCHES = ["arm64", "x86_64"];

const run = (command: string, args: ReadonlyArray<string>) => execFileSync(command, args, { cwd: HERE, stdio: "inherit" });

function compile(arch: string, sources: ReadonlyArray<string>) {
  const out = join(WORK, `uncut-vision-${arch}`);
  run("xcrun", [
    "swiftc",
    "-O",
    "-swift-version",
    "5",
    "-target",
    `${arch}-apple-macos${MACOS_TARGET}`,
    "-file-prefix-map",
    `${HERE}=uncut-vision`,
    "-file-prefix-map",
    `${homedir()}=~`,
    "-o",
    out,
    ...sources,
  ]);
  return out;
}

if (process.platform !== "darwin") throw new Error("uncut-vision is built on macOS (Apple Vision).");
const sources = readdirSync(join(HERE, "Sources"))
  .filter((f) => f.endsWith(".swift"))
  .map((f) => join(HERE, "Sources", f));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const slices = ARCHES.map((arch) => compile(arch, sources));
run("lipo", ["-create", "-output", BINARY, ...slices]);
rmSync(WORK, { recursive: true, force: true });
run("strip", ["-x", BINARY]);
run("codesign", ["--force", "--sign", "-", BINARY]);
console.log(`Built ${BINARY}`);
