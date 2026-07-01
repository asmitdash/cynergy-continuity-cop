"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Play, Search } from "lucide-react";
import { VerbPill, type CogneeVerb } from "@/components/VerbPill";
import { FlagCard, type Flag } from "@/components/FlagCard";

export default function WritePage() {
  const [scene, setScene] = useState("");
  const [verb, setVerb] = useState<CogneeVerb>(null);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [searchTypesUsed, setSearchTypesUsed] = useState<string[]>([]);
  const [meta, setMeta] = useState<string | null>(null);

  async function check() {
    if (!scene.trim()) return;
    setVerb("recall");
    setFlags([]);
    setMeta(null);
    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene_text: scene }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "check failed");
      setFlags(body.flags ?? []);
      setSearchTypesUsed(body.search_types_used ?? []);
      setMeta(
        `context_length=${body.retrieved_context_length} · in=${body.tokens?.input} out=${body.tokens?.output}`,
      );
    } catch (e) {
      setMeta(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setVerb(null);
    }
  }

  async function markFalsePositive(flag: Flag) {
    setVerb("improve");
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flag_id: flag.new_scene_span,
          resolution: "false_positive",
          notes: flag.explanation,
        }),
      });
      setFlags((fs) => fs.filter((f) => f !== flag));
    } finally {
      setVerb(null);
    }
  }

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "60px 24px" }}>
      <VerbPill verb={verb} />
      <Link href="/" className="btn btn-ghost" style={{ marginBottom: 24, padding: "6px 12px", fontSize: 13 }}>
        <ArrowLeft size={14} /> Home
      </Link>
      <h1 style={{ fontSize: 32, marginBottom: 8, display: "flex", alignItems: "center", gap: 12 }}>
        <Search size={28} color="var(--accent)" /> Check a new scene
      </h1>
      <p style={{ color: "var(--text-secondary)", marginBottom: 32 }}>
        We&apos;ll query your memory graph across four Cognee SearchTypes in parallel and flag any contradictions.
      </p>

      <div className="card" style={{ display: "grid", gap: 16 }}>
        <textarea
          className="textarea"
          rows={10}
          value={scene}
          onChange={(e) => setScene(e.target.value)}
          placeholder="Paste your draft scene here…"
        />
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={check} disabled={!scene.trim() || verb !== null}>
            <Play size={16} /> {verb === "recall" ? "Recalling…" : "Check for contradictions"}
          </button>
          {searchTypesUsed.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {searchTypesUsed.map((st) => (
                <span key={st} className="badge badge-cognee mono">{st}</span>
              ))}
            </div>
          )}
        </div>
        {meta && (
          <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>{meta}</div>
        )}
      </div>

      <div style={{ marginTop: 24, display: "grid", gap: 12 }}>
        {flags.length === 0 && meta && !meta.startsWith("Error") && (
          <div className="card">
            <span className="badge badge-success">No contradictions found</span>
            <p style={{ marginTop: 12, color: "var(--text-secondary)", fontSize: 14 }}>
              Your scene is consistent with established canon.
            </p>
          </div>
        )}
        {flags.map((f, i) => (
          <FlagCard key={i} flag={f} onFalsePositive={() => markFalsePositive(f)} />
        ))}
      </div>
    </main>
  );
}
