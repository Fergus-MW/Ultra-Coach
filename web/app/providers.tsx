"use client";

import { ConversationProvider } from "@elevenlabs/react";
import type { PropsWithChildren } from "react";

export default function Providers({ children }: PropsWithChildren) {
  return <ConversationProvider>{children}</ConversationProvider>;
}
