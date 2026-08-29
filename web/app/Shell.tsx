"use client";

import { useCallback, useState } from "react";

import type { Product } from "@/lib/runner";
import CallScreen from "./CallScreen";
import Products from "./Products";
import styles from "./shell.module.css";

type Tab = "coach" | "products";

type Pushed = { need: string; products: Product[] };

export default function Shell() {
  const [tab, setTab] = useState<Tab>("coach");
  const [recommended, setRecommended] = useState<Pushed | null>(null);
  const [unseen, setUnseen] = useState(0);

  // The coach owns the screen: recommending products moves the runner to them rather
  // than leaving a notification to be found later.
  const onProducts = useCallback((need: string, products: Product[]) => {
    setRecommended({ need, products });
    setTab("products");
    setUnseen(products.length);
  }, []);

  const open = useCallback((next: Tab) => {
    setTab(next);
    if (next === "products") setUnseen(0);
  }, []);

  return (
    <>
      {/* Both panes stay mounted: leaving the coach tab must not drop a live call. */}
      <div style={{ display: tab === "coach" ? "contents" : "none" }}>
        <CallScreen onProducts={onProducts} />
      </div>
      <div style={{ display: tab === "products" ? "contents" : "none" }}>
        <Products recommended={recommended} />
      </div>

      <nav className={styles.tabs}>
        <button
          className={tab === "coach" ? styles.active : styles.tab}
          onClick={() => open("coach")}
          aria-label="Coach"
        >
          Coach
        </button>
        <button
          className={tab === "products" ? styles.active : styles.tab}
          onClick={() => open("products")}
          aria-label="Products"
        >
          Healf
          {unseen > 0 && tab !== "products" && <span className={styles.badge}>{unseen}</span>}
        </button>
      </nav>
    </>
  );
}
