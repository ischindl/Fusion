import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { AuthenticationSection, type AuthenticationSectionData } from "../settings/sections/AuthenticationSection";
import type { AuthProvider } from "../../api";

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-testid={`mock-icon-${provider}`}>{provider}</span>,
}));

vi.mock("../PluginSlot", () => ({
  PluginSlot: ({ slotId }: { slotId: string }) => <div data-testid={`plugin-slot-${slotId}`} />,
}));

vi.mock("../LoginInstructions", () => ({
  LoginInstructions: ({ instructions }: { instructions: string }) => <div>{instructions}</div>,
}));

vi.mock("../LoadingSpinner", () => ({
  LoadingSpinner: ({ label }: { label: string }) => <div>{label}</div>,
}));

vi.mock("../OAuthManualCodeForm", () => ({
  OAuthManualCodeForm: ({ prompt }: { prompt: string }) => <div>{prompt}</div>,
}));

vi.mock("../CustomProvidersSection", () => ({
  CustomProvidersSection: () => <div data-testid="custom-providers-section" />,
}));

vi.mock("../ClaudeCliProviderCard", () => ({ ClaudeCliProviderCard: () => <div /> }));
vi.mock("../CursorCliProviderCard", () => ({ CursorCliProviderCard: () => <div /> }));
vi.mock("../LlamaCppProviderCard", () => ({ LlamaCppProviderCard: () => <div /> }));

function renderAuthSection(providers: AuthProvider[], overrides: Partial<AuthenticationSectionData> = {}) {
  const handleLogin = vi.fn();
  const handleLogout = vi.fn();
  const handleSaveApiKey = vi.fn();
  const handleClearApiKey = vi.fn();

  function Harness() {
    const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
    const [manualCodeInputs, setManualCodeInputs] = useState<Record<string, string>>({});
    const auth: AuthenticationSectionData = {
      addToast: vi.fn(),
      authProviders: providers,
      authLoading: false,
      authActionInProgress: null,
      apiKeyInputs,
      setApiKeyInputs,
      apiKeyErrors: {},
      opencodeApiKeyRefreshStatus: {},
      deviceCodes: {},
      loginInstructions: {},
      manualCodeConfigs: {},
      manualCodeInputs,
      setManualCodeInputs,
      manualCodeSubmitInProgress: null,
      loadAuthStatus: vi.fn(),
      handleLogin,
      handleLogout,
      handleCancelLogin: vi.fn(),
      handleSaveApiKey,
      handleClearApiKey,
      handleSubmitManualCode: vi.fn(),
      ...overrides,
    };
    return <AuthenticationSection auth={auth} />;
  }

  render(<Harness />);
  return { handleLogin, handleLogout, handleSaveApiKey, handleClearApiKey };
}

describe("AuthenticationSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders separate Anthropic subscription OAuth and API-key cards", () => {
    const { handleLogin, handleSaveApiKey } = renderAuthSection([
      { id: "anthropic-subscription", name: "Anthropic Subscription", authenticated: false, type: "oauth" },
      { id: "anthropic-api-key", name: "Anthropic API Key", authenticated: false, type: "api_key" },
      { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
    ]);

    const subscriptionCard = screen.getByTestId("auth-provider-icon-anthropic-subscription").closest(".auth-provider-card") as HTMLElement;
    const apiKeyCard = screen.getByTestId("auth-provider-icon-anthropic-api-key").closest(".auth-provider-card") as HTMLElement;
    expect(screen.queryByTestId("auth-provider-icon-anthropic")).not.toBeInTheDocument();

    fireEvent.click(within(subscriptionCard).getByRole("button", { name: "Login" }));
    expect(within(subscriptionCard).queryByPlaceholderText("Enter API key")).not.toBeInTheDocument();
    expect(handleLogin).toHaveBeenCalledWith("anthropic-subscription");

    fireEvent.change(within(apiKeyCard).getByPlaceholderText("Enter API key"), { target: { value: "sk-ant-api03-new" } });
    fireEvent.click(within(apiKeyCard).getByRole("button", { name: "Save" }));
    expect(within(apiKeyCard).queryByRole("button", { name: "Login" })).not.toBeInTheDocument();
    expect(handleSaveApiKey).toHaveBeenCalledWith("anthropic-api-key");
  });

  it("keeps Anthropic OAuth logout separate from a stored API key clear action", () => {
    const { handleLogout, handleClearApiKey } = renderAuthSection([
      { id: "anthropic-subscription", name: "Anthropic Subscription", authenticated: true, type: "oauth" },
      { id: "anthropic-api-key", name: "Anthropic API Key", authenticated: true, type: "api_key", keyHint: "sk-•••••dkey" },
    ]);

    const subscriptionCard = screen.getByTestId("auth-provider-icon-anthropic-subscription").closest(".auth-provider-card") as HTMLElement;
    const apiKeyCard = screen.getByTestId("auth-provider-icon-anthropic-api-key").closest(".auth-provider-card") as HTMLElement;

    fireEvent.click(within(subscriptionCard).getByRole("button", { name: "Logout" }));
    expect(within(subscriptionCard).queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    expect(handleLogout).toHaveBeenCalledWith("anthropic-subscription");

    expect(within(apiKeyCard).getByText("Key: sk-•••••dkey")).toBeInTheDocument();
    fireEvent.click(within(apiKeyCard).getByRole("button", { name: "Clear" }));
    expect(within(apiKeyCard).queryByRole("button", { name: "Logout" })).not.toBeInTheDocument();
    expect(handleClearApiKey).toHaveBeenCalledWith("anthropic-api-key");
  });

  it("ignores legacy supportsApiKey flags on OAuth cards", () => {
    const { handleLogin, handleSaveApiKey } = renderAuthSection([
      {
        id: "anthropic-subscription",
        name: "Anthropic Subscription",
        authenticated: false,
        type: "oauth",
        supportsApiKey: true,
      } as AuthProvider & { supportsApiKey: true },
    ]);

    const subscriptionCard = screen.getByTestId("auth-provider-icon-anthropic-subscription").closest(".auth-provider-card") as HTMLElement;

    expect(within(subscriptionCard).getByRole("button", { name: "Login" })).toBeInTheDocument();
    expect(within(subscriptionCard).queryByPlaceholderText("Enter API key")).not.toBeInTheDocument();

    fireEvent.click(within(subscriptionCard).getByRole("button", { name: "Login" }));
    expect(handleLogin).toHaveBeenCalledWith("anthropic-subscription");
    expect(handleSaveApiKey).not.toHaveBeenCalled();
  });
});
