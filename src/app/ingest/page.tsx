"use client";

import { useState } from "react";
import Link from "next/link";
import { Brain, ArrowLeft, Upload } from "lucide-react";
import { VerbPill, type CogneeVerb } from "@/components/VerbPill";

export default function IngestPage() {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [verb, setVerb] = useState<CogneeVerb>(null);
  const [result, setResult] = useState<string | null>(null);

  async function ingest() {
    if (!title.trim() || !content.trim()) return;
    setVerb("remember");
    setResult(null);
    try {
      const res = await fetch("/api/chapters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content, order: Date.now() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "ingest failed");
      setResult(`Chapter ingested. status=${body.status} · items_processed=${body.items_processed} · ${body.elapsed_seconds?.toFixed(1)}s`);
      setTitle("");
      setContent("");
    } catch (e) {
      setResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setVerb(null);
    }
  }

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: "60px 24px" }}>
      <VerbPill verb={verb} />
      <Link href="/" className="btn btn-ghost" style={{ marginBottom: 24, padding: "6px 12px", fontSize: 13 }}>
        <ArrowLeft size={14} /> Home
      </Link>
      <h1 style={{ fontSize: 32, marginBottom: 8, display: "flex", alignItems: "center", gap: 12 }}>
        <Brain size={28} color="var(--accent)" /> Ingest a chapter
      </h1>
      <p style={{ color: "var(--text-secondary)", marginBottom: 32 }}>
        Cognee will extract characters, locations, events, and facts into your story&apos;s memory graph.
      </p>

      <div className="card" style={{ display: "grid", gap: 16 }}>
        <div>
          <label style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 6, display: "block" }}>Chapter title</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. A Study in Scarlet — Chapter 1"
          />
        </div>
        <div>
          <label style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 6, display: "block" }}>Chapter text</label>
          <textarea
            className="textarea"
            rows={16}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste your chapter text here…"
          />
        </div>
        <button
          className="btn btn-primary"
          onClick={ingest}
          disabled={!title.trim() || !content.trim() || verb !== null}
        >
          <Upload size={16} /> {verb === "remember" ? "Remembering…" : "Ingest with cognee.remember()"}
        </button>
        {result && (
          <div className="mono" style={{ fontSize: 13, color: "var(--text-secondary)", background: "var(--surface-elevated)", padding: 12, borderRadius: 8 }}>
            {result}
          </div>
        )}
      </div>
    </main>
  );
}
