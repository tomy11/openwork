/** @jsxImportSource react */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsNotice } from "../settings-section";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionTitle,
} from "../settings-layout";

export type CustomProviderInput = {
  id: string;
  name: string;
  baseURL: string;
  models: string[];
  /** Optional; when omitted the engine falls back to an existing auth.json key or env. */
  apiKey?: string;
};

export type CustomProviderFormProps = {
  onAddCustomProvider: (input: CustomProviderInput) => void | Promise<void>;
  busy: boolean;
  status: string | null;
  error: string | null;
  disabled?: boolean;
};

type Preset = {
  key: string;
  label: string;
  id: string;
  name: string;
  baseURL: string;
  models: string;
  /** Local model servers need no key; remote ones usually do. */
  keyHint: string;
};

// OpenAI-compatible endpoints. Cloudflare's base URL embeds the account id,
// which is user-specific and cannot come from a shared catalog — that gap is
// exactly why this form exists.
const PRESETS: Preset[] = [
  {
    key: "cloudflare",
    label: "Cloudflare Workers AI",
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    baseURL: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1",
    models: "@cf/meta/llama-3.3-70b-instruct-fp8-fast, @cf/openai/gpt-oss-120b",
    keyHint: "Replace ACCOUNT_ID in the URL. Leave the key blank if you already saved a Cloudflare key.",
  },
  {
    key: "ollama",
    label: "Ollama (local)",
    id: "ollama",
    name: "Ollama (local)",
    baseURL: "http://localhost:11434/v1",
    models: "llama3.2, qwen2.5-coder",
    keyHint: "Local server — no API key needed. Start Ollama first.",
  },
  {
    key: "lmstudio",
    label: "LM Studio (local)",
    id: "lmstudio",
    name: "LM Studio (local)",
    baseURL: "http://localhost:1234/v1",
    models: "",
    keyHint: "Local server — no API key needed. Start the LM Studio server first.",
  },
];

function parseModels(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

export function CustomProviderForm(props: CustomProviderFormProps) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [models, setModels] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyHint, setKeyHint] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const applyPreset = (preset: Preset) => {
    setId(preset.id);
    setName(preset.name);
    setBaseURL(preset.baseURL);
    setModels(preset.models);
    setApiKey("");
    setKeyHint(preset.keyHint);
    setLocalError(null);
  };

  const disabled = props.disabled || props.busy;

  const handleSubmit = async () => {
    setLocalError(null);
    const trimmedId = id.trim();
    const trimmedName = name.trim() || trimmedId;
    const trimmedBaseURL = baseURL.trim();
    const parsedModels = parseModels(models);

    if (!trimmedId) {
      setLocalError("Provider id is required (e.g. cloudflare-workers-ai).");
      return;
    }
    if (!trimmedBaseURL) {
      setLocalError("Base URL is required.");
      return;
    }
    if (trimmedBaseURL.includes("ACCOUNT_ID")) {
      setLocalError("Replace ACCOUNT_ID in the base URL with your Cloudflare account id.");
      return;
    }
    if (parsedModels.length === 0) {
      setLocalError("Add at least one model id (comma or newline separated).");
      return;
    }

    await props.onAddCustomProvider({
      id: trimmedId,
      name: trimmedName,
      baseURL: trimmedBaseURL,
      models: parsedModels,
      apiKey: apiKey.trim() || undefined,
    });
  };

  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>Custom &amp; local providers</LayoutSectionTitle>
        <LayoutSectionDescription>
          Add any OpenAI-compatible endpoint by base URL — no sign-in required. Use a preset to prefill.
        </LayoutSectionDescription>
      </LayoutSectionHeader>

      <LayoutSectionItem className="gap-4 rounded-2xl border border-dls-border px-4 py-4">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => (
            <Button
              key={preset.key}
              type="button"
              variant="outline"
              onClick={() => applyPreset(preset)}
              disabled={disabled}
            >
              {preset.label}
            </Button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="custom-provider-id">Provider id</Label>
            <Input
              id="custom-provider-id"
              value={id}
              onChange={(event) => setId(event.target.value)}
              placeholder="cloudflare-workers-ai"
              disabled={disabled}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="custom-provider-name">Display name</Label>
            <Input
              id="custom-provider-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Cloudflare Workers AI"
              disabled={disabled}
            />
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="custom-provider-base-url">Base URL (OpenAI-compatible)</Label>
          <Input
            id="custom-provider-base-url"
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
            placeholder="http://localhost:11434/v1"
            disabled={disabled}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="custom-provider-models">Model ids (comma or newline separated)</Label>
          <Input
            id="custom-provider-models"
            value={models}
            onChange={(event) => setModels(event.target.value)}
            placeholder="llama3.2, qwen2.5-coder"
            disabled={disabled}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="custom-provider-key">API key (optional)</Label>
          <Input
            id="custom-provider-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Leave blank for local servers or an already-saved key"
            disabled={disabled}
            autoComplete="off"
          />
          {keyHint ? <p className="text-xs text-muted-foreground">{keyHint}</p> : null}
        </div>

        <div className="flex items-center gap-3">
          <Button type="button" onClick={() => void handleSubmit()} disabled={disabled}>
            {props.busy ? "Adding…" : "Add provider"}
          </Button>
        </div>

        {localError ? <SettingsNotice tone="error">{localError}</SettingsNotice> : null}
        {props.error ? <SettingsNotice tone="error">{props.error}</SettingsNotice> : null}
        {props.status ? <SettingsNotice>{props.status}</SettingsNotice> : null}
      </LayoutSectionItem>
    </LayoutSection>
  );
}
