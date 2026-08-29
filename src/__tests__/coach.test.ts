import { wsUrl } from '../coach/api';
import { useCoach } from '../store/coach';

const CLEAN = {
  phase: 'standby' as const,
  incoming: null,
  pushed: null,
  unseen: 0,
  error: '',
  callSeq: 0,
  endSession: () => {},
};

beforeEach(() => useCoach.setState(CLEAN));

describe('the ring socket', () => {
  it('rings the runner when the coach calls', () => {
    useCoach.getState().receive({ type: 'incoming_call', opening_line: 'Get up.', reason: 'Missed session' });

    expect(useCoach.getState().phase).toBe('ringing');
    expect(useCoach.getState().incoming).toEqual({
      openingLine: 'Get up.',
      reason: 'Missed session',
    });
  });

  it('stops ringing when another device takes the call', () => {
    const ended = jest.fn();
    useCoach.setState({ endSession: ended });
    useCoach.getState().receive({ type: 'incoming_call' });
    useCoach.getState().receive({ type: 'call_cancelled' });

    expect(ended).toHaveBeenCalled();
    expect(useCoach.getState().phase).toBe('standby');
    expect(useCoach.getState().incoming).toBeNull();
  });

  it('ends a live call rather than sending it back to standby', () => {
    useCoach.setState({ phase: 'live' });
    useCoach.getState().receive({ type: 'call_cancelled' });

    expect(useCoach.getState().phase).toBe('ended');
  });

  it('holds what the coach pushed, and how much of it is unseen', () => {
    useCoach.getState().receive({
      type: 'show_products',
      need: 'cramp',
      products: [
        { handle: 'a', title: 'A', url: '', image: '', brand: '', price: '', currency: '', description: '' },
      ],
    });

    expect(useCoach.getState().pushed?.need).toBe('cramp');
    expect(useCoach.getState().unseen).toBe(1);

    useCoach.getState().seenProducts();
    expect(useCoach.getState().unseen).toBe(0);
  });

  it('marks the call gone, so an answer still awaiting a token knows to drop it', () => {
    useCoach.getState().receive({ type: 'incoming_call' });
    const seq = useCoach.getState().callSeq;

    useCoach.getState().receive({ type: 'call_cancelled' });
    expect(useCoach.getState().callSeq).not.toBe(seq);
  });

  it('ignores anything else the backend says', () => {
    useCoach.getState().receive({ type: 'pong' });

    expect(useCoach.getState().phase).toBe('standby');
  });
});

describe('the backend address', () => {
  it('rings over the same scheme the api is served on', () => {
    expect(wsUrl('https://ultracoach-api.onrender.com', '/ws/me')).toBe(
      'wss://ultracoach-api.onrender.com/ws/me',
    );
    expect(wsUrl('http://localhost:8000', '/ws/me')).toBe('ws://localhost:8000/ws/me');
  });
});
