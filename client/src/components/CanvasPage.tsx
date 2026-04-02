import { useEffect, useRef, useCallback, useState } from "react";
import type {
  Shape,
  ShapeType,
  ShapePatch,
  Operation,
  UndoEntry,
  PresenceUser,
  ServerMessage,
  ClientMessage,
} from "../types.ts";
import { getStoredToken } from "../authStore.ts";
import { getCanvasDetail, ApiError } from "../api.ts";
import { renderScene, hitTest, hitTestHandle } from "../canvasRenderer.ts";
import type { CursorInfo } from "../canvasRenderer.ts";
import { applyOp } from "../operations.ts";
import Toolbar from "./Toolbar.tsx";
import type { Tool } from "./Toolbar.tsx";
import InvitePanel from "./InvitePanel.tsx";

interface CanvasPageProps {
  canvasId: string;
  onBack: () => void;
  onLogout: () => void;
}

// Interaction mode during mouse drag
type DragMode =
  | { kind: "none" }
  | { kind: "draw"; startX: number; startY: number; previewShape: Shape }
  | {
      kind: "move";
      shapeId: string;
      startX: number;
      startY: number;
      origX: number;
      origY: number;
    }
  | {
      kind: "resize";
      shapeId: string;
      corner: string;
      startX: number;
      startY: number;
      origX: number;
      origY: number;
      origW: number;
      origH: number;
    };

