"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, Bot, CalendarClock, Check, History, Layers3, Share2 } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { useActivateArtifactView, useProgramDetail, useRetireArtifactView, useSelectProgram } from "./program-detail-data";
import { SavedScriptDetailPanel } from "./saved-script-detail-panel";

function shortDigest(value: string | null) {
  return value ? `${value.slice(0, 15)}…${value.slice(-8)}` : "—";
}

function cspSummary(csp: {
  connectDomains: string[];
  resourceDomains: string[];
  frameDomains: string[];
  baseUriDomains: string[];
}) {
  const domains = [...csp.connectDomains, ...csp.resourceDomains, ...csp.frameDomains, ...csp.baseUriDomains];
  return domains.length === 0 ? "CSP: no external origins" : `CSP: ${domains.join(", ")}`;
}

export function ProgramDetailScreen({ programId }: { programId: string }) {
  const router = useRouter();
  const detailQuery = useProgramDetail(programId);
  const activate = useActivateArtifactView(programId);
  const retire = useRetireArtifactView(programId);
  const select = useSelectProgram();
  const detail = detailQuery.data;
  if (detailQuery.isLoading || !detail) {
    return <div className="mx-auto max-w-[1180px] px-6 py-10 text-[13px] text-gray-400">{detailQuery.error?.message ?? "Loading Program…"}</div>;
  }
  const manager = detail.program.role === "manager";
  const actionError = activate.error ?? retire.error ?? select.error;
  return (
    <div className="mx-auto max-w-[1180px] space-y-6 px-6 py-8 md:px-8" data-testid="den-dynamic-program-detail">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <button type="button" aria-label="Back to Library" onClick={() => router.push("/dashboard/library")} className="rounded-lg p-2 text-gray-400 hover:bg-gray-50 hover:text-gray-800"><ArrowLeft className="h-4 w-4" /></button>
          <div>
            <div className="flex flex-wrap items-center gap-2"><h1 className="text-[22px] font-semibold tracking-[-0.02em] text-gray-950">{detail.program.name}</h1><DenChip tone="teal">Program</DenChip><DenChip tone={detail.program.resultState === "fresh" ? "success" : detail.program.resultState === "needs_attention" ? "danger" : "warning"}>{detail.program.resultState.replace("_", " ")}</DenChip></div>
            <p className="mt-1 max-w-3xl text-[13px] text-gray-500">{detail.program.description || "A reusable Code Mode Script with retained artifacts, generated views, runs, Automations, and access."}</p>
            {detail.program.plugin ? <p className="mt-1 text-[12px] text-gray-400">Inside OpenWork Connect Plugin <strong>{detail.program.plugin.name}</strong>.</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <DenButton variant="secondary" onClick={() => void select.mutateAsync(programId)} loading={select.isPending}><Bot className="h-3.5 w-3.5" />Use with agent</DenButton>
          {manager ? <DenButton variant="secondary" href={`/dashboard/automations?program=${encodeURIComponent(programId)}&version=${encodeURIComponent(detail.script.currentVersion.id)}`}><CalendarClock className="h-3.5 w-3.5" />Automate</DenButton> : null}
          {manager && detail.program.plugin ? <DenButton variant="secondary" href={`/dashboard/plugins/${encodeURIComponent(detail.program.plugin.id)}`}><Share2 className="h-3.5 w-3.5" />Share</DenButton> : null}
        </div>
      </header>

      {select.isSuccess ? <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700"><Check className="mr-2 inline h-4 w-4" />Selected for agent use. MCP clients receive list-changed notifications and can refresh the exact render tool.</div> : null}
      {actionError ? <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">{actionError.message}</div> : null}

      <nav className="flex gap-1 overflow-x-auto rounded-xl border border-gray-100 bg-white p-1 text-[12px] text-gray-500">
        {[["overview", "Overview"], ["preview-data", "Preview & Data"], ["script", "Script"], ["views", "Views"], ["runs", "Runs & Automations"], ["access", "Access"]].map(([id, label]) => <a key={id} href={`#${id}`} className="shrink-0 rounded-lg px-3 py-2 hover:bg-gray-50 hover:text-gray-900">{label}</a>)}
      </nav>

      <section id="overview" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          ["Access", detail.program.role],
          ["Current Script", detail.script.currentVersion.id.slice(0, 12)],
          ["View", detail.program.activeViewTitle ?? detail.program.viewState.replace("_", " ")],
          ["Automations", String(detail.program.automationCount)],
        ].map(([label, value]) => <div key={label} className="rounded-2xl border border-gray-100 bg-white p-4"><p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</p><p className="mt-2 break-all text-[14px] font-medium text-gray-800">{value}</p></div>)}
      </section>

      <section id="views" className="rounded-2xl border border-gray-100 bg-white p-5">
        <div className="flex items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-[15px] font-semibold text-gray-900"><Layers3 className="h-4 w-4" />Generated views</h2><p className="mt-1 text-[12px] text-gray-400">Immutable server-built client bundles. Den shows metadata and diagnostics; the MCP App executes only in the sandboxed chat host.</p></div><DenChip tone="neutral">{detail.views.length} view{detail.views.length === 1 ? "" : "s"}</DenChip></div>
        <div className="mt-4 space-y-4">
          {detail.views.length === 0 ? <p className="rounded-xl border border-dashed border-gray-200 p-6 text-center text-[13px] text-gray-400">No custom view yet. Agents can generate one; the safe Preview, Data, and Lineage renderer remains available.</p> : detail.views.map((view) => (
            <article key={view.id} className="rounded-xl border border-gray-100 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="text-[13px] font-semibold text-gray-800">{view.title}</h3><DenChip tone={view.status === "active" ? "success" : "neutral"}>{view.status}</DenChip></div><p className="mt-1 text-[12px] text-gray-400">{view.description || "No description"}</p></div>{manager && view.status === "active" ? <DenButton variant="destructive" size="sm" loading={retire.isPending} onClick={() => void retire.mutateAsync(view.id)}>Retire</DenButton> : null}</div>
              <div className="mt-3 space-y-2">{view.revisions.map((revision) => {
                const active = revision.id === view.activeRevisionId;
                return <div key={revision.id} className="rounded-lg bg-gray-50 p-3 text-[11px] text-gray-500"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><History className="h-3.5 w-3.5" /><span className="font-mono text-gray-700">{revision.id.slice(0, 14)}</span><DenChip tone={revision.buildStatus === "ready" ? active ? "success" : "neutral" : "danger"}>{active ? "active" : revision.buildStatus}</DenChip></div>{manager && revision.buildStatus === "ready" && !active && revision.retiredAt === null ? <DenButton size="xs" variant="secondary" loading={activate.isPending} onClick={() => void activate.mutateAsync({ viewId: view.id, revisionId: revision.id })}>Activate / roll back</DenButton> : null}</div><div className="mt-2 grid gap-1 md:grid-cols-2 xl:grid-cols-4"><span>{revision.compilerName} {revision.compilerVersion}</span><span>React {revision.reactVersion}</span><span>{revision.compiledHtmlBytes === null ? "No compiled bundle" : `${revision.compiledHtmlBytes.toLocaleString()} bytes`}</span><span>{new Date(revision.createdAt).toLocaleString()}</span><span className="md:col-span-2">Source {shortDigest(revision.sourceDigest)}</span><span className="md:col-span-2">Resource {shortDigest(revision.resourceDigest)}</span><span className="md:col-span-2 xl:col-span-4">{cspSummary(revision.csp)}</span></div><p className="mt-2 break-all font-mono text-[10px] text-gray-400">{revision.resourceUri}</p>{revision.diagnostics.length ? <ul className="mt-2 space-y-1 text-red-600">{revision.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.message}-${index}`}>{diagnostic.level}: {diagnostic.message}{diagnostic.line ? ` (${diagnostic.line}:${diagnostic.column ?? 0})` : ""}</li>)}</ul> : null}</div>;
              })}</div>
            </article>
          ))}
        </div>
      </section>

      <div id="script"><SavedScriptDetailPanel configObjectId={programId} onClose={() => router.push("/dashboard/library")} /></div>

      <section id="access" className="rounded-2xl border border-gray-100 bg-white p-5"><h2 className="text-[14px] font-semibold text-gray-900">Access</h2><p className="mt-2 text-[13px] text-gray-500">Your effective role is <strong>{detail.program.role}</strong>. Script versions, retained data, and generated views share this Program access boundary; there are no separate data or UI grants.</p>{manager && detail.program.plugin ? <DenButton className="mt-4" variant="secondary" href={`/dashboard/plugins/${encodeURIComponent(detail.program.plugin.id)}`}>Manage grants</DenButton> : null}</section>
    </div>
  );
}
