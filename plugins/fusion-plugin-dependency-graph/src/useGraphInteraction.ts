import { useCallback, useMemo, useRef, useState } from "react";
import type { LayoutOptions } from "./layout";
import type { GraphPosition } from "./types";

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
const FIT_PADDING = 40;

interface PointerPoint {
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function useGraphInteraction() {
  const [pan, setPan] = useState<PointerPoint>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const dragStateRef = useRef<{ start: PointerPoint; panStart: PointerPoint } | null>(null);
  const pointersRef = useRef<Map<number, PointerPoint>>(new Map());
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null);

  const transform = useMemo(() => `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, [pan.x, pan.y, zoom]);

  const zoomIn = useCallback(() => {
    setZoom((current) => clamp(current + 0.1, MIN_ZOOM, MAX_ZOOM));
  }, []);
  const zoomOut = useCallback(() => {
    setZoom((current) => clamp(current - 0.1, MIN_ZOOM, MAX_ZOOM));
  }, []);

  const resetView = useCallback(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, []);

  const clampPan = useCallback((nextPan: PointerPoint, viewportWidth: number, viewportHeight: number) => ({
    x: clamp(nextPan.x, -viewportWidth, viewportWidth),
    y: clamp(nextPan.y, -viewportHeight, viewportHeight),
  }), []);

  const fitToGraph = useCallback((
    positions: Map<string, GraphPosition>,
    viewportWidth: number,
    viewportHeight: number,
    layoutOptions?: LayoutOptions,
  ) => {
    if (positions.size === 0) {
      resetView();
      return;
    }

    const nodeWidth = layoutOptions?.nodeWidth ?? 280;
    const nodeHeight = layoutOptions?.nodeHeight ?? 100;

    const entries = Array.from(positions.values());
    const minX = Math.min(...entries.map((p) => p.x));
    const minY = Math.min(...entries.map((p) => p.y));
    const maxX = Math.max(...entries.map((p) => p.x + nodeWidth));
    const maxY = Math.max(...entries.map((p) => p.y + nodeHeight));

    const graphWidth = Math.max(1, maxX - minX);
    const graphHeight = Math.max(1, maxY - minY);
    const availableWidth = Math.max(1, viewportWidth - FIT_PADDING * 2);
    const availableHeight = Math.max(1, viewportHeight - FIT_PADDING * 2);
    const nextZoom = clamp(Math.min(availableWidth / graphWidth, availableHeight / graphHeight), MIN_ZOOM, MAX_ZOOM);

    const panX = (viewportWidth - graphWidth * nextZoom) / 2 - minX * nextZoom;
    const panY = (viewportHeight - graphHeight * nextZoom) / 2 - minY * nextZoom;

    setZoom(nextZoom);
    setPan(clampPan({ x: panX, y: panY }, viewportWidth, viewportHeight));
  }, [clampPan, resetView]);

  const onPointerDown = useCallback((pointerId: number, point: PointerPoint) => {
    pointersRef.current.set(pointerId, point);
    if (pointersRef.current.size === 2) {
      const [a, b] = Array.from(pointersRef.current.values());
      pinchRef.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom };
      dragStateRef.current = null;
      return;
    }
    dragStateRef.current = { start: point, panStart: pan };
  }, [pan, zoom]);

  const onPointerMove = useCallback((pointerId: number, point: PointerPoint, viewportWidth: number, viewportHeight: number) => {
    if (pointersRef.current.has(pointerId)) pointersRef.current.set(pointerId, point);

    if (pointersRef.current.size >= 2 && pinchRef.current) {
      const [a, b] = Array.from(pointersRef.current.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const factor = distance / Math.max(1, pinchRef.current.distance);
      setZoom(clamp(pinchRef.current.zoom * factor, MIN_ZOOM, MAX_ZOOM));
      return;
    }

    const dragState = dragStateRef.current;
    if (!dragState) return;
    const nextPan = {
      x: dragState.panStart.x + (point.x - dragState.start.x),
      y: dragState.panStart.y + (point.y - dragState.start.y),
    };
    setPan(clampPan(nextPan, viewportWidth, viewportHeight));
  }, [clampPan]);

  const onPointerUp = useCallback((pointerId: number) => {
    pointersRef.current.delete(pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    if (pointersRef.current.size === 0) dragStateRef.current = null;
  }, []);

  const onWheelZoom = useCallback((
    deltaY: number,
    point: PointerPoint,
    viewportWidth: number,
    viewportHeight: number,
  ) => {
    const factor = deltaY < 0 ? 1.1 : 0.9;
    const nextZoom = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const scaleRatio = nextZoom / zoom;

    const nextPan = {
      x: point.x - (point.x - pan.x) * scaleRatio,
      y: point.y - (point.y - pan.y) * scaleRatio,
    };

    setZoom(nextZoom);
    setPan(clampPan(nextPan, viewportWidth, viewportHeight));
  }, [clampPan, pan.x, pan.y, zoom]);

  return {
    pan,
    zoom,
    transform,
    zoomIn,
    zoomOut,
    resetView,
    fitToGraph,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onWheelZoom,
  };
}
