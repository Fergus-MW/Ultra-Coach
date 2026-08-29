const STORAGE_KEY = "ultracoach.runner_id";

/** A device-scoped identity, so the runner never has to type who they are. */
export function runnerId(): string {
  const existing = window.localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;

  const created = `runner_${crypto.randomUUID()}`;
  window.localStorage.setItem(STORAGE_KEY, created);
  return created;
}

export const apiBase = (
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000"
).replace(/\/$/, "");

export function wsUrl(path: string): string {
  const base = apiBase.startsWith("https")
    ? apiBase.replace("https", "wss")
    : apiBase.replace("http", "ws");
  return `${base}${path}`;
}

export type SessionGrant = {
  conversation_token: string;
  agent_id: string;
  runner_state: string;
};

export async function requestSession(userId: string): Promise<SessionGrant> {
  const response = await fetch(`${apiBase}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!response.ok) {
    throw new Error(`session ${response.status}: ${await response.text()}`);
  }
  return response.json();
}
