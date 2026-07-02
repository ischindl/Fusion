import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthReloginBanner } from "../OAuthReloginBanner";
import { OAUTH_RELOGIN_SUCCESS_EVENT } from "../../auth";
import * as api from "../../api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, values?: Record<string, string>) => {
      let text = fallback ?? _key;
      if (values) {
        for (const [key, value] of Object.entries(values)) {
          text = text.replaceAll(`{{${key}}}`, value);
        }
      }
      return text;
    },
  }),
}));

vi.mock("../../api", () => ({
  fetchAuthStatus: vi.fn(),
}));

const mockFetchAuthStatus = vi.mocked(api.fetchAuthStatus);

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("OAuthReloginBanner", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockFetchAuthStatus.mockReset();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("shows expired Anthropic subscription OAuth even when Claude CLI is authenticated", async () => {
    mockFetchAuthStatus.mockResolvedValueOnce({
      providers: [
        { id: "anthropic-subscription", name: "Anthropic Subscription", type: "oauth", authenticated: false, expired: true },
        { id: "claude-cli", name: "Claude CLI", type: "cli", authenticated: true },
      ],
      ghCli: { available: false, authenticated: false },
    });

    render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);

    expect(await screen.findByRole("status")).toHaveTextContent("Anthropic Subscription");
    expect(screen.getByRole("status")).toHaveTextContent("Re-login required");
  });

  it("clears the banner when OAuth success is dispatched for the status provider id", async () => {
    mockFetchAuthStatus
      .mockResolvedValueOnce({
        providers: [
          { id: "anthropic-subscription", name: "Anthropic Subscription", type: "oauth", authenticated: false, expired: true },
        ],
        ghCli: { available: false, authenticated: false },
      })
      .mockResolvedValueOnce({
        providers: [
          { id: "anthropic-subscription", name: "Anthropic Subscription", type: "oauth", authenticated: true, expired: false },
        ],
        ghCli: { available: false, authenticated: false },
      });

    render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Anthropic Subscription");

    await act(async () => {
      window.dispatchEvent(new CustomEvent(OAUTH_RELOGIN_SUCCESS_EVENT, { detail: { providerId: "anthropic-subscription" } }));
      await flushPromises();
    });

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("keeps dismissed state scoped to currently expired provider ids", async () => {
    mockFetchAuthStatus
      .mockResolvedValueOnce({
        providers: [
          { id: "anthropic-subscription", name: "Anthropic Subscription", type: "oauth", authenticated: false, expired: true },
        ],
        ghCli: { available: false, authenticated: false },
      })
      .mockResolvedValueOnce({
        providers: [],
        ghCli: { available: false, authenticated: false },
      })
      .mockResolvedValueOnce({
        providers: [
          { id: "openai-codex", name: "OpenAI Codex", type: "oauth", authenticated: false, expired: true },
        ],
        ghCli: { available: false, authenticated: false },
      });

    const { unmount } = render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Anthropic Subscription");

    fireEvent.click(screen.getByLabelText("Dismiss OAuth re-login banner"));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());

    unmount();
    render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    await act(async () => {
      await flushPromises();
    });
    unmount();

    render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("status")).toHaveTextContent("OpenAI Codex");
  });
});