export default function CanvasPage({
  canvasId,
  onBack,
  onLogout,
}: CanvasPageProps) {
  // --- State stored in refs for high-frequency access ---
  const shapesRef = useRef<Shape[]>([]);
  const undoStackRef = useRef<UndoEntry[]>([]);
  const redoStackRef = useRef<UndoEntry[]>([]);
  const pendingOpsRef = useRef<Set<string>>(new Set());
  const cursorsRef = useRef<Map<string, CursorInfo>>(new Map());
  const onlineUsersRef = useRef<PresenceUser[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  const dragModeRef = useRef<DragMode>({ kind: "none" });
  const wsRef = useRef<WebSocket | null>(null);
  const seqRef = useRef<number>(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastCursorSendRef = useRef<number>(0);
  const mountedRef = useRef(false);
  const wsInitReceivedRef = useRef(false);

  // --- React state for UI that needs re-renders ---
  const [currentTool, setCurrentTool] = useState<Tool>("select");
  const [fillColor, setFillColor] = useState("#3498db");
  const [strokeColor, setStrokeColor] = useState("#000000");
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [onlineUsers, setOnlineUsers] = useState<PresenceUser[]>([]);
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState("");

  // --- Rendering ---
  const scheduleRender = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    const selection = selectedIdRef.current
      ? {
          shapeId: selectedIdRef.current,
          handles: [],
        }
      : null;

    const drag = dragModeRef.current;
    const preview = drag.kind === "draw" ? drag.previewShape : null;

    renderScene(
      ctx,
      shapesRef.current,
      selection,
      cursorsRef.current,
      preview,
      rect.width,
      rect.height,
      dpr
    );
  }, []);

  const renderRef = useRef(scheduleRender);
  renderRef.current = scheduleRender;

  const requestRender = useCallback(() => {
    requestAnimationFrame(() => renderRef.current());
  }, []);

  // --- WebSocket Send Helpers ---
  const sendWs = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const sendOp = useCallback(
    (op: Operation) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return; // drop if not connected
      const opId = crypto.randomUUID();
      // Apply optimistically
      shapesRef.current = applyOp(shapesRef.current, op);
      pendingOpsRef.current.add(opId);
      ws.send(JSON.stringify({ type: "op", op, opId } satisfies ClientMessage));
      requestRender();
    },
    [requestRender]
  );

  const doAction = useCallback(
    (forward: Operation, reverse: Operation) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return; // don't push undo for unsent ops
      undoStackRef.current = [...undoStackRef.current, { forward, reverse }];
      redoStackRef.current = [];
      setUndoCount(undoStackRef.current.length);
      setRedoCount(0);
      sendOp(forward);
    },
    [sendOp]
  );

  // --- Undo/Redo ---
  const undo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1];
    undoStackRef.current = stack.slice(0, -1);
    redoStackRef.current = [...redoStackRef.current, entry];
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
    sendOp(entry.reverse);
  }, [sendOp]);

  const redo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1];
    redoStackRef.current = stack.slice(0, -1);
    undoStackRef.current = [...undoStackRef.current, entry];
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
    sendOp(entry.forward);
  }, [sendOp]);

  // --- Color change for selected shape ---
  // Track the color before the picker opens for a single undo entry
  const colorBeforeRef = useRef<{ fill: string; stroke: string }>({ fill: "", stroke: "" });
  const colorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleFillChange = useCallback(
    (color: string) => {
      setFillColor(color);
      const selId = selectedIdRef.current;
      if (!selId) return;
      // Capture original color on first change of a drag
      if (!colorBeforeRef.current.fill) {
        const shape = shapesRef.current.find((s) => s.id === selId);
        if (shape) colorBeforeRef.current.fill = shape.fill;
      }
      // Apply visually immediately
      shapesRef.current = shapesRef.current.map((s) =>
        s.id === selId ? { ...s, fill: color } : s
      );
      requestRender();
      // Debounce: send one op after picker settles
      if (colorTimerRef.current) clearTimeout(colorTimerRef.current);
      colorTimerRef.current = setTimeout(() => {
        const origFill = colorBeforeRef.current.fill;
        colorBeforeRef.current.fill = "";
        if (origFill && origFill !== color) {
          // Revert visual, then go through doAction for proper undo entry
          shapesRef.current = shapesRef.current.map((s) =>
            s.id === selId ? { ...s, fill: origFill } : s
          );
          doAction(
            { kind: "update", shapeId: selId, props: { fill: color } },
            { kind: "update", shapeId: selId, props: { fill: origFill } }
          );
        }
      }, 300);
    },
    [doAction, requestRender]
  );

  const handleStrokeChange = useCallback(
    (color: string) => {
      setStrokeColor(color);
      const selId = selectedIdRef.current;
      if (!selId) return;
      if (!colorBeforeRef.current.stroke) {
        const shape = shapesRef.current.find((s) => s.id === selId);
        if (shape) colorBeforeRef.current.stroke = shape.stroke;
      }
      shapesRef.current = shapesRef.current.map((s) =>
        s.id === selId ? { ...s, stroke: color } : s
      );
      requestRender();
      if (colorTimerRef.current) clearTimeout(colorTimerRef.current);
      colorTimerRef.current = setTimeout(() => {
        const origStroke = colorBeforeRef.current.stroke;
        colorBeforeRef.current.stroke = "";
        if (origStroke && origStroke !== color) {
          shapesRef.current = shapesRef.current.map((s) =>
            s.id === selId ? { ...s, stroke: origStroke } : s
          );
          doAction(
            { kind: "update", shapeId: selId, props: { stroke: color } },
            { kind: "update", shapeId: selId, props: { stroke: origStroke } }
          );
        }
      }, 300);
    },
    [doAction, requestRender]
  );

  // --- Canvas coordinate helper ---
  const getCanvasCoords = useCallback(
    (e: MouseEvent): { x: number; y: number } => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    },
    []
  );

  // --- Mouse Handlers ---
  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      e.preventDefault(); // prevent text selection during drag
      const { x, y } = getCanvasCoords(e);

      // Text tool: prompt for text and create shape
      if (currentTool === "text") {
        const text = prompt("Enter text:");
        if (!text) return;
        const fontSize = 20;
        const newShape: Shape = {
          id: crypto.randomUUID(),
          type: "text",
          x,
          y,
          width: text.length * fontSize * 0.6,
          height: fontSize,
          fill: fillColor,
          stroke: strokeColor,
          strokeWidth: 0,
          text,
          fontSize,
        };
        const forward: Operation = { kind: "add", shape: newShape };
        const reverse: Operation = { kind: "delete", shapeId: newShape.id };
        doAction(forward, reverse);
        selectedIdRef.current = newShape.id;
        requestRender();
        return;
      }

      // Select tool: hit test
      if (currentTool === "select") {
        // Check if clicking on a resize handle of selected shape
        const selId = selectedIdRef.current;
        if (selId) {
          const selShape = shapesRef.current.find((s) => s.id === selId);
          if (selShape) {
            const corner = hitTestHandle(selShape, x, y);
            if (corner) {
              dragModeRef.current = {
                kind: "resize",
                shapeId: selId,
                corner,
                startX: x,
                startY: y,
                origX: selShape.x,
                origY: selShape.y,
                origW: selShape.width,
                origH: selShape.height,
              };
              return;
            }
          }
        }

        // Hit test shapes
        const hit = hitTest(shapesRef.current, x, y);
        if (hit) {
          selectedIdRef.current = hit.id;
          dragModeRef.current = {
            kind: "move",
            shapeId: hit.id,
            startX: x,
            startY: y,
            origX: hit.x,
            origY: hit.y,
          };
          requestRender();
        } else {
          selectedIdRef.current = null;
          dragModeRef.current = { kind: "none" };
          requestRender();
        }
        return;
      }

      // Drawing tools: start preview shape
      const shapeType = currentTool as ShapeType;
      const previewShape: Shape = {
        id: crypto.randomUUID(),
        type: shapeType,
        x,
        y,
        width: 0,
        height: 0,
        fill: shapeType === "line" ? "" : fillColor,
        stroke: strokeColor,
        strokeWidth: 2,
      };
      dragModeRef.current = {
        kind: "draw",
        startX: x,
        startY: y,
        previewShape,
      };
      requestRender();
    },
    [currentTool, fillColor, strokeColor, getCanvasCoords, doAction, requestRender]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const { x, y } = getCanvasCoords(e);

      // Send cursor position throttled
      const now = Date.now();
      if (now - lastCursorSendRef.current >= 30) {
        lastCursorSendRef.current = now;
        sendWs({ type: "cursor", x, y });
      }

      const drag = dragModeRef.current;

      if (drag.kind === "draw") {
        const dx = x - drag.startX;
        const dy = y - drag.startY;
        drag.previewShape = {
          ...drag.previewShape,
          x: dx < 0 ? drag.startX + dx : drag.startX,
          y: dy < 0 ? drag.startY + dy : drag.startY,
          width: Math.abs(dx),
          height: Math.abs(dy),
        };
        // For line, keep the original start and use delta as width/height
        if (drag.previewShape.type === "line") {
          drag.previewShape.x = drag.startX;
          drag.previewShape.y = drag.startY;
          drag.previewShape.width = dx;
          drag.previewShape.height = dy;
        }
        requestRender();
        return;
      }

      if (drag.kind === "move") {
        const dx = x - drag.startX;
        const dy = y - drag.startY;
        // Update local shape position for live preview (non-optimistic, just visual)
        shapesRef.current = shapesRef.current.map((s) =>
          s.id === drag.shapeId
            ? { ...s, x: drag.origX + dx, y: drag.origY + dy }
            : s
        );
        requestRender();
        return;
      }

      if (drag.kind === "resize") {
        const dx = x - drag.startX;
        const dy = y - drag.startY;
        let newX = drag.origX;
        let newY = drag.origY;
        let newW = drag.origW;
        let newH = drag.origH;

        if (drag.corner.includes("e")) {
          newW = drag.origW + dx;
        }
        if (drag.corner.includes("w")) {
          newX = drag.origX + dx;
          newW = drag.origW - dx;
        }
        if (drag.corner.includes("s")) {
          newH = drag.origH + dy;
        }
        if (drag.corner.includes("n")) {
          newY = drag.origY + dy;
          newH = drag.origH - dy;
        }

        shapesRef.current = shapesRef.current.map((s) =>
          s.id === drag.shapeId
            ? { ...s, x: newX, y: newY, width: newW, height: newH }
            : s
        );
        requestRender();
        return;
      }
    },
    [getCanvasCoords, sendWs, requestRender]
  );

  const handleMouseUp = useCallback(
    (_e: MouseEvent) => {
      const drag = dragModeRef.current;

      if (drag.kind === "draw") {
        const shape = drag.previewShape;
        // Only add if shape has some size (or is a line with any length)
        if (
          Math.abs(shape.width) > 2 ||
          Math.abs(shape.height) > 2
        ) {
          const forward: Operation = { kind: "add", shape };
          const reverse: Operation = { kind: "delete", shapeId: shape.id };
          doAction(forward, reverse);
          selectedIdRef.current = shape.id;
        }
        dragModeRef.current = { kind: "none" };
        requestRender();
        return;
      }

      if (drag.kind === "move") {
        const shape = shapesRef.current.find((s) => s.id === drag.shapeId);
        if (shape && (shape.x !== drag.origX || shape.y !== drag.origY)) {
          // Revert local change, then do proper action through undo system
          shapesRef.current = shapesRef.current.map((s) =>
            s.id === drag.shapeId
              ? { ...s, x: drag.origX, y: drag.origY }
              : s
          );
          const forward: Operation = {
            kind: "update",
            shapeId: drag.shapeId,
            props: { x: shape.x, y: shape.y },
          };
          const reverse: Operation = {
            kind: "update",
            shapeId: drag.shapeId,
            props: { x: drag.origX, y: drag.origY },
          };
          doAction(forward, reverse);
        }
        dragModeRef.current = { kind: "none" };
        requestRender();
        return;
      }

      if (drag.kind === "resize") {
        const shape = shapesRef.current.find((s) => s.id === drag.shapeId);
        if (shape) {
          const newProps: ShapePatch = {
            x: shape.x,
            y: shape.y,
            width: shape.width,
            height: shape.height,
          };
          const oldProps: ShapePatch = {
            x: drag.origX,
            y: drag.origY,
            width: drag.origW,
            height: drag.origH,
          };
          // Revert local change, then go through undo system
          shapesRef.current = shapesRef.current.map((s) =>
            s.id === drag.shapeId
              ? { ...s, ...oldProps }
              : s
          );
          const forward: Operation = {
            kind: "update",
            shapeId: drag.shapeId,
            props: newProps,
          };
          const reverse: Operation = {
            kind: "update",
            shapeId: drag.shapeId,
            props: oldProps,
          };
          doAction(forward, reverse);
        }
        dragModeRef.current = { kind: "none" };
        requestRender();
        return;
      }
    },
    [doAction, requestRender]
  );

  // --- Keyboard Handlers ---
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Undo: Ctrl+Z (not Shift)
      if (e.ctrlKey && !e.shiftKey && e.key === "z") {
        e.preventDefault();
        undo();
        return;
      }
      // Redo: Ctrl+Shift+Z or Ctrl+Y
      if (
        (e.ctrlKey && e.shiftKey && e.key === "Z") ||
        (e.ctrlKey && e.key === "y")
      ) {
        e.preventDefault();
        redo();
        return;
      }
      // Delete selected shape
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedIdRef.current
      ) {
        e.preventDefault();
        const shapeId = selectedIdRef.current;
        const shape = shapesRef.current.find((s) => s.id === shapeId);
        if (shape) {
          const forward: Operation = { kind: "delete", shapeId };
          const reverse: Operation = { kind: "add", shape: { ...shape } };
          selectedIdRef.current = null;
          doAction(forward, reverse);
          requestRender();
        }
        return;
      }
    },
    [undo, redo, doAction, requestRender]
  );

  // --- Canvas Resize ---
  const resizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    requestRender();
  }, [requestRender]);

  // --- WebSocket Connection ---
  useEffect(() => {
    // StrictMode double-mount guard
    if (mountedRef.current) return;
    mountedRef.current = true;

    const token = getStoredToken();
    if (!token) {
      onLogout();
      return;
    }

    // Load initial canvas data via HTTP as fallback — WS init takes precedence
    getCanvasDetail(canvasId)
      .then((detail) => {
        if (!wsInitReceivedRef.current) {
          shapesRef.current = detail.shapes;
          requestRender();
        }
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          setError("Access denied.");
        } else {
          setError("Failed to load canvas.");
        }
      });

    // Connect WebSocket
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws?canvasId=${canvasId}&token=${token}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }

      switch (msg.type) {
        case "init":
          wsInitReceivedRef.current = true;
          shapesRef.current = msg.shapes;
          seqRef.current = msg.seq;
          onlineUsersRef.current = msg.users;
          // Clear stale state from previous session (C3+C4)
          undoStackRef.current = [];
          redoStackRef.current = [];
          pendingOpsRef.current.clear();
          setUndoCount(0);
          setRedoCount(0);
          setOnlineUsers([...msg.users]);
          requestRender();
          break;

        case "op": {
          const isOwnEcho = pendingOpsRef.current.has(msg.opId);
          if (isOwnEcho) {
            pendingOpsRef.current.delete(msg.opId);
          }
          // For "add" ops that we sent: skip (shape already in array).
          // For "update"/"delete" ops: ALWAYS re-apply from server to
          // guarantee server-authoritative ordering under concurrent edits.
          if (isOwnEcho && msg.op.kind === "add") {
            // Already added optimistically — skip to avoid duplicate
          } else {
            shapesRef.current = applyOp(shapesRef.current, msg.op);
            requestRender();
          }
          seqRef.current = msg.seq;
          break;
        }

        case "cursor":
          cursorsRef.current.set(msg.userId, {
            x: msg.x,
            y: msg.y,
            username: msg.username,
            color:
              onlineUsersRef.current.find((u) => u.userId === msg.userId)
                ?.color || "#999",
          });
          requestRender();
          break;

        case "join":
          onlineUsersRef.current = [
            ...onlineUsersRef.current.filter(
              (u) => u.userId !== msg.user.userId
            ),
            msg.user,
          ];
          setOnlineUsers([...onlineUsersRef.current]);
          break;

        case "leave":
          onlineUsersRef.current = onlineUsersRef.current.filter(
            (u) => u.userId !== msg.userId
          );
          setOnlineUsers([...onlineUsersRef.current]);
          cursorsRef.current.delete(msg.userId);
          requestRender();
          break;

        case "error":
          setError(msg.message);
          break;
      }
    };

    ws.onclose = (event) => {
      setWsConnected(false);
      if (event.code === 4001) {
        // JWT expired or invalid — force re-login
        onLogout();
      }
    };

    ws.onerror = () => {
      setError("WebSocket connection error.");
    };

    return () => {
      mountedRef.current = false;
      ws.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId]);

  // --- Event Listeners ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.addEventListener("mousedown", handleMouseDown);
    canvas.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", resizeCanvas);

    // Initial size
    resizeCanvas();

    return () => {
      canvas.removeEventListener("mousedown", handleMouseDown);
      canvas.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", resizeCanvas);
    };
  }, [handleMouseDown, handleMouseMove, handleMouseUp, handleKeyDown, resizeCanvas]);

  // Cursor style based on tool
  const getCursorStyle = (): string => {
    if (currentTool === "select") return "default";
    if (currentTool === "text") return "text";
    return "crosshair";
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <Toolbar
        currentTool={currentTool}
        onToolChange={setCurrentTool}
        fillColor={fillColor}
        strokeColor={strokeColor}
        onFillChange={handleFillChange}
        onStrokeChange={handleStrokeChange}
        canUndo={undoCount > 0}
        canRedo={redoCount > 0}
        onUndo={undo}
        onRedo={redo}
        onBack={onBack}
      />

      <div
        ref={containerRef}
        style={{
          flex: 1,
          position: "relative",
          background: "#f5f5f5",
          overflow: "hidden",
        }}
      >
        <canvas
          ref={canvasRef}
          style={{
            display: "block",
            cursor: getCursorStyle(),
          }}
        />
        <InvitePanel canvasId={canvasId} onlineUsers={onlineUsers} />

        {/* Connection status indicator */}
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
            color: wsConnected ? "#27ae60" : "#e74c3c",
            background: "#fff",
            padding: "3px 8px",
            borderRadius: 4,
            boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: wsConnected ? "#27ae60" : "#e74c3c",
            }}
          />
          {wsConnected ? "Connected" : "Disconnected"}
        </div>

        {error && (
          <div
            style={{
              position: "absolute",
              bottom: 8,
              right: 8,
              background: "#fef2f2",
              color: "#e74c3c",
              padding: "6px 12px",
              borderRadius: 4,
              fontSize: 12,
              boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
              cursor: "pointer",
            }}
            onClick={() => setError("")}
          >
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
