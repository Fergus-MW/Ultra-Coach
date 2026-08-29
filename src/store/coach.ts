import { create } from 'zustand';
import {
  apiBase,
  forgetIdentity,
  identity,
  wearableStatus,
  wsUrl,
  type Identity,
  type Product,
  type WearableStatus,
} from '../coach/api';

const RETRY_MS = 3000;

export type Phase = 'standby' | 'ringing' | 'connecting' | 'live' | 'ended';

export type IncomingCall = { openingLine: string; reason: string };

export type Pushed = { need: string; products: Product[] };

type Ring =
  | { type: 'incoming_call'; opening_line?: string; reason?: string }
  | { type: 'call_cancelled' }
  | { type: 'show_products'; need?: string; products?: Product[] }
  | { type: string };

export type CoachState = {
  who: Identity | null;
  online: boolean;
  phase: Phase;
  incoming: IncomingCall | null;
  pushed: Pushed | null;
  unseen: number;
  error: string;
  wearable: WearableStatus | null;
  /** Set by the call overlay, so a cancelled call can drop a live voice session. */
  endSession: () => void;
  listen: () => void;
  stopListening: () => void;
  receive: (payload: Ring) => void;
  tell: (type: 'call_answered' | 'call_declined') => void;
  setPhase: (phase: Phase) => void;
  setError: (error: string) => void;
  answered: () => void;
  decline: () => void;
  hangUp: () => void;
  seenProducts: () => void;
  refreshWearable: () => Promise<void>;
};

let socket: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let closed = true;

export const useCoach = create<CoachState>((set, get) => ({
  who: null,
  online: false,
  phase: 'standby',
  incoming: null,
  pushed: null,
  unseen: 0,
  error: '',
  wearable: null,
  endSession: () => {},

  listen: () => {
    if (!apiBase || socket) return;
    closed = false;
    void open(set, get);
  },

  stopListening: () => {
    closed = true;
    if (retry) clearTimeout(retry);
    retry = null;
    socket?.close();
    socket = null;
    set({ online: false });
  },

  receive: (payload) => {
    if (payload.type === 'call_cancelled') {
      // Another device took or refused the call; this one must neither keep ringing nor
      // carry on opening a second voice session for the same call.
      get().endSession();
      set((state) => ({
        incoming: null,
        phase: state.phase === 'live' ? 'ended' : 'standby',
      }));
      return;
    }
    if (payload.type === 'show_products') {
      const pushed = {
        need: 'need' in payload ? (payload.need ?? '') : '',
        products: ('products' in payload ? payload.products : undefined) ?? [],
      };
      set({ pushed, unseen: pushed.products.length });
      return;
    }
    if (payload.type !== 'incoming_call') return;

    set({
      incoming: {
        openingLine: 'opening_line' in payload ? (payload.opening_line ?? '') : '',
        reason: 'reason' in payload ? (payload.reason ?? '') : '',
      },
      phase: 'ringing',
      error: '',
    });
  },

  tell: (type) => socket?.send(JSON.stringify({ type })),

  setPhase: (phase) => set({ phase }),
  setError: (error) => set({ error }),

  answered: () => {
    // Only a connected session counts as answered: a denied microphone or a failed
    // token must not go into the runner's history as a call they took.
    get().tell('call_answered');
    set({ phase: 'live' });
  },

  decline: () => {
    get().tell('call_declined');
    set({ phase: 'standby', incoming: null });
  },

  hangUp: () => {
    get().endSession();
    set({ phase: 'standby', incoming: null });
  },

  seenProducts: () => set({ unseen: 0 }),

  refreshWearable: async () => {
    const who = get().who;
    if (!who) return;
    try {
      set({ wearable: await wearableStatus(who) });
    } catch {
      // A coach that cannot read the watch is still a coach.
    }
  },
}));

type Set = (partial: Partial<CoachState>) => void;
type Get = () => CoachState;

async function open(set: Set, get: Get): Promise<void> {
  let who = get().who;
  try {
    who = who ?? (await identity());
  } catch (cause) {
    set({ error: cause instanceof Error ? cause.message : String(cause) });
    return;
  }
  if (closed) return;

  set({ who, error: '' });
  void get().refreshWearable();

  const next = new WebSocket(wsUrl(apiBase, `/ws/${who.userId}?token=${encodeURIComponent(who.token)}`));
  socket = next;

  next.onopen = () => set({ online: true });
  next.onmessage = (event: { data: string }) => {
    try {
      get().receive(JSON.parse(event.data) as Ring);
    } catch {
      // A malformed frame is not worth dropping the connection over.
    }
  };
  next.onclose = (event: { code: number }) => {
    set({ online: false });
    socket = null;
    if (closed) return;
    if (event.code === 1008) {
      // The backend rejected the stored token, so retrying it forever would leave this
      // phone permanently unreachable. Register again instead.
      void forgetIdentity().then(() => set({ who: null }));
    }
    retry = setTimeout(() => void open(set, get), RETRY_MS);
  };
}
