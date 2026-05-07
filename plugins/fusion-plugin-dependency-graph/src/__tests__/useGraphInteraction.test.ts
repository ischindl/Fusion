import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useGraphInteraction } from "../useGraphInteraction";

describe("useGraphInteraction", () => {
  it("starts with default pan/zoom", () => {
    const { result } = renderHook(() => useGraphInteraction());
    expect(result.current.zoom).toBe(1);
    expect(result.current.pan).toEqual({ x: 0, y: 0 });
  });

  it("clamps zoom between 0.1 and 3", () => {
    const { result } = renderHook(() => useGraphInteraction());

    act(() => {
      for (let i = 0; i < 100; i += 1) result.current.zoomOut();
    });
    expect(result.current.zoom).toBe(0.1);

    act(() => {
      for (let i = 0; i < 100; i += 1) result.current.zoomIn();
    });
    expect(result.current.zoom).toBe(3);
  });

  it("fits single node", () => {
    const { result } = renderHook(() => useGraphInteraction());
    act(() => {
      result.current.fitToGraph(new Map([["A", { x: 0, y: 0 }]]), 800, 600);
    });

    expect(result.current.zoom).toBeGreaterThan(0.1);
    expect(result.current.zoom).toBeLessThanOrEqual(3);
  });

  it("fits wide graph", () => {
    const { result } = renderHook(() => useGraphInteraction());
    act(() => {
      result.current.fitToGraph(new Map([
        ["A", { x: 0, y: 0 }],
        ["B", { x: 2000, y: 0 }],
      ]), 800, 600);
    });

    expect(result.current.zoom).toBeLessThan(1);
  });

  it("fits tall graph", () => {
    const { result } = renderHook(() => useGraphInteraction());
    act(() => {
      result.current.fitToGraph(new Map([
        ["A", { x: 0, y: 0 }],
        ["B", { x: 0, y: 2000 }],
      ]), 800, 600);
    });

    expect(result.current.zoom).toBeLessThan(1);
  });

  it("resets when positions are empty", () => {
    const { result } = renderHook(() => useGraphInteraction());

    act(() => {
      result.current.zoomIn();
      result.current.onPointerDown(1, { x: 10, y: 10 });
      result.current.onPointerMove(1, { x: 110, y: 60 }, 800, 600);
      result.current.onPointerUp(1);
      result.current.fitToGraph(new Map(), 800, 600);
    });

    expect(result.current.zoom).toBe(1);
    expect(result.current.pan).toEqual({ x: 0, y: 0 });
  });

  it("resetView restores defaults", () => {
    const { result } = renderHook(() => useGraphInteraction());

    act(() => {
      result.current.zoomIn();
      result.current.onPointerDown(1, { x: 0, y: 0 });
      result.current.onPointerMove(1, { x: 200, y: 200 }, 800, 600);
      result.current.onPointerUp(1);
      result.current.resetView();
    });

    expect(result.current.zoom).toBe(1);
    expect(result.current.pan).toEqual({ x: 0, y: 0 });
  });
});
