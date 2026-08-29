import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import ServiceWorker from "./ServiceWorker";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ultra Coach",
  description: "The ultra coach that calls you.",
  appleWebApp: { capable: true, title: "Ultra Coach", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#05080b",
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={geistSans.variable}>
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
