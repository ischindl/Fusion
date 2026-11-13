import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { AuthenticationSection, type AuthenticationSectionData } from "../settings/sections/AuthenticationSection";
import { removeProviderInstance, type AuthProvider } from "../../api";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  newProviderInstanceId: () => "acct-new",
  removeProviderInstance: vi.fn().mockResolvedValue({ success: true }),
  renameProviderInstance: vi.fn().mockResolvedValue({ success: true }),
  setProviderDefaultInstance: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => <span /> }));
vi.mock("../PluginSlot", () => ({ PluginSlot: () => null }));
vi.mock("../LoginInstructions", () => ({ LoginInstructions: () => null }));
vi.mock("../LoadingSpinner", () => ({ LoadingSpinner: () => null }));
vi.mock("../OAuthManualCodeForm", () => ({ OAuthManualCodeForm: () => null }));
vi.mock("../CustomProvidersSection", () => ({ CustomProvidersSection: () => null }));

function renderSection(providers: AuthProvider[]) {
  const handlers = {
    handleLogin: vi.fn(), handleLogout: vi.fn(), handleCancelLogin: vi.fn(),
    handleSaveApiKey: vi.fn(), handleClearApiKey: vi.fn(), handleSubmitManualCode: vi.fn(),
  };
  function Harness() {
    const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
    const [manualCodeInputs, setManualCodeInputs] = useState<Record<string, string>>({});
    const auth: AuthenticationSectionData = {
      addToast: vi.fn(), authProviders: providers, authLoading: false, authActionInProgress: null,
      apiKeyInputs, setApiKeyInputs, apiKeyErrors: {}, opencodeApiKeyRefreshStatus: {}, deviceCodes: {},
      loginInstructions: {}, manualCodeConfigs: {}, manualCodeInputs, setManualCodeInputs,
      manualCodeSubmitInProgress: null, loadAuthStatus: vi.fn(), ...handlers,
    };
    return <AuthenticationSection auth={auth} />;
  }
  render(<Harness />);
  return handlers;
}

