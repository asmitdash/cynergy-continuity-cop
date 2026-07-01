import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Continuity Cop — Your Story Remembers",
  description: "Real-time continuity checking for writers, powered by Cognee's graph memory. Built for the WeMakeDevs × Cognee hackathon.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
