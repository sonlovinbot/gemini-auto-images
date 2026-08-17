import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const dist = path.join(root, "dist");
const stage = path.join(dist, `auto-gemini-images-${manifest.version}`);
const output = path.join(dist, `auto-gemini-images-${manifest.version}.zip`);
const entries = ["manifest.json", "background.js", "config", "content", "sidepanel", "src", "assets/icons"];

await mkdir(dist, { recursive: true });
await rm(stage, { recursive: true, force: true });
await rm(output, { force: true });
await mkdir(stage, { recursive: true });

for (const entry of entries) {
  await cp(path.join(root, entry), path.join(stage, entry), { recursive: true });
}

const zipped = spawnSync("zip", ["-q", "-r", output, "."], { cwd: stage, stdio: "inherit" });
if (zipped.status !== 0) process.exit(zipped.status ?? 1);

console.log(output);
