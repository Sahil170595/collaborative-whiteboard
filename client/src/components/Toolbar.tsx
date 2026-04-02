import type { ShapeType } from "../types.ts";

export type Tool = ShapeType | "select";

interface ToolbarProps {
  currentTool: Tool;
  onToolChange: (tool: Tool) => void;
  fillColor: string;
  strokeColor: string;
  onFillChange: (color: string) => void;
  onStrokeChange: (color: string) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onBack: () => void;
}

const PALETTE = [
  "#1e1e1e", "#e03131", "#e8590c", "#fcc419",
  "#40c057", "#228be6", "#7950f2", "#ffffff",
];

// SVG icon paths — minimal, geometric
const icons: Record<Tool, string> = {
  select:
    "M4 2l12 9.5-5.3 1.8L14.5 22 11 20l-3.8-8.7L4 13V2z",
  rectangle:
    "M4 5h16v14H4z",
  ellipse:
    "M12 6c4.4 0 8 2.7 8 6s-3.6 6-8 6-8-2.7-8-6 3.6-6 8-6z",
  line:
    "M4 20L20 4",
  text:
    "M5 6h14M12 6v14M9 20h6",
};

function ToolIcon({ tool, active }: { tool: Tool; active: boolean }) {
  const isStroke = tool === "line" || tool === "text";
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill={isStroke ? "none" : active ? "#fff" : "#c1c1c1"}
      stroke={isStroke || tool === "select" ? (active ? "#fff" : "#c1c1c1") : "none"}
      strokeWidth={isStroke ? 2.2 : tool === "select" ? 1.5 : 0}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {tool === "rectangle" ? (
        <rect x="4" y="5" width="16" height="14" rx="1.5" fill={active ? "#fff" : "#c1c1c1"} stroke="none" />
      ) : (
        <path d={icons[tool]} />
      )}
    </svg>
  );
}

function UndoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10h13a4 4 0 010 8H9" />
      <path d="M7 6l-4 4 4 4" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10H8a4 4 0 000 8h7" />
      <path d="M17 6l4 4-4 4" />
    </svg>
  );
}

const tools: { id: Tool; label: string; shortcut: string }[] = [
  { id: "select", label: "Select", shortcut: "V" },
  { id: "rectangle", label: "Rectangle", shortcut: "R" },
  { id: "ellipse", label: "Ellipse", shortcut: "O" },
  { id: "line", label: "Line", shortcut: "L" },
  { id: "text", label: "Text", shortcut: "T" },
];

