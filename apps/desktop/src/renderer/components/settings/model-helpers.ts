import { thinkingLevels, type CustomModelInput, type ModelCatalog, type ThinkingLevel } from "@vela/shared";

export const emptyModel: CustomModelInput = {
  providerId: "",
  providerName: "",
  baseUrl: "",
  api: "openai-completions",
  apiKey: "",
  modelId: "",
  modelName: "",
  reasoning: false,
  contextWindow: null,
  maxTokens: null,
};

export function providerIdFromName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (/^[a-z0-9][a-z0-9._-]{0,63}$/.test(slug)) return slug;
  return `custom-${Math.random().toString(36).slice(2, 8)}`;
}

export function modelValue(provider: string, id: string): string {
  return `${provider}\n${id}`;
}

export function parseModelValue(value: string): { provider: string | null; modelId: string | null } {
  const splitAt = value.indexOf("\n");
  if (!value || splitAt <= 0) return { provider: null, modelId: null };
  return { provider: value.slice(0, splitAt), modelId: value.slice(splitAt + 1) };
}

export function levelsFor(catalog: ModelCatalog | null, provider: string | null, modelId: string | null): ThinkingLevel[] {
  if (!provider || !modelId) return [...thinkingLevels];
  const model = catalog?.models.find((item) => item.provider === provider && item.id === modelId);
  if (model && model.thinkingLevels.length > 0) return model.thinkingLevels;
  return [...thinkingLevels];
}

export function clampChoice(choices: ThinkingLevel[], level: ThinkingLevel): ThinkingLevel {
  if (choices.includes(level)) return level;
  if (choices.includes("medium")) return "medium";
  return choices[0] ?? "off";
}


export function groupAvailable(catalog: ModelCatalog | null): { provider: string; name: string; models: { provider: string; id: string; name: string }[] }[] {
  const groups = new Map<string, { provider: string; name: string; models: { provider: string; id: string; name: string }[] }>();
  for (const model of catalog?.models ?? []) {
    if (!model.available) continue;
    const group = groups.get(model.provider) ?? { provider: model.provider, name: model.providerName, models: [] };
    group.models.push({ provider: model.provider, id: model.id, name: model.name });
    groups.set(model.provider, group);
  }
  return [...groups.values()];
}