describe("AuthenticationSection credential instances", () => {
  it("keeps a single account card free of pending account field chrome", () => {
    renderSection([{ id: "brave", name: "Brave", authenticated: true, type: "api_key", instances: [{ instanceId: "default", authenticated: true, isDefault: true, type: "api_key" }] }]);
    expect(screen.queryByTestId("auth-instances-brave")).not.toBeInTheDocument();
    expect(screen.getByText("Add another account")).toBeInTheDocument();
    expect(screen.queryByLabelText("Account name")).not.toBeInTheDocument();
    expect(screen.queryByTestId("auth-pending-instance-brave")).not.toBeInTheDocument();
  });

  it("scopes every multi-instance API-key save to its account and pending row", () => {
    const handlers = renderSection([{ id: "brave", name: "Brave", authenticated: true, type: "api_key", instances: [
      { instanceId: "default", label: "Primary", authenticated: true, isDefault: true, type: "api_key", keyHint: "abc••••defg" },
      { instanceId: "acct-two", label: "Second", authenticated: false, isDefault: false, type: "api_key" },
    ] }]);
    const list = screen.getByTestId("auth-instances-brave");
    const second = within(list).getByText("Second").closest(".auth-instance-row") as HTMLElement;
    fireEvent.change(within(second).getByPlaceholderText("Enter API key"), { target: { value: "second-key" } });
    fireEvent.click(within(second).getByText("Save"));
    expect(handlers.handleSaveApiKey).toHaveBeenLastCalledWith("brave", "acct-two", undefined);

    fireEvent.click(screen.getByText("Add another account"));
    const pending = screen.getByTestId("auth-pending-instance-brave");
    const accountName = within(pending).getByLabelText("Account name");
    expect(accountName).toHaveAttribute("id", "auth-pending-instance-brave-label");
    expect(accountName.closest(".auth-pending-instance-field")).toBeInTheDocument();
    fireEvent.change(accountName, { target: { value: "Work" } });
    expect(accountName).toHaveValue("Work");
    fireEvent.change(within(pending).getByPlaceholderText("Enter API key"), { target: { value: "pending-key" } });
    fireEvent.click(within(pending).getByText("Save"));
    expect(handlers.handleSaveApiKey).toHaveBeenLastCalledWith("brave", "acct-new", "Work");
    expect(within(pending).getByText("Cancel")).toBeInTheDocument();
  });

  it("binds OAuth instance actions to the selected instance and labels pending accounts", () => {
    const handlers = renderSection([{ id: "github-copilot", name: "GitHub", authenticated: true, type: "oauth", instances: [
      { instanceId: "default", authenticated: true, isDefault: true, type: "oauth" },
      { instanceId: "acct-two", authenticated: true, isDefault: false, type: "oauth" },
    ] }]);
    const row = within(screen.getByTestId("auth-instances-github-copilot")).getByText("acct-two").closest(".auth-instance-row") as HTMLElement;
    fireEvent.click(within(row).getByText("Logout"));
    expect(handlers.handleLogout).toHaveBeenCalledWith("github-copilot", "acct-two");

    fireEvent.click(screen.getByText("Add another account"));
    const pending = screen.getByTestId("auth-pending-instance-github-copilot");
    const accountName = within(pending).getByLabelText("Account name");
    expect(accountName).toHaveAttribute("id", "auth-pending-instance-github-copilot-label");
    fireEvent.change(accountName, { target: { value: "Personal" } });
    expect(accountName).toHaveValue("Personal");
    expect(within(pending).getByText("Cancel")).toBeInTheDocument();
    fireEvent.click(within(pending).getByText("Login"));
    expect(handlers.handleLogin).toHaveBeenCalledWith("github-copilot", "acct-new", "Personal");
  });

  /*
  FNXC:OAuthAlarmEvidence 2026-11-08-01:02 (RUFU-498):
  With the board banner lane-gated, Settings -> Authentication is where an expired leftover
  credential (e.g. the measured unreferenced `anthropic-subscription` default instance) is
  seen at all — so it must be removable exactly there. The expired single default instance
  gets the same instance row (with Remove) multi-account cards already render; a healthy
  single instance keeps its chrome-free card (the 2026-08-01 rule stands).
  */
  it("renders Remove for an expired single default instance and retires that instance", () => {
    renderSection([{
      id: "anthropic-subscription", name: "Anthropic Subscription", authenticated: false, expired: true, type: "oauth", laneReferenced: false,
      instances: [{ instanceId: "default", authenticated: false, expired: true, isDefault: true, type: "oauth" }],
    }]);
    const list = screen.getByTestId("auth-instances-anthropic-subscription");
    expect(within(list).getByText(/^default/)).toBeInTheDocument();
    /*
    FNXC:OAuthAlarmEvidence 2026-11-13-10:22 (RUFU-498 code-review P2):
    One credential, one set of actions. Rendering the instance rows for this shape used to leave
    the provider-level Login standing beside the row's own Login — two identical buttons on one
    card. The card now decides once (`rendersInstanceRows`) whether the rows or the provider
    header carries credential actions.
    */
    expect(screen.getAllByText("Login")).toHaveLength(1);
    expect(within(list).getByText("Login")).toBeInTheDocument();
    expect(within(list).getByText("Remove")).toBeInTheDocument();
    fireEvent.click(within(list).getByText("Remove"));
    expect(vi.mocked(removeProviderInstance)).toHaveBeenCalledWith("anthropic-subscription", "default");
  });

  it("keeps the durable login error on an expired single-instance card whose actions live in the row", () => {
    renderSection([{
      id: "anthropic-subscription", name: "Anthropic Subscription", authenticated: false, expired: true, type: "oauth", laneReferenced: false,
      loginError: "This OAuth session expired and could not be refreshed. Re-login to restore model access.",
      instances: [{ instanceId: "default", authenticated: false, expired: true, isDefault: true, type: "oauth" }],
    }]);
    // The rows own the actions; the provider-scoped remediation sentence must survive them.
    expect(screen.getAllByText("Login")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("Re-login to restore model access.");
  });

  it("keeps one credential action set per account on a multi-instance OAuth card", () => {
    renderSection([{
      id: "github-copilot", name: "GitHub", authenticated: false, expired: false, type: "oauth",
      instances: [
        { instanceId: "default", authenticated: true, isDefault: true, type: "oauth" },
        { instanceId: "acct-two", authenticated: false, isDefault: false, type: "oauth" },
      ],
    }]);
    expect(screen.getAllByText("Login")).toHaveLength(1);
    expect(screen.getAllByText("Logout")).toHaveLength(1);
  });

  it("keeps a healthy single OAuth instance card free of instance-list chrome", () => {
    renderSection([{
      id: "github-copilot", name: "GitHub", authenticated: true, type: "oauth",
      instances: [{ instanceId: "default", authenticated: true, isDefault: true, type: "oauth" }],
    }]);
    expect(screen.queryByTestId("auth-instances-github-copilot")).not.toBeInTheDocument();
    expect(screen.getByText("Add another account")).toBeInTheDocument();
  });
});
