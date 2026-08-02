import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { renderPrMarkdown } from "./render.ts";
import { readRollFile } from "./scan.ts";

const BLOB_API_BASE = "https://blob.vercel-storage.com";
const MARKER = "<!-- photo-roll -->";

export interface CommandOptions {
  input?: string;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CommandRunner = (command: string, args: string[], opts?: CommandOptions) => CommandResult;
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PublishDependencies {
  exec?: CommandRunner;
  fetch?: Fetcher;
  stdout?: (markdown: string) => void;
}

export interface PublishPrOptions {
  pr?: string | number;
  rollDir: string;
  dryRun?: boolean;
}

export interface PublishPrResult {
  markdown: string;
  posted: boolean;
  updated: boolean;
  urls: Record<string, string>;
}

function commandRunner(command: string, args: string[], opts: CommandOptions = {}): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input: opts.input,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    error: result.error,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveBlobToken(exec: CommandRunner): string | null {
  const fromEnv = process.env.BLOB_READ_WRITE_TOKEN;
  if (fromEnv) return fromEnv;
  const result = exec(
    "infisical",
    ["secrets", "get", "BLOB_READ_WRITE_TOKEN", "--plain", "--silent"],
  );
  const token = result.status === 0 && !result.error ? result.stdout.trim() : "";
  return token.length > 0 ? token : null;
}

async function uploadImages(
  rollDir: string,
  rollName: string,
  files: string[],
  token: string,
  fetcher: Fetcher,
): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  const realDir = await realpath(rollDir);
  for (const file of files) {
    if (basename(file) !== file || !file.toLowerCase().endsWith(".png")) {
      throw new Error(`Refusing to upload invalid roll frame path: ${file}`);
    }
    const filePath = join(realDir, file);
    const stats = await lstat(filePath).catch(() => null);
    if (!stats?.isFile()) {
      throw new Error(`Refusing to upload non-regular or symlinked roll frame: ${file}`);
    }
    const pathname = `photo-roll/${encodeURIComponent(rollName)}/${encodeURIComponent(file)}`;
    const response = await fetcher(`${BLOB_API_BASE}/${pathname}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "x-content-type": "image/png",
        "x-add-random-suffix": "0",
      },
      body: await readFile(filePath),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Vercel Blob upload failed (${response.status}) for ${file}: ${detail}`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Vercel Blob upload for ${file}: response was not JSON`);
    }
    if (!isRecord(payload) || typeof payload.url !== "string" || payload.url.length === 0) {
      throw new Error(`Vercel Blob upload for ${file}: response did not include a url`);
    }
    urls[file] = payload.url;
  }
  return urls;
}

function stickyCommentId(raw: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.comments)) return null;
  for (const comment of value.comments) {
    if (!isRecord(comment) || typeof comment.body !== "string" || !comment.body.includes(MARKER)) continue;
    const directId = comment.databaseId ?? comment.id;
    if (typeof directId === "number" && Number.isInteger(directId)) return String(directId);
    if (typeof directId === "string" && /^\d+$/.test(directId)) return directId;
    if (typeof comment.url === "string") {
      const match = /#issuecomment-(\d+)$/.exec(comment.url);
      if (match?.[1]) return match[1];
    }
  }
  return null;
}

function requireSuccess(result: CommandResult, label: string): void {
  if (result.status === 0 && !result.error) return;
  const stderr = result.stderr.trim();
  const detail = result.error?.message ?? (stderr || `exit ${result.status}`);
  throw new Error(`${label} failed: ${detail}`);
}

function postStickyComment(pr: string, markdown: string, exec: CommandRunner): boolean {
  const viewed = exec("gh", ["pr", "view", pr, "--json", "comments"]);
  requireSuccess(viewed, "Reading PR comments");
  const commentId = stickyCommentId(viewed.stdout);
  if (commentId) {
    const updated = exec(
      "gh",
      ["api", "--method", "PATCH", `repos/{owner}/{repo}/issues/comments/${commentId}`, "--input", "-"],
      { input: JSON.stringify({ body: markdown }) },
    );
    requireSuccess(updated, "Updating photo roll comment");
    return true;
  }
  const posted = exec("gh", ["pr", "comment", pr, "--body-file", "-"], { input: markdown });
  requireSuccess(posted, "Posting photo roll comment");
  return false;
}

export async function publishPr(
  options: PublishPrOptions,
  dependencies: PublishDependencies = {},
): Promise<PublishPrResult> {
  const roll = await readRollFile(join(options.rollDir, "roll.json"));
  if (!roll) throw new Error(`No valid roll.json found in ${options.rollDir}`);
  const exec = dependencies.exec ?? commandRunner;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const rollName = basename(options.rollDir);
  const pr = options.pr === undefined ? "<n>" : String(options.pr);
  const reproCommand = `pnpm --dir evals run publish:pr -- --pr ${pr} --roll ${rollName}`;

  if (options.dryRun) {
    const markdown = renderPrMarkdown(roll, {}, {
      reproCommand,
      notice: "Dry run: screenshots were not uploaded.",
    });
    (dependencies.stdout ?? ((body) => process.stdout.write(`${body}\n`)))(markdown);
    return { markdown, posted: false, updated: false, urls: {} };
  }
  if (options.pr === undefined) throw new Error("Publishing requires --pr <n>.");

  const token = resolveBlobToken(exec);
  const urls = token
    ? await uploadImages(options.rollDir, rollName, roll.frames.map((frame) => frame.fileName), token, fetcher)
    : {};
  const markdown = renderPrMarkdown(roll, urls, {
    reproCommand,
    notice: token ? undefined : "screenshots not uploaded (no BLOB_READ_WRITE_TOKEN)",
  });
  const updated = postStickyComment(String(options.pr), markdown, exec);
  return { markdown, posted: true, updated, urls };
}
