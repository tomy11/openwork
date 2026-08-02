import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Shot } from "./screenshot.ts";
import type { SeenFacts, SeenResult } from "./validate.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

interface RollFrame {
  caption: string;
  fileName: string;
  hash: string;
  route: string;
  at: string;
  description: string;
  model: string;
  ok: boolean | null;
  results: SeenResult[];
}

export interface Roll {
  dir: string;
  add(shot: Shot, seen?: SeenFacts): Promise<string>;
  close(): Promise<string>;
  [Symbol.asyncDispose](): Promise<void>;
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "frame";
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function frameCaption(name: string, sequence: number, seen?: SeenFacts): string {
  return seen?.results[0]?.expectation.trim() || `${name} frame ${sequence}`;
}

function gitValue(args: string[]): string {
  const result = spawnSync("git", ["rev-parse", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 && !result.error ? result.stdout.trim() : "";
}

export function photoRoll(name: string, opts: { outDir?: string } = {}): Roll {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = opts.outDir ?? join(REPO_ROOT, "evals", "results", "rolls", `${stamp}-${slug(name)}`);
  const frames: RollFrame[] = [];
  const hashes = new Map<string, string>();
  const createdAt = new Date().toISOString();
  const gitSha = gitValue(["HEAD"]);
  const branch = gitValue(["--abbrev-ref", "HEAD"]);
  let closedPath = "";

  const close = async (): Promise<string> => {
    if (closedPath) return closedPath;
    await mkdir(dir, { recursive: true });
    const expectationResults = frames.flatMap((frame) => frame.results);
    const summary = {
      ok: frames.length > 0 && frames.every((frame) => frame.ok === true),
      totalFrames: frames.length,
      passedFrames: frames.filter((frame) => frame.ok === true).length,
      failedFrames: frames.filter((frame) => frame.ok === false).length,
      unvalidatedFrames: frames.filter((frame) => frame.ok === null).length,
      passedExpectations: expectationResults.filter((result) => result.passed).length,
      failedExpectations: expectationResults.filter((result) => !result.passed).length,
    };
    const closedAt = new Date().toISOString();
    const payload = { name, dir, createdAt, closedAt, gitSha, branch, summary, frames };
    const frameMarkup = frames.map((frame) => `
      <article class="frame ${frame.ok === true ? "passed" : frame.ok === false ? "failed" : "unvalidated"}">
        <h2>${html(frame.caption)}</h2>
        <p class="meta">${html(frame.route)} · ${html(frame.at)}${frame.model ? ` · ${html(frame.model)}` : ""}</p>
        <img src="${html(frame.fileName)}" alt="${html(frame.caption)}">
        <p>${html(frame.description || "Not vision-validated.")}</p>
        <ul>${frame.results.map((result) => `<li class="${result.passed ? "pass" : "fail"}"><strong>${result.passed ? "PASS" : "FAIL"}</strong> ${html(result.expectation)} — ${html(result.evidence)}</li>`).join("")}</ul>
      </article>`).join("");
    const index = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(name)} photo roll</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;background:#f6f7f9;color:#17191d}header,.frame{background:white;border:1px solid #dfe2e8;border-radius:12px;padding:20px;margin:0 0 24px}.frame.passed{border-left:6px solid #238636}.frame.failed{border-left:6px solid #cf222e}.frame.unvalidated{border-left:6px solid #9a6700}img{display:block;width:100%;height:auto;border:1px solid #dfe2e8;border-radius:8px}.meta{color:#636c76}.pass strong{color:#1a7f37}.fail strong{color:#cf222e}li{margin:8px 0}
</style></head><body><header><h1>${html(name)}</h1><p>${summary.passedFrames}/${summary.totalFrames} frames passed; ${summary.failedFrames} failed; ${summary.unvalidatedFrames} unvalidated. ${summary.passedExpectations} expectations passed and ${summary.failedExpectations} failed.</p></header>${frameMarkup}</body></html>\n`;
    await writeFile(join(dir, "roll.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await writeFile(join(dir, "index.html"), index, "utf8");
    closedPath = join(dir, "index.html");
    return closedPath;
  };

  return {
    dir,
    async add(shot, seen) {
      if (closedPath) throw new Error(`Cannot add a frame after photo roll "${name}" is closed.`);
      const sequence = frames.length + 1;
      const caption = frameCaption(name, sequence, seen);
      const duplicate = hashes.get(shot.hash);
      if (duplicate) {
        throw new Error(`Duplicate screenshot pixels for "${caption}"; the same pixels were already added as "${duplicate}".`);
      }
      hashes.set(shot.hash, caption);
      await mkdir(dir, { recursive: true });
      const fileName = `${String(sequence).padStart(2, "0")}-${slug(caption)}.png`;
      const filePath = join(dir, fileName);
      await writeFile(filePath, shot.png);
      frames.push({
        caption,
        fileName,
        hash: shot.hash,
        route: shot.route,
        at: shot.at,
        description: seen?.description ?? "",
        model: seen?.model ?? "",
        ok: seen?.ok ?? null,
        results: seen?.results ?? [],
      });
      return filePath;
    },
    close,
    async [Symbol.asyncDispose]() {
      await close();
    },
  };
}
