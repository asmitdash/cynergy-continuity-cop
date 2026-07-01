"use client";

import { useState } from "react";
import Link from "next/link";
import { Upload, Search, AlertTriangle, Trash2, Brain, ArrowRight } from "lucide-react";

export default function Landing() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function loadDemoCorpus() {
    setLoading(true);
    setMessage("Ingesting Sherlock Holmes canon into Cognee…");
    try {
      const chapters = await fetch("/demo/sherlock.json").then((r) => r.json());
      for (const [i, ch] of chapters.entries()) {
        setMessage(`Ingesting chapter ${i + 1}/${chapters.length}: ${ch.title}…`);
        const res = await fetch("/api/chapters", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...ch, order: i + 1, projectId: "demo-sherlock" }),
        });
        if (!res.ok) throw new Error(await res.text());
      }
      setMessage("Demo corpus loaded. Go check a scene.");
    } catch (e) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "80px 24px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: "color-mix(in oklab, var(--accent) 25%, var(--surface))",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Brain size={22} color="var(--accent)" />
        </div>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Continuity Cop</div>
          <div className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>
            Cynergy · WeMakeDevs × Cognee Hackathon
          </div>
        </div>
      </div>

      <h1 style={{ fontSize: 44, fontWeight: 700, lineHeight: 1.1, marginBottom: 16 }}>
        Your story remembers.<br />Your plot stays honest.
      </h1>
      <p style={{ fontSize: 18, color: "var(--text-secondary)", marginBottom: 40, maxWidth: 640 }}>
        Ingest your chapters. Write a new scene. Continuity Cop flags contradictions in
        real time with cited evidence from your earlier work — powered by Cognee&apos;s
        graph memory.
      </p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 48 }}>
        <Link href="/ingest" className="btn btn-primary">
          <Upload size={16} /> Ingest a chapter
        </Link>
        <Link href="/write" className="btn btn-ghost">
          <Search size={16} /> Check a scene
        </Link>
        <Link href="/graph" className="btn btn-ghost">
          <Brain size={16} /> View memory graph
        </Link>
        <button className="btn btn-ghost" onClick={loadDemoCorpus} disabled={loading}>
          Load Sherlock demo corpus <ArrowRight size={16} />
        </button>
      </div>

      {message && (
        <div className="card" style={{ marginBottom: 32 }}>
          <div className="mono" style={{ fontSize: 13, color: "var(--text-secondary)" }}>{message}</div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        {[
          { icon: Brain, verb: "remember", desc: "Ingest chapters into Cognee's knowledge graph. Cognee extracts characters, locations, events, and facts as typed entities." },
          { icon: Search, verb: "recall", desc: "Every new scene runs against 4 SearchTypes — GRAPH_COMPLETION, TEMPORAL, TRIPLET_COMPLETION, and GRAPH_COMPLETION_COT — with include_references citations." },
          { icon: AlertTriangle, verb: "improve", desc: "Mark a flag as intentional. Cognee's truth-subspace reranker learns your story's actual rules over time." },
          { icon: Trash2, verb: "forget", desc: "Retcon a chapter. Cognee forgets the old facts. Every downstream scene re-checks against the new canon." },
        ].map(({ icon: Icon, verb, desc }) => (
          <div key={verb} className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <Icon size={18} color="var(--accent)" />
              <span className="mono" style={{ color: "var(--accent)", fontWeight: 500, fontSize: 14 }}>
                cognee.{verb}()
              </span>
            </div>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55 }}>{desc}</p>
          </div>
        ))}
      </div>

      <footer style={{ marginTop: 80, paddingTop: 24, borderTop: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 12 }}>
        <div className="mono">
          Bedrock: <span style={{ color: "var(--text-secondary)" }}>global.anthropic.claude-opus-4-7[1m] · ap-south-1</span>
          {"  ·  "}
          Cognee Cloud: <span style={{ color: "var(--text-secondary)" }}>tenant-cf529850…</span>
        </div>
      </footer>
    </main>
  );
}
