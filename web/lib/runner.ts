const ID_KEY = 'ultracoach.runner_id';
const TOKEN_KEY = 'ultracoach.runner_token';

export type Identity = { userId: string; token: string };

let inFlight: Promise<Identity> | null = null;

/**
 * A device-scoped identity, so the runner never has to type who they are. The id is
 * minted by the backend together with a token; every later request proves the device
 * owns that id, so one browser cannot listen in on another runner's calls.
 */
export async function identity(): Promise<Identity> {
  const stored = readIdentity();
  if (stored) return stored;

  // Several callers on one page — the call screen and the products tab both mount at
  // once — must share a single registration, or the device ends up with two ids and a
  // split history. Web Locks extends that across tabs, where the browser has them.
  const pending =
    inFlight ??
    locked().finally(() => {
      inFlight = null;
    });
  inFlight = pending;
  return pending;
}

/** One registration at a time across tabs, where the browser supports it. */
async function locked(): Promise<Identity> {
  if (!navigator.locks) return register();
  return navigator.locks.request('ultracoach.identity', register);
}

async function register(): Promise<Identity> {
  const stored = readIdentity();
  if (stored) return stored;

  const response = await fetch(`${apiBase}/api/register`, { method: 'POST' });
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
  if (configured) return configured.replace(/\/$/, '');

  const host = typeof window === 'undefined' ? 'localhost' : window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return 'http://localhost:8000';

  console.error('NEXT_PUBLIC_API_BASE is not set; falling back to this origin');
  return '';
}

export const apiBase = resolveApiBase();

export function wsUrl(path: string): string {
  if (!apiBase) {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${window.location.host}${path}`;
  }
  const base = apiBase.startsWith('https') ? apiBase.replace('https', 'wss') : apiBase.replace('http', 'ws');
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
export async function fetchProducts(who: Identity, need = ''): Promise<Product[]> {
  const query = new URLSearchParams({ user_id: who.userId });
  if (need) query.set('need', need);

  const response = await fetch(`${apiBase}/api/products?${query}`, {
    headers: { authorization: `Bearer ${who.token}` },
  });
  if (!response.ok) {
    throw new Error(`products ${response.status}: ${await response.text()}`);
  }
  return (await response.json()).products;
}

export type Scenario = 'checkin' | 'races' | 'products' | 'excuse' | 'body';

export type WearableStatus = { available: boolean; connected: boolean; summary: string };

/** Whether the coach can see this runner's watch, and what it currently reads. */
export async function wearableStatus(who: Identity): Promise<WearableStatus> {
  const query = new URLSearchParams({ user_id: who.userId });
  const response = await fetch(`${apiBase}/api/wearable?${query}`, {
    headers: { authorization: `Bearer ${who.token}` },
  });
  if (!response.ok) {
    throw new Error(`wearable ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

/**
 * The connection page, opened in a new tab: the runner signs into Google there,
 * so no provider credential reaches this app — and there is still nothing to type here.
 */
export async function connectWearable(who: Identity): Promise<string> {
  const query = new URLSearchParams({ user_id: who.userId });
  const response = await fetch(`${apiBase}/api/wearable/connect?${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${who.token}` },
  });
  if (!response.ok) {
    throw new Error(`connect ${response.status}: ${await response.text()}`);
  }
  return (await response.json()).url;
}

/**
 * Ask the coach to ring now on a chosen subject. The coach still decides what it says
 * and still uses its own tools — this only skips the wait for its own schedule, so the
 * whole flow can be tried in seconds rather than at the next check-in hour.
 */
export async function demoCall(who: Identity, scenario: Scenario): Promise<void> {
  const query = new URLSearchParams({ user_id: who.userId });
  const response = await fetch(`${apiBase}/api/demo/call?${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${who.token}`,
    },
    body: JSON.stringify({ scenario }),
  });
  if (!response.ok) {
    throw new Error(`demo call ${response.status}: ${await response.text()}`);
  }
}

/** Push Healf recommendations to this device's screens, as the coach would mid-call. */
export async function demoProducts(who: Identity, need: string): Promise<void> {
  const query = new URLSearchParams({ user_id: who.userId, need });
  const response = await fetch(`${apiBase}/api/demo/products?${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${who.token}` },
  });
  if (!response.ok) {
    throw new Error(`demo products ${response.status}: ${await response.text()}`);
  }
}

export async function requestSession(who: Identity): Promise<SessionGrant> {
  const response = await fetch(`${apiBase}/api/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${who.token}`,
    },
    body: JSON.stringify({ user_id: who.userId }),
  });
  if (!response.ok) {
    throw new Error(`session ${response.status}: ${await response.text()}`);
  }
  return response.json();
}
