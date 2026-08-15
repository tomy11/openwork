"use client";

import { useState } from "react";
import type { ArtifactFreshness, SavedScriptArtifactSnapshot } from "@openwork/types/dynamic-artifacts";

function decode(value: string) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function tableCells(line: string) {
  const values: string[] = [];
  let current = "";
  for (const character of line.slice(1, -1)) {
    if (character === "|" && !current.endsWith("\\")) {
      values.push(decode(current.trim()));
      current = "";
      continue;
    }
    if (character === "|" && current.endsWith("\\")) current = `${current.slice(0, -1)}|`;
    else current += character;
  }
  values.push(decode(current.trim()));
  return values;
}

export function SavedScriptMarkdownPreview({ markdown }: { markdown: string }) {
  if (markdown.startsWith("```json\n") && markdown.endsWith("\n```")) {
    return <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-gray-950 p-4 font-mono text-[12px] text-gray-100">{markdown.slice(8, -4)}</pre>;
  }
  const lines = markdown.split("\n");
  if (lines.length >= 2 && lines[0]?.startsWith("|") && lines[1]?.includes("---")) {
    const headers = tableCells(lines[0] ?? "");
    return (
      <div className="overflow-auto rounded-xl border border-gray-100">
        <table className="min-w-full text-left text-[12px]">
          <thead className="bg-gray-50"><tr>{headers.map((header) => <th key={header} className="px-3 py-2 font-medium text-gray-600">{header}</th>)}</tr></thead>
          <tbody>{lines.slice(2).map((line, rowIndex) => <tr key={`${rowIndex}:${line}`} className="border-t border-gray-100">{tableCells(line).map((entry, index) => <td key={`${index}:${entry}`} className="px-3 py-2 text-gray-700">{entry}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
  }
  return <p className="whitespace-pre-wrap text-[13px] leading-6 text-gray-700">{decode(markdown)}</p>;
}

function freshnessLabel(value: ArtifactFreshness) {
  return value.state === "never_run" ? "Never run" : value.state.replace("_", " ");
}

export function SavedScriptArtifactResult(props: {
  snapshot: SavedScriptArtifactSnapshot;
  freshness?: ArtifactFreshness;
  lastSuccessful?: boolean;
}) {
  const [tab, setTab] = useState<"preview" | "data" | "lineage">("preview");
  const snapshot = props.snapshot;
  return (
    <div className="space-y-3" data-testid="den-saved-script-artifact-result">
      <div className="flex flex-wrap gap-2 text-[11px]">
        {props.freshness ? <span className={`rounded-full px-2 py-1 font-medium ${props.freshness.state === "needs_attention" ? "bg-red-50 text-red-600" : props.freshness.state === "fresh" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>{freshnessLabel(props.freshness)}</span> : null}
        {props.lastSuccessful ? <span className="rounded-full bg-blue-50 px-2 py-1 font-medium text-blue-700">Last successful</span> : null}
        <span className="rounded-full bg-gray-100 px-2 py-1 text-gray-600">Exact Script version {snapshot.configObjectVersionId.slice(0, 8)}</span>
        <span className="rounded-full bg-gray-100 px-2 py-1 text-gray-600">{snapshot.source === "scheduled" ? "Scheduled · OpenWork Cloud" : "Manual"}</span>
      </div>
      {snapshot.contentDeletedAt ? <p className="rounded-xl border border-dashed border-gray-200 p-4 text-[13px] text-gray-400">Artifact content deleted</p> : (
        <>
          <div className="flex gap-4 border-b border-gray-100" role="tablist">
            {(["preview", "data", "lineage"] as const).map((value) => <button key={value} type="button" role="tab" aria-selected={tab === value} className={`border-b-2 pb-2 text-[12px] font-medium capitalize ${tab === value ? "border-gray-900 text-gray-900" : "border-transparent text-gray-400"}`} onClick={() => setTab(value)}>{value}</button>)}
          </div>
          {tab === "preview" ? snapshot.markdown ? <SavedScriptMarkdownPreview markdown={snapshot.markdown} /> : <p className="text-[13px] text-gray-400">No rendered result is retained.</p> : null}
          {tab === "data" ? <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-gray-950 p-4 font-mono text-[12px] text-gray-100">{JSON.stringify(snapshot.value, null, 2)}</pre> : null}
          {tab === "lineage" ? (
            <dl className="grid gap-3 rounded-xl border border-gray-100 p-4 text-[11px] sm:grid-cols-2">
              <div><dt className="text-gray-400">Receipt</dt><dd className="break-all font-mono text-gray-700">{snapshot.receiptId}</dd></div>
              <div><dt className="text-gray-400">Script version</dt><dd className="break-all font-mono text-gray-700">{snapshot.configObjectVersionId}</dd></div>
              <div><dt className="text-gray-400">Started</dt><dd>{new Date(snapshot.startedAt).toLocaleString()}</dd></div>
              <div><dt className="text-gray-400">Finished</dt><dd>{new Date(snapshot.finishedAt).toLocaleString()}</dd></div>
              <div><dt className="text-gray-400">Code digest</dt><dd className="break-all font-mono">{snapshot.codeDigest}</dd></div>
              <div><dt className="text-gray-400">Result digest</dt><dd className="break-all font-mono">{snapshot.resultDigest ?? "—"}</dd></div>
              <div><dt className="text-gray-400">Renderer</dt><dd>{snapshot.rendererVersion ?? "—"}</dd></div>
              <div><dt className="text-gray-400">Automation run</dt><dd className="break-all font-mono">{snapshot.automationRunId ?? "Manual"}</dd></div>
            </dl>
          ) : null}
        </>
      )}
    </div>
  );
}
