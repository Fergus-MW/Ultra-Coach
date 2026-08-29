const ID_KEY = "ultracoach.runner_id";
const TOKEN_KEY = "ultracoach.runner_token";

export type Identity = { userId: string; token: string };

/**
 * A device-scoped identity, so the runner never has to type who they are. The id is
 * minted by the backend together with a token; every later request proves the device
 * owns that id, so one browser cannot listen in on another runner's calls.
 */
export async function identity(): Promise<Identity> {
  const stored = readIdentity();
  if (stored) return stored;

  // Two tabs opening a fresh device would otherwise each register, splitting the
  // runner's history between two ids, so registration happens one tab at a time.
  if (navigator.locks) {
    return navigator.locks.request("ultracoach.identity", () => register());
  }
  return register();
}

async function register(): Promise<Identity> {
  const stored = readIdentity();
  if (stored) return stored;

  const response = await fetch(`${apiBase}/api/register`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`register ${response.status}: ${await response.text()}`);
  }
  const created = await response.json();
  window.localStorage.setItem(ID_KEY, created.user_id);
  window.localStorage.setItem(TOKEN_KEY, created.token);
  return { userId: created.user_id, token: created.token };
}

function readIdentity(): Identity | null {
  const userId = window.localStorage.getItem(ID_KEY);
  const token = window.localStorage.getItem(TOKEN_KEY);
  return userId && token ? { userId, token } : null;
}

/** Drop a token the backend no longer accepts, so the next `identity()` registers again. */
export function forgetIdentity(): void {
  window.localStorage.removeItem(ID_KEY);
  window.localStorage.removeItem(TOKEN_KEY);
}

/**
 * Falling back to localhost away from a developer's machine would send a runner's
 * identity and call requests to whatever answers on their own port 8000, so the
 * default only applies while the page itself is served locally.
 */
function resolveApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE?.trim();
  if (configured) return configured.replace(/\/$/, "");

  const host = typeof window === "undefined" ? "localhost" : window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return "http://localhost:8000";

  console.error("NEXT_PUBLIC_API_BASE is not set; falling back to this origin");
  return "";
}

export const apiBase = resolveApiBase();

export function wsUrl(path: string): string {
  if (!apiBase) {
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${window.location.host}${path}`;
  }
  const base = apiBase.startsWith("https")
    ? apiBase.replace("https", "wss")
    : apiBase.replace("http", "ws");
  return `${base}${path}`;
}

export type SessionGrant = {
  conversation_token: string;
  agent_id: string;
  runner_state: string;
  runner_sig: string;
};

export type Product = {
  handle: string;
  title: string;
  url: string;
  image: string;
  brand: string;
  price: string;
  currency: string;
  description: string;
};

/** Healf's range, read through the backend so the tab and the coach agree on it. */
export async function fetchProducts(who: Identity, need = ""): Promise<Product[]> {
  const query = new URLSearchParams({ user_id: who.userId });
  if (need) query.set("need", need);

  const response = await fetch(`${apiBase}/api/products?${query}`, {
    headers: { authorization: `Bearer ${who.token}` },
  });
  if (!response.ok) {
    throw new Error(`products ${response.status}: ${await response.text()}`);
  }
  return (await response.json()).products;
}

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
