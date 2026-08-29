import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Ultra Coach",
    short_name: "Ultra Coach",
    description: "The ultra coach that calls you.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#05080b",
    theme_color: "#05080b",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
