import type { DenOrgLlmProvider } from "@/app/lib/den";
import type { ModelOption } from "@/app/types";
import { getCloudManagedProviderId, isCloudManagedProviderKey } from "./cloud-provider-config";

export function filterCloudManagedModelOptions<T extends Pick<ModelOption, "providerID">>(
  options: readonly T[],
  cloudProvidersEnabled: boolean,
): T[] {
  return cloudProvidersEnabled
    ? [...options]
    : options.filter((option) => !isCloudManagedProviderKey(option.providerID));
}

export function assignedModelOptions(
  providers: readonly DenOrgLlmProvider[],
): ModelOption[] {
  return providers.flatMap((provider) => {
    const providerID = getCloudManagedProviderId(provider);
    if (!providerID) return [];

    return provider.models.flatMap((model) => {
      const modelID = model.id.trim();
      if (!modelID) return [];

      const option: ModelOption = {
        providerID,
        modelID,
        title: model.name.trim() || modelID,
        description: provider.name.trim() || provider.providerId.trim() || providerID,
        behaviorTitle: "Reasoning",
        behaviorLabel: "Default",
        behaviorDescription: "",
        behaviorValue: null,
        isFree: false,
        source: "cloud",
      };
      return [option];
    });
  });
}

export function mergeModelOptions(
  primary: readonly ModelOption[],
  fallback: readonly ModelOption[],
): ModelOption[] {
  const merged = new Map<string, ModelOption>();
  for (const option of fallback) {
    merged.set(`${option.providerID}:${option.modelID}`, option);
  }
  for (const option of primary) {
    merged.set(`${option.providerID}:${option.modelID}`, option);
  }
  return [...merged.values()];
}
