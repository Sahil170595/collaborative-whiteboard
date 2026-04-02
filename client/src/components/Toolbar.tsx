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

const tools: { id: Tool; label: string }[] = [
  { id: "select", label: "Select" },
  { id: "rectangle", label: "Rect" },
  { id: "ellipse", label: "Ellipse" },
  { id: "line", label: "Line" },
  { id: "text", label: "Text" },
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
    <div style={styles.toolbar}>
      <button style={styles.backBtn} onClick={onBack} title="Back to canvas list">
        &larr; Back
      </button>

      <div style={styles.separator} />

      {tools.map((t) => (
        <button
          key={t.id}
          style={{
            ...styles.toolBtn,
            ...(currentTool === t.id ? styles.activeTool : {}),
          }}
          onClick={() => onToolChange(t.id)}
          title={t.label}
        >
          {t.label}
        </button>
      ))}

      <div style={styles.separator} />

      <label style={styles.colorLabel} title="Fill color">
        Fill
        <input
          type="color"
          value={fillColor}
          onChange={(e) => onFillChange(e.target.value)}
          style={styles.colorInput}
        />
      </label>
      <label style={styles.colorLabel} title="Stroke color">
        Stroke
        <input
          type="color"
          value={strokeColor}
          onChange={(e) => onStrokeChange(e.target.value)}
          style={styles.colorInput}
        />
      </label>

      <div style={styles.separator} />

      <button
        style={{
          ...styles.toolBtn,
          opacity: canUndo ? 1 : 0.4,
        }}
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo (Ctrl+Z)"
      >
        Undo
      </button>
      <button
        style={{
          ...styles.toolBtn,
          opacity: canRedo ? 1 : 0.4,
        }}
        onClick={onRedo}
        disabled={!canRedo}
        title="Redo (Ctrl+Shift+Z)"
      >
        Redo
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "6px 12px",
    background: "#fff",
    borderBottom: "1px solid #ddd",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: 13,
    flexShrink: 0,
  },
  backBtn: {
    padding: "4px 10px",
    border: "1px solid #ccc",
    borderRadius: 4,
    background: "#f8f8f8",
    cursor: "pointer",
    fontSize: 13,
    color: "#333",
  },
  separator: {
    width: 1,
    height: 24,
    background: "#ddd",
    margin: "0 6px",
  },
  toolBtn: {
    padding: "4px 10px",
    border: "1px solid #ccc",
    borderRadius: 4,
    background: "#f8f8f8",
    cursor: "pointer",
    fontSize: 13,
    color: "#333",
  },
  activeTool: {
    background: "#0088ff",
    color: "#fff",
    borderColor: "#0077dd",
  },
  colorLabel: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 12,
    color: "#555",
    cursor: "pointer",
  },
  colorInput: {
    width: 24,
    height: 24,
    padding: 0,
    border: "1px solid #ccc",
    borderRadius: 4,
    cursor: "pointer",
  },
};
