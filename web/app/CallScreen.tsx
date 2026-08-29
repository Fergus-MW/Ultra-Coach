"use client";

import { useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { identity, type Identity, requestSession, wsUrl } from "@/lib/runner";
import { Ringtone } from "@/lib/ringtone";
import styles from "./call.module.css";

type Screen = "standby" | "ringing" | "connecting" | "live" | "ended";

type IncomingCall = { opening_line: string; reason: string };

export default function CallScreen() {
  const [screen, setScreen] = useState<Screen>("standby");
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState("");

  const socket = useRef<WebSocket | null>(null);
  const ringtone = useRef<Ringtone | null>(null);
  const who = useRef<Identity | null>(null);

  const conversation = useConversation({
    onConnect: () => setScreen("live"),
    onDisconnect: () => setScreen("ended"),
    onError: (message: string) => {
      setError(message);
      setScreen("ended");
    },
  });

  const silence = useCallback(() => {
    ringtone.current?.stop();
    ringtone.current = null;
  }, []);

  useEffect(() => {
    let closed = false;
    let retry: number | undefined;

    const connect = (me: Identity) => {
      if (closed) return;
      const next = new WebSocket(
        wsUrl(`/ws/${me.userId}?token=${encodeURIComponent(me.token)}`),
      );
      socket.current = next;

      next.onopen = () => setOnline(true);
      next.onclose = () => {
        setOnline(false);
        if (!closed) retry = window.setTimeout(() => connect(me), 3000);
      };
      next.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type !== "incoming_call") return;

        setIncoming({ opening_line: payload.opening_line, reason: payload.reason });
        setScreen("ringing");
        ringtone.current = new Ringtone();
        ringtone.current.start();
      };
    };

    identity()
      .then((me) => {
        who.current = me;
        connect(me);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));

    return () => {
      closed = true;
      window.clearTimeout(retry);
      socket.current?.close();
      ringtone.current?.stop();
    };
  }, []);

  const answer = useCallback(async () => {
    silence();
    setError("");
    setScreen("connecting");
    socket.current?.send(JSON.stringify({ type: "call_answered" }));

    try {
      const me = who.current;
      if (!me) throw new Error("no runner identity yet");

      const grant = await requestSession(me);
      await navigator.mediaDevices.getUserMedia({ audio: true });
      conversation.startSession({
        conversationToken: grant.conversation_token,
        connectionType: "webrtc",
        dynamicVariables: { runner_id: me.userId },
        overrides: {
          agent: {
            prompt: { prompt: grant.runner_state },
            firstMessage: incoming?.opening_line,
          },
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setScreen("ended");
    }
  }, [conversation, incoming, silence]);

  const decline = useCallback(() => {
    silence();
    socket.current?.send(JSON.stringify({ type: "call_declined" }));
    setScreen("standby");
    setIncoming(null);
  }, [silence]);

  const hangUp = useCallback(() => {
    conversation.endSession();
    setScreen("standby");
    setIncoming(null);
  }, [conversation]);

  const speaking = conversation.isSpeaking;

  return (
    <main className={styles.screen} data-screen={screen}>
      <div className={styles.status}>
        <span className={online ? styles.dotOn : styles.dotOff} />
        {online ? "Coach can reach you" : "Reconnecting"}
      </div>

      {screen === "standby" && (
        <section className={styles.centre}>
          <h1 className={styles.idleTitle}>Ultra Coach</h1>
          <p className={styles.idleBody}>
            Keep this open. The coach calls you — there is nothing to fill in.
          </p>
        </section>
      )}

      {screen === "ringing" && incoming && (
        <section className={styles.centre}>
          <div className={`${styles.avatar} ${styles.pulsing}`}>UC</div>
          <h1 className={styles.caller}>Ultra Coach</h1>
          <p className={styles.reason}>{incoming.reason}</p>
          <div className={styles.actions}>
            <button className={styles.decline} onClick={decline} aria-label="Decline call">
              Decline
            </button>
            <button className={styles.answer} onClick={answer} aria-label="Answer call">
              Answer
            </button>
          </div>
        </section>
      )}

      {screen === "connecting" && (
        <section className={styles.centre}>
          <div className={`${styles.avatar} ${styles.pulsing}`}>UC</div>
          <p className={styles.reason}>Connecting…</p>
        </section>
      )}

      {screen === "live" && (
        <section className={styles.centre}>
          <div className={`${styles.avatar} ${speaking ? styles.speaking : styles.listening}`}>
            UC
          </div>
          <h1 className={styles.caller}>{speaking ? "Coach is talking" : "Go on, answer"}</h1>
          <div className={styles.actions}>
            <button
              className={styles.mute}
              onClick={() => conversation.setMuted(!conversation.isMuted)}
              aria-label={conversation.isMuted ? "Unmute microphone" : "Mute microphone"}
            >
              {conversation.isMuted ? "Unmute" : "Mute"}
            </button>
            <button className={styles.decline} onClick={hangUp} aria-label="Hang up">
              Hang up
            </button>
          </div>
        </section>
      )}

      {screen === "ended" && (
        <section className={styles.centre}>
          <h1 className={styles.caller}>Call ended</h1>
          {error && <p className={styles.error}>{error}</p>}
          <button className={styles.answer} onClick={() => setScreen("standby")}>
            Back to standby
          </button>
        </section>
      )}
    </main>
  );
}
