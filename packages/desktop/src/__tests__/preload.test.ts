import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const contextBridge = {
    exposeInMainWorld: vi.fn(),
  };

  const ipcRenderer = {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };

  return { contextBridge, ipcRenderer };
});

vi.mock("electron", () => ({
  contextBridge: mocks.contextBridge,
  ipcRenderer: mocks.ipcRenderer,
}));

async function importPreloadModule() {
  await import("../preload.ts");
}

function getExposed<T = unknown>(name: string): T | undefined {
  return mocks.contextBridge.exposeInMainWorld.mock.calls.find(([key]) => key === name)?.[1] as T | undefined;
}

describe("preload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("exposes electronAPI and fusionShell", async () => {
    await importPreloadModule();

    expect(getExposed("electronAPI")).toBeTruthy();
    expect(getExposed("fusionAPI")).toBeTruthy();
    expect(getExposed("fusionShell")).toBeTruthy();
  });

  it("electronAPI delegates getServerPort to IPC", async () => {
    await importPreloadModule();
    const api = getExposed<{ getServerPort: () => Promise<number | undefined> }>("electronAPI");

    await api?.getServerPort();

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("app:getServerPort");
  });

  it("electronAPI launch mode methods delegate to IPC", async () => {
    await importPreloadModule();
    const api = getExposed<{
      getDesktopLaunchMode: () => Promise<string>;
      setDesktopLaunchMode: (mode: "choose" | "local" | "remote") => Promise<string>;
    }>("electronAPI");

    await api?.getDesktopLaunchMode();
    await api?.setDesktopLaunchMode("local");

    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("desktopLaunchMode:getMode");
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith("desktopLaunchMode:setMode", "local");
  });

  it("fusionShell subscribes and unsubscribes state listener", async () => {
    await importPreloadModule();
    const shell = getExposed<{ subscribe: (listener: (state: unknown) => void) => () => void }>("fusionShell");

    const unsubscribe = shell?.subscribe(() => undefined);
    expect(mocks.ipcRenderer.on).toHaveBeenCalledWith("shell:state", expect.any(Function));

    unsubscribe?.();

    expect(mocks.ipcRenderer.removeListener).toHaveBeenCalledWith("shell:state", expect.any(Function));
  });
});
