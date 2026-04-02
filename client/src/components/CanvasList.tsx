import { useState, useEffect } from "react";
import type { CanvasSummary } from "../types.ts";
import { getCanvases, createCanvas, ApiError } from "../api.ts";
import { clearAuth, getStoredUser } from "../authStore.ts";

interface CanvasListProps {
  onSelectCanvas: (canvasId: string) => void;
  onLogout: () => void;
}

export default function CanvasList({
  onSelectCanvas,
  onLogout,
}: CanvasListProps) {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const user = getStoredUser();

  useEffect(() => {
    let cancelled = false;
    getCanvases()
      .then((data) => {
        if (!cancelled) {
          setCanvases(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          if (err instanceof ApiError && err.status === 401) {
            handleLogout();
          } else {
            setError("Failed to load canvases.");
            setLoading(false);
          }
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogout = () => {
    clearAuth();
    onLogout();
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setError("");
    try {
      const canvas = await createCanvas({ name: newName.trim() });
      setCanvases((prev) => [...prev, canvas]);
      setNewName("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        handleLogout();
      } else {
        setError("Failed to create canvas.");
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>My Canvases</h1>
        <div style={styles.headerRight}>
          <span style={styles.username}>{user?.username}</span>
          <button style={styles.logoutBtn} onClick={handleLogout}>
            Log out
          </button>
        </div>
      </div>

      <form onSubmit={handleCreate} style={styles.createForm}>
        <input
          style={styles.input}
          type="text"
          placeholder="New canvas name..."
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          required
        />
        <button type="submit" style={styles.createBtn} disabled={creating}>
          {creating ? "Creating..." : "Create Canvas"}
        </button>
      </form>

      {error && <div style={styles.error}>{error}</div>}

      {loading ? (
        <p style={styles.emptyText}>Loading...</p>
      ) : canvases.length === 0 ? (
        <p style={styles.emptyText}>
          No canvases yet. Create one to get started.
        </p>
      ) : (
        <div style={styles.list}>
          {canvases.map((c) => (
            <button
              key={c.id}
              style={styles.canvasItem}
              onClick={() => onSelectCanvas(c.id)}
            >
              <span style={styles.canvasName}>{c.name}</span>
              <span style={styles.canvasDate}>
                {new Date(c.createdAt).toLocaleDateString()}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 640,
    margin: "0 auto",
    padding: "24px 16px",
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 24,
  },
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  title: {
    margin: 0,
    fontSize: 22,
    fontWeight: 700,
  },
  username: {
    fontSize: 14,
    color: "#666",
  },
  logoutBtn: {
    background: "none",
    border: "1px solid #ccc",
    borderRadius: 4,
    padding: "4px 12px",
    cursor: "pointer",
    fontSize: 13,
    color: "#333",
  },
  createForm: {
    display: "flex",
    gap: 8,
    marginBottom: 16,
  },
  input: {
    flex: 1,
    padding: "8px 12px",
    borderRadius: 4,
    border: "1px solid #ccc",
    fontSize: 14,
  },
  createBtn: {
    padding: "8px 16px",
    borderRadius: 4,
    border: "none",
    background: "#0088ff",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  error: {
    color: "#e74c3c",
    fontSize: 13,
    padding: "6px 10px",
    background: "#fef2f2",
    borderRadius: 4,
    marginBottom: 12,
  },
  emptyText: {
    color: "#888",
    textAlign: "center" as const,
    marginTop: 40,
  },
  list: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  },
  canvasItem: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    background: "#fff",
    cursor: "pointer",
    textAlign: "left" as const,
    fontSize: 14,
    transition: "background 0.15s",
  },
  canvasName: {
    fontWeight: 600,
    color: "#222",
  },
  canvasDate: {
    color: "#888",
    fontSize: 12,
  },
};
