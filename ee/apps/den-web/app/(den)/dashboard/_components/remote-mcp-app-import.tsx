"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Check, Download, Link2, PackagePlus, ShieldCheck, X } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import {
  useImportRemoteMcpApp,
  usePreviewRemoteMcpApp,
} from "./remote-mcp-app-data";

export function RemoteMcpAppImport({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (appId: string) => void;
}) {
  const preview = usePreviewRemoteMcpApp();
  const importApp = useImportRemoteMcpApp();
  const [sourceUrl, setSourceUrl] = useState("");

  useEffect(() => {
    if (open) return;
    setSourceUrl("");
    preview.reset();
    importApp.reset();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  async function handleImport() {
    const app = await importApp.mutateAsync({ sourceUrl });
    onImported(app.id);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-gray-950/35 px-4 py-10 backdrop-blur-[2px]" data-remote-app-import>
      <div className="w-full max-w-[680px] overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl shadow-gray-950/20">
        <div className="flex items-start justify-between gap-5 border-b border-gray-100 px-6 py-5">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <DenChip tone="info">Remote MCP App</DenChip>
              <DenChip tone="neutral">Self-contained HTML</DenChip>
            </div>
            <h2 className="text-[20px] font-semibold tracking-[-0.02em] text-gray-950">
              {preview.data ? "Review the cached resource" : "Add an app from a URL"}
            </h2>
            <p className="mt-1.5 max-w-[560px] text-[13px] leading-5 text-gray-500">
              OpenWork downloads one immutable copy. The source URL is never needed when the installed app runs.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-5 px-6 py-6">
          {!preview.data ? (
            <>
              <div>
                <label htmlFor="remote-app-url" className="mb-2 block text-[12px] font-semibold text-gray-700">Published app URL</label>
                <DenInput
                  id="remote-app-url"
                  type="url"
                  icon={Link2}
                  value={sourceUrl}
                  onChange={(event) => setSourceUrl(event.target.value)}
                  placeholder="https://example.com/project-explorer.html"
                  data-testid="remote-app-source-url"
                />
                <p className="mt-2 text-[12px] leading-5 text-gray-400">
                  Vite and other web apps work when exported as one self-contained HTML file with inline JavaScript and CSS. No OpenWork-specific runtime manifest is required. Maximum 768 KiB.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-3">
                {[
                  [Download, "Downloaded once", "Redirects and private-network targets are checked."],
                  [ShieldCheck, "Closed sandbox", "No direct network, subframes, or external resources."],
                  [PackagePlus, "Portable copy", "Download the exact cached revision whenever you need it."],
                ].map(([Icon, title, copy]) => {
                  const TileIcon = Icon as typeof Download;
                  return (
                    <div key={String(title)} className="rounded-xl border border-gray-100 bg-gray-50/70 p-3.5">
                      <TileIcon className="mb-2 h-4 w-4 text-blue-600" />
                      <p className="text-[12px] font-semibold text-gray-800">{String(title)}</p>
                      <p className="mt-1 text-[11px] leading-4 text-gray-500">{String(copy)}</p>
                    </div>
                  );
                })}
              </div>
              {preview.error ? <DenNotice tone="error" message={preview.error.message} /> : null}
              <div className="flex justify-end gap-2">
                <DenButton variant="ghost" onClick={onClose}>Cancel</DenButton>
                <DenButton
                  icon={Download}
                  loading={preview.isPending}
                  disabled={!sourceUrl.trim()}
                  onClick={() => preview.mutate(sourceUrl)}
                  data-testid="remote-app-preview"
                >
                  Download and review
                </DenButton>
              </div>
            </>
          ) : (
            <>
              <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-[17px] font-semibold text-gray-950">{preview.data.metadata.name}</h3>
                      <DenChip tone="neutral">v{preview.data.metadata.version}</DenChip>
                    </div>
                    {preview.data.metadata.description ? <p className="mt-1.5 text-[13px] text-gray-500">{preview.data.metadata.description}</p> : null}
                  </div>
                  <DenChip tone="success"><Check className="mr-1 h-3 w-3" />Validated</DenChip>
                </div>
                <dl className="mt-4 grid gap-3 text-[11px] sm:grid-cols-2">
                  <div><dt className="text-gray-400">Cached size</dt><dd className="mt-1 font-medium text-gray-700">{Math.ceil(preview.data.resource.byteSize / 1024)} KiB</dd></div>
                  <div><dt className="text-gray-400">Digest</dt><dd className="mt-1 truncate font-mono text-gray-700" title={preview.data.resource.digest}>{preview.data.resource.digest}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-gray-400">Resolved source</dt><dd className="mt-1 truncate text-gray-700" title={preview.data.resolvedSourceUrl}>{preview.data.resolvedSourceUrl}</dd></div>
                </dl>
              </div>

              <DenNotice tone="info" message="OpenWork will expose this cached HTML through an ordinary MCP tool and immutable ui:// resource. The app can use app-visible capability search on that same OpenWork MCP server to call authorized Connect tools and Code Mode Programs. Apps with their own MCP server keep that server's native tools and same-server calls through Connect." />
              {importApp.error ? <DenNotice tone="error" message={importApp.error.message} /> : null}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-5">
                <DenButton variant="ghost" icon={ArrowLeft} onClick={() => preview.reset()}>Use another URL</DenButton>
                <DenButton
                  icon={PackagePlus}
                  loading={importApp.isPending}
                  onClick={handleImport}
                  data-testid="remote-app-import"
                >
                  Import and activate
                </DenButton>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
