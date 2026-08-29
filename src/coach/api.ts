import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

const ID_KEY = 'ultracoach.runner_id';
const TOKEN_KEY = 'ultracoach.runner_token';

export type Identity = { userId: string; token: string };

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

export type WearableStatus = { available: boolean; connected: boolean; summary: string };

export type Scenario = 'checkin' | 'races' | 'products' | 'excuse' | 'body';

/** Where the coaching backend lives. A build can point at a local one instead. */
export function resolveApiBase(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE?.trim();
  const extra = Constants.expoConfig?.extra as { apiBase?: string } | undefined;
  const configured = fromEnv || extra?.apiBase?.trim() || '';
  return configured.replace(/\/$/, '');
}

export const apiBase = resolveApiBase();

export function wsUrl(base: string, path: string): string {
  return `${base.replace(/^http/, 'ws')}${path}`;
}

let inFlight: Promise<Identity> | null = null;

/**
 * A device-scoped identity, so the runner never types who they are. The backend mints
 * the id with a token, and every later request proves this device owns that id: one
 * phone cannot listen in on another runner's calls.
 */
export async function identity(): Promise<Identity> {
  const stored = await readIdentity();
  if (stored) return stored;

  // The coach tab and the products tab both ask on mount; two registrations would give
  // the device two ids and split its history in half.
  const pending =
    inFlight ??
    register().finally(() => {
      inFlight = null;
    });
  inFlight = pending;
  return pending;
}

async function register(): Promise<Identity> {
  const stored = await readIdentity();
  if (stored) return stored;

  const created = await request<{ user_id: string; token: string }>('POST', '/api/register');
  await SecureStore.setItemAsync(ID_KEY, created.user_id);
  await SecureStore.setItemAsync(TOKEN_KEY, created.token);
  return { userId: created.user_id, token: created.token };
}

async function readIdentity(): Promise<Identity | null> {
  const userId = await SecureStore.getItemAsync(ID_KEY);
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  return userId && token ? { userId, token } : null;
}

/** Drop a token the backend no longer accepts, so the next `identity()` registers again. */
export async function forgetIdentity(): Promise<void> {
  await SecureStore.deleteItemAsync(ID_KEY);
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<T> {
  if (!apiBase) throw new Error('No coaching backend configured for this build.');

  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    throw new Error(`${path} ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

/** The phone's own zone: the coach orders a session for "5 a.m." and has to mean theirs. */
function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/** The token and agent for one call, plus the signed identity the webhook demands. */
export function requestSession(who: Identity): Promise<SessionGrant> {
  return request<SessionGrant>('POST', '/api/session', {
    token: who.token,
    body: { user_id: who.userId, timezone: deviceZone() },
  });
}

/** Healf's range, read through the backend so the tab and the coach agree on it. */
export async function fetchProducts(who: Identity, need = ''): Promise<Product[]> {
  const query = new URLSearchParams({ user_id: who.userId });
  if (need) query.set('need', need);
  const payload = await request<{ products: Product[] }>('GET', `/api/products?${query}`, {
    token: who.token,
  });
  return payload.products;
}

/** Whether the coach can see this runner's watch, and what it currently reads. */
export function wearableStatus(who: Identity): Promise<WearableStatus> {
  const query = new URLSearchParams({ user_id: who.userId });
  return request<WearableStatus>('GET', `/api/wearable?${query}`, { token: who.token });
}

/**
 * The provider's own consent page, opened in the phone's browser, so no provider
 * credential reaches the app and there is still nothing to type.
 */
export async function connectWearable(who: Identity): Promise<string> {
  const query = new URLSearchParams({ user_id: who.userId });
  const payload = await request<{ url: string }>('POST', `/api/wearable/connect?${query}`, {
    token: who.token,
  });
  return payload.url;
}

/** Revoke the consent, so the runner can grant it again from scratch. */
export function disconnectWearable(who: Identity): Promise<WearableStatus> {
  const query = new URLSearchParams({ user_id: who.userId });
  return request<WearableStatus>('POST', `/api/wearable/disconnect?${query}`, {
    token: who.token,
  });
}

/**
 * Ask the coach to ring now on a chosen subject. It still decides what it says and
 * still uses its own tools; this only skips the wait for its own schedule.
 */
export async function demoCall(who: Identity, scenario: Scenario): Promise<void> {
  const query = new URLSearchParams({ user_id: who.userId });
  await request('POST', `/api/demo/call?${query}`, { token: who.token, body: { scenario } });
}

/** Push Healf recommendations to this device, as the coach would mid-call. */
export async function demoProducts(who: Identity, need: string): Promise<void> {
  const query = new URLSearchParams({ user_id: who.userId, need });
  await request('POST', `/api/demo/products?${query}`, { token: who.token });
}
