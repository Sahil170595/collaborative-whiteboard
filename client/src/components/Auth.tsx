import { useState } from "react";
import { signup, login, ApiError } from "../api.ts";
import { storeAuth } from "../authStore.ts";

interface AuthProps {
  initialMode: "login" | "signup";
  onAuth: () => void;
}

export default function Auth({ initialMode, onAuth }: AuthProps) {
  const [mode, setMode] = useState<"login" | "signup">(initialMode);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (mode === "signup") {
        const res = await signup({ username, email, password });
        storeAuth(res.token, res.user);
      } else {
        const res = await login({ username, password });
        storeAuth(res.token, res.user);
      }
      onAuth();
    } catch (err) {
      if (err instanceof ApiError) {
        const messages: Record<string, string> = {
          username_taken: "Username is already taken.",
          email_taken: "Email is already in use.",
          invalid_credentials: "Invalid username or password.",
        };
        setError(messages[err.code] || err.code);
      } else {
        setError("Network error. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Whiteboard</h1>
        <h2 style={styles.subtitle}>
          {mode === "login" ? "Log In" : "Sign Up"}
        </h2>
        <form onSubmit={handleSubmit} style={styles.form}>
          <label style={styles.label}>
            Username
            <input
              style={styles.input}
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
            />
          </label>
          {mode === "signup" && (
            <label style={styles.label}>
              Email
              <input
                style={styles.input}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </label>
          )}
          <label style={styles.label}>
            Password
            <input
              style={styles.input}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={4}
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
            />
          </label>
          {error && <div style={styles.error}>{error}</div>}
          <button type="submit" style={styles.button} disabled={loading}>
            {loading
              ? "Please wait..."
              : mode === "login"
                ? "Log In"
                : "Sign Up"}
          </button>
        </form>
        <p style={styles.switchText}>
          {mode === "login" ? (
            <>
              Don&apos;t have an account?{" "}
              <button
                style={styles.link}
                onClick={() => {
                  setMode("signup");
                  setError("");
                }}
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button
                style={styles.link}
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
              >
                Log in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "100vh",
    background: "#f0f2f5",
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  card: {
    background: "#fff",
    borderRadius: 8,
    padding: "40px 32px",
    boxShadow: "0 2px 12px rgba(0,0,0,0.1)",
    width: 360,
    maxWidth: "90vw",
  },
  title: {
    margin: "0 0 4px",
    fontSize: 24,
    fontWeight: 700,
    textAlign: "center" as const,
  },
  subtitle: {
    margin: "0 0 24px",
    fontSize: 16,
    fontWeight: 400,
    textAlign: "center" as const,
    color: "#666",
  },
  form: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 16,
  },
  label: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    fontSize: 14,
    fontWeight: 500,
    color: "#333",
  },
  input: {
    padding: "8px 12px",
    borderRadius: 4,
    border: "1px solid #ccc",
    fontSize: 14,
    outline: "none",
  },
  button: {
    padding: "10px 16px",
    borderRadius: 4,
    border: "none",
    background: "#0088ff",
    color: "#fff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 4,
  },
  error: {
    color: "#e74c3c",
    fontSize: 13,
    padding: "6px 10px",
    background: "#fef2f2",
    borderRadius: 4,
  },
  switchText: {
    textAlign: "center" as const,
    marginTop: 16,
    fontSize: 13,
    color: "#666",
  },
  link: {
    background: "none",
    border: "none",
    color: "#0088ff",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
    padding: 0,
    textDecoration: "underline",
  },
};
