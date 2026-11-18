/**
 * FNXC:CustomProviderVision 2026-11-18-17:06:
 * Origin: operator report — "Fusion says the model has no Vision, but the model does have it"
 * (observed on custom provider `dsai1` → LiteLLM `deepseek-v4`).
 *
 * `buildCustomProviderModels` stamped `input: ["text"]` on every custom-provider model with no branch
 * and no settings field, so the pi runtime could never be told a gateway model accepts image parts.
 * The fix is an opt-in per-model `supportsImages`; these tests pin the contract that decides it:
 *
 *  1. Absent field → `["text"]`. This is the no-behaviour-change guarantee: every custom provider
 *     configured before this change must register exactly as it did, because emitting image parts to
 *     a gateway that rejects them is a worse failure than the missing capability it replaces.
 *  2. Explicit `false` → `["text"]`, same as absent.
 *  3. Explicit `true` → `["text", "image"]`.
 *  4. Only strict `true` counts. A truthy non-boolean (`"false"`, `1`) must NOT enable image input —
 *     a loose check here would let a stray settings value flip request shape for a model the operator
 *     never declared vision-capable.
 *  5. Per-model independence: one vision row must not promote its text-only siblings.
 *  6. Surface enumeration (FN-5893 rule — the invariant, not the reported repro): the decision is
 *     made before the apiType-specific compat spread, so it must hold for all four declared
 *     apiTypes, not only for the `openai-compatible` one that was reported.
 *  7. Registration refresh: provider re-registration diffs this builder's serialized output
 *     (`providersDiffer`), so toggling the flag has to change that serialization.
 */
import { describe, expect, it } from "vitest";
import type { CustomProvider } from "@fusion/core";
import { buildCustomProviderModels, resolveApiType } from "../auth/custom-provider-registry.js";

function makeProvider(models: NonNullable<CustomProvider["models"]>, apiType: CustomProvider["apiType"] = "openai-compatible"): CustomProvider {
  return {
    id: "vision-test",
    name: "Vision Test",
    apiType,
    baseUrl: "https://gateway.test/v1",
    models,
  };
}

const API_TYPE_CASES: CustomProvider["apiType"][] = [
  "openai-compatible",
  "openai-responses",
  "anthropic-compatible",
  "google-generative-ai",
];

describe("custom provider per-model vision opt-in", () => {
  it("keeps an undeclared model text-only for every declared apiType", () => {
    for (const apiType of API_TYPE_CASES) {
      const [model] = buildCustomProviderModels(makeProvider([{ id: "m-plain", name: "Plain" }], apiType), resolveApiType(apiType));
      expect(model.input).toEqual(["text"]);
    }
  });

  it("emits a byte-identical registration when no model declares vision", () => {
    // The guarantee is on the whole emitted object, not just the field: an existing deployment must
    // not gain or lose any other key from this change.
    const emitted = buildCustomProviderModels(makeProvider([{ id: "m-plain", name: "Plain", contextWindow: 32768 }]), "openai-completions");
    expect(emitted[0]).toEqual({
      id: "m-plain",
      name: "Plain",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 16384,
      // Measured shape for the openai-completions dialect: the compat block is always emitted there
      // (developer-role opt-in). Named here so this assertion really is "no other key changed" rather
      // than an approximation that passes.
      compat: { supportsDeveloperRole: false },
    });
  });

  it("treats an explicit false exactly like an absent field", () => {
    const [model] = buildCustomProviderModels(makeProvider([{ id: "m-off", name: "Off", supportsImages: false }]), "openai-completions");
    expect(model.input).toEqual(["text"]);
  });

  it("declares image input when the operator opts the model in", () => {
    const [model] = buildCustomProviderModels(makeProvider([{ id: "deepseek-v4", name: "DeepSeek V4", supportsImages: true }]), "openai-completions");
    expect(model.input).toEqual(["text", "image"]);
  });

  it("honours the opt-in for every declared apiType, not just the reported one", () => {
    for (const apiType of API_TYPE_CASES) {
      const [model] = buildCustomProviderModels(makeProvider([{ id: "m-vision", name: "Vision", supportsImages: true }], apiType), resolveApiType(apiType));
      expect(model.input).toEqual(["text", "image"]);
    }
  });

  it("accepts only strict true — a truthy non-boolean never enables image input", () => {
    // The settings file is operator-editable JSON, so a string or number can appear here. The builder
    // compares with === true, which is what keeps a stray value from changing request shape.
    for (const loose of ["false", "true", 1, 0, {}, []] as unknown[]) {
      const [model] = buildCustomProviderModels(
        makeProvider([{ id: "m-loose", name: "Loose", supportsImages: loose as boolean }]),
        "openai-completions",
      );
      expect(model.input).toEqual(["text"]);
    }
  });

  it("decides per model, so one vision row does not promote its siblings", () => {
    const models = buildCustomProviderModels(
      makeProvider([
        { id: "m-vision", name: "Vision", supportsImages: true },
        { id: "m-text", name: "Text" },
        { id: "m-off", name: "Off", supportsImages: false },
      ]),
      "openai-completions",
    );
    expect(models.map((m) => m.input)).toEqual([["text", "image"], ["text"], ["text"]]);
  });

  it("changes the serialized registration, so an already-registered provider is re-registered", () => {
    // `providersDiffer` compares JSON of this builder's output; if the flag did not reach the emitted
    // object, ticking the box would need a restart to take effect.
    const before = JSON.stringify(buildCustomProviderModels(makeProvider([{ id: "m", name: "M" }]), "openai-completions"));
    const after = JSON.stringify(buildCustomProviderModels(makeProvider([{ id: "m", name: "M", supportsImages: true }]), "openai-completions"));
    expect(after).not.toBe(before);
    expect(after).toContain('"image"');
  });
});
