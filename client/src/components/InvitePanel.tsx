import { useState } from "react";
import type { PresenceUser } from "../types.ts";
import { inviteToCanvas, ApiError } from "../api.ts";

interface InvitePanelProps {
  canvasId: string;
  onlineUsers: PresenceUser[];
}

export default function InvitePanel({ canvasId, onlineUsers }: InvitePanelProps) {
  const [identifier, setIdentifier] = useState("");
  const [message, setMessage] = useState("");
  const [messageType, setMessageType] = useState<"success" | "error">("success");
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim()) return;
    setSending(true);
    setMessage("");
    try {
      await inviteToCanvas(canvasId, { identifier: identifier.trim() });
      setMessage("Invitation sent!");
      setMessageType("success");
      setIdentifier("");
    } catch (err) {
      if (err instanceof ApiError) {
        const messages: Record<string, string> = {
          user_not_found: "User not found.",
          canvas_not_found: "Canvas not found.",
          not_a_member: "You are not a member of this canvas.",
        };
        setMessage(messages[err.code] || err.code);
      } else {
        setMessage("Failed to send invitation.");
      }
      setMessageType("error");
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={styles.panel}>
      <button
        style={styles.toggleBtn}
        onClick={() => setExpanded(!expanded)}
      >
        Users ({onlineUsers.length}) {expanded ? "\u25B2" : "\u25BC"}
      </button>

      {expanded && (
        <div style={styles.content}>
          <div style={styles.userList}>
            {onlineUsers.map((u) => (
              <div key={u.userId} style={styles.userItem}>
                <span
                  style={{
                    ...styles.dot,
                    background: u.color,
                  }}
                />
                <span>{u.username}</span>
              </div>
            ))}
          </div>

          <form onSubmit={handleInvite} style={styles.form}>
            <input
              style={styles.input}
              type="text"
              placeholder="Username or email..."
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
            />
            <button type="submit" style={styles.inviteBtn} disabled={sending}>
              {sending ? "..." : "Invite"}
            </button>
          </form>

          {message && (
            <div
              style={{
                ...styles.message,
                color: messageType === "error" ? "#e74c3c" : "#27ae60",
                background:
                  messageType === "error" ? "#fef2f2" : "#f0fdf4",
              }}
            >
              {message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: "absolute",
    top: 8,
    right: 8,
    zIndex: 100,
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontSize: 13,
  },
  toggleBtn: {
    padding: "6px 12px",
    border: "1px solid #ccc",
    borderRadius: 4,
    background: "#fff",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
    boxShadow: "0 1px 4px rgba(0,0,0,0.1)",
  },
  content: {
    marginTop: 4,
    padding: 12,
    background: "#fff",
    border: "1px solid #ddd",
    borderRadius: 6,
    boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
    minWidth: 200,
  },
  userList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    marginBottom: 12,
  },
  userItem: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    display: "inline-block",
    flexShrink: 0,
  },
  form: {
    display: "flex",
    gap: 4,
  },
  input: {
    flex: 1,
    padding: "4px 8px",
    border: "1px solid #ccc",
    borderRadius: 4,
    fontSize: 12,
  },
  inviteBtn: {
    padding: "4px 10px",
    border: "none",
    borderRadius: 4,
    background: "#0088ff",
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
  message: {
    marginTop: 8,
    padding: "4px 8px",
    borderRadius: 4,
    fontSize: 12,
  },
};
