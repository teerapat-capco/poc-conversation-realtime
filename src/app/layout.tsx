import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Realtime customer profile PoC",
  description: "A single-page customer profile shell for a realtime conversation demo.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
