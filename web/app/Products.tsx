"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import { fetchProducts, identity, type Product } from "@/lib/runner";
import styles from "./products.module.css";

type Props = {
  /** What the coach pushed mid-call, which beats the default range. */
  recommended: { need: string; products: Product[] } | null;
};

export default function Products({ recommended }: Props) {
  const [range, setRange] = useState<Product[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    identity()
      .then((me) => fetchProducts(me))
      .then(setRange)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const products = recommended?.products.length ? recommended.products : range;

  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h1 className={styles.title}>Healf</h1>
        <p className={styles.subtitle}>
          {recommended?.need
            ? `Picked for ${recommended.need}`
            : "What the coach reaches for. It will put its picks here when it calls."}
        </p>
      </header>

      {error && <p className={styles.error}>{error}</p>}

      <ul className={styles.grid}>
        {products.map((product) => (
          <li key={product.handle} className={styles.card}>
            <a href={product.url} target="_blank" rel="noreferrer" className={styles.link}>
              {product.image && (
                <Image
                  className={styles.shot}
                  src={product.image}
                  alt={product.title}
                  width={320}
                  height={320}
                  unoptimized
                />
              )}
              <span className={styles.brand}>{product.brand}</span>
              <span className={styles.name}>{product.title}</span>
              {product.price && (
                <span className={styles.price}>
                  {product.currency === "GBP" ? "£" : ""}
                  {product.price}
                </span>
              )}
            </a>
          </li>
        ))}
      </ul>

      {!products.length && !error && <p className={styles.subtitle}>Loading the range…</p>}
    </div>
  );
}
