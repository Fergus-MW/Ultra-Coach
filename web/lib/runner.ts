const ID_KEY = "ultracoach.runner_id";
const TOKEN_KEY = "ultracoach.runner_token";

export type Identity = { userId: string; token: string };

/**
 * A device-scoped identity, so the runner never has to type who they are. The id is
 * minted by the backend together with a token; every later request proves the device
 * owns that id, so one browser cannot listen in on another runner's calls.
 */
export async function identity(): Promise<Identity> {
  const userId = window.localStorage.getItem(ID_KEY);
  const token = window.localStorage.getItem(TOKEN_KEY);
  if (userId && token) return { userId, token };

  const response = await fetch(`${apiBase}/api/register`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`register ${response.status}: ${await response.text()}`);
  }
  const created = await response.json();
  window.localStorage.setItem(ID_KEY, created.user_id);
  window.localStorage.setItem(TOKEN_KEY, created.token);
  return { userId: created.user_id, token: created.token };
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

export async function requestSession(who: Identity): Promise<SessionGrant> {
  const response = await fetch(`${apiBase}/api/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${who.token}`,
    },
    body: JSON.stringify({ user_id: who.userId }),
  });
  if (!response.ok) {
    throw new Error(`session ${response.status}: ${await response.text()}`);
  }
  return response.json();
}