export default function Toolbar({
  currentTool,
  onToolChange,
  fillColor,
  strokeColor,
  onFillChange,
  onStrokeChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onBack,
}: ToolbarProps) {
  return (
    <>
      {/* Back button — top left, minimal */}
      <button onClick={onBack} style={s.backBtn} title="Back to canvases">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="2" strokeLinecap="round">
          <path d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      {/* Floating bottom toolbar */}
      <div style={s.bar}>
        {/* Tool group */}
        <div style={s.group}>
          {tools.map((t) => (
            <button
              key={t.id}
              onClick={() => onToolChange(t.id)}
              title={`${t.label} (${t.shortcut})`}
              style={{
                ...s.btn,
                background: currentTool === t.id ? "#5b5bff" : "transparent",
              }}
            >
              <ToolIcon tool={t.id} active={currentTool === t.id} />
            </button>
          ))}
        </div>

        <div style={s.sep} />

        {/* Color group */}
        <div style={s.group}>
          <div style={s.colorSection}>
            <span style={s.colorLabel}>Fill</span>
            <div style={s.swatchRow}>
              {PALETTE.map((c) => (
                <button
                  key={`fill-${c}`}
                  onClick={() => onFillChange(c)}
                  title={c}
                  style={{
                    ...s.swatch,
                    background: c,
                    boxShadow: fillColor === c ? "0 0 0 2px #5b5bff" : c === "#ffffff" ? "inset 0 0 0 1px #444" : "none",
                  }}
                />
              ))}
              <label style={s.customColor}>
                <span style={{ ...s.swatch, background: fillColor, cursor: "pointer" }}>
                  <span style={s.plusIcon}>+</span>
                </span>
                <input
                  type="color"
                  value={fillColor}
                  onChange={(e) => onFillChange(e.target.value)}
                  style={s.hiddenInput}
                />
              </label>
            </div>
          </div>
          <div style={s.colorSection}>
            <span style={s.colorLabel}>Stroke</span>
            <div style={s.swatchRow}>
              {PALETTE.map((c) => (
                <button
                  key={`stroke-${c}`}
                  onClick={() => onStrokeChange(c)}
                  title={c}
                  style={{
                    ...s.swatch,
                    background: c,
                    boxShadow: strokeColor === c ? "0 0 0 2px #5b5bff" : c === "#ffffff" ? "inset 0 0 0 1px #444" : "none",
                  }}
                />
              ))}
              <label style={s.customColor}>
                <span style={{ ...s.swatch, background: strokeColor, cursor: "pointer" }}>
                  <span style={s.plusIcon}>+</span>
                </span>
                <input
                  type="color"
                  value={strokeColor}
                  onChange={(e) => onStrokeChange(e.target.value)}
                  style={s.hiddenInput}
                />
              </label>
            </div>
          </div>
        </div>

        <div style={s.sep} />

        {/* Undo/redo group */}
        <div style={s.group}>
          <button
            onClick={onUndo}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            style={{ ...s.btn, opacity: canUndo ? 1 : 0.3 }}
          >
            <UndoIcon />
          </button>
          <button
            onClick={onRedo}
            disabled={!canRedo}
            title="Redo (Ctrl+Shift+Z)"
            style={{ ...s.btn, opacity: canRedo ? 1 : 0.3 }}
          >
            <RedoIcon />
          </button>
        </div>
      </div>
    </>
  );
}

const s: Record<string, React.CSSProperties> = {
  backBtn: {
    position: "fixed",
    top: 14,
    left: 14,
    zIndex: 200,
    width: 36,
    height: 36,
    borderRadius: 8,
    border: "none",
    background: "rgba(255,255,255,0.9)",
    backdropFilter: "blur(8px)",
    boxShadow: "0 1px 6px rgba(0,0,0,0.1), 0 0 0 1px rgba(0,0,0,0.05)",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  bar: {
    position: "fixed",
    bottom: 16,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 200,
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "6px 10px",
    background: "#2c2c2c",
    borderRadius: 12,
    boxShadow: "0 4px 24px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.06)",
  },
  group: {
    display: "flex",
    alignItems: "center",
    gap: 2,
  },
  sep: {
    width: 1,
    height: 28,
    background: "rgba(255,255,255,0.1)",
    margin: "0 6px",
  },
  btn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    border: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#c1c1c1",
    transition: "background 0.12s",
  },
  colorSection: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
  },
  colorLabel: {
    fontSize: 9,
    fontWeight: 600,
    color: "#888",
    textTransform: "uppercase" as const,
    letterSpacing: 0.8,
    fontFamily: "'DM Mono', monospace",
  },
  swatchRow: {
    display: "flex",
    gap: 3,
    alignItems: "center",
  },
  swatch: {
    width: 18,
    height: 18,
    borderRadius: 4,
    border: "none",
    cursor: "pointer",
    padding: 0,
    transition: "box-shadow 0.12s, transform 0.12s",
    position: "relative" as const,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  customColor: {
    position: "relative" as const,
    display: "flex",
    cursor: "pointer",
  },
  plusIcon: {
    fontSize: 11,
    fontWeight: 700,
    color: "rgba(255,255,255,0.5)",
    mixBlendMode: "difference" as const,
  },
  hiddenInput: {
    position: "absolute" as const,
    width: 0,
    height: 0,
    opacity: 0,
    overflow: "hidden" as const,
  },
};
