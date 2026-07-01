"use client";

import { AlertTriangle } from "lucide-react";
import { useState } from "react";

export interface Flag {
  new_scene_span: string;
  contradicts_fact: string;
  contradiction_kind: string;
  explanation: string;
  confidence: number;
  evidence?: {
    chapter_ref?: string;
    line_ref?: number;
    excerpt?: string;
  };
}

export function FlagCard({ flag, onFalsePositive }: { flag: Flag; onFalsePositive?: () => void }) {
  const [expanded, setExpanded] = useState(true);
  const conf = Math.round((flag.confidence ?? 0) * 100);

  return (
    <div className="card-elevated" style={{ borderColor: "color-mix(in oklab, var(--contradiction) 40%, var(--border))" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <AlertTriangle size={20} color="var(--contradiction)" style={{ flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <span className="badge badge-flag">{flag.contradiction_kind}</span>
            <span className="badge">{conf}% confidence</span>
          </div>
          <div style={{ fontSize: 15, marginBottom: 8, color: "var(--text-primary)" }}>
            <span className="mono" style={{ background: "var(--surface)", padding: "2px 6px", borderRadius: 4 }}>
              &quot;{flag.new_scene_span}&quot;
            </span>
          </div>
          <div style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 6 }}>
            {flag.explanation}
          </div>
          {expanded && flag.evidence?.excerpt && (
            <div className="evidence">
              <div className="evidence-label">
                Evidence: {flag.evidence.chapter_ref ?? "Chapter"}
                {flag.evidence.line_ref ? `, line ${flag.evidence.line_ref}` : ""}
              </div>
              <div style={{ fontStyle: "italic" }}>&quot;{flag.evidence.excerpt}&quot;</div>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              className="btn btn-ghost"
              style={{ padding: "6px 12px", fontSize: 13 }}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Hide evidence" : "Show evidence"}
            </button>
            {onFalsePositive && (
              <button
                className="btn btn-ghost"
                style={{ padding: "6px 12px", fontSize: 13 }}
                onClick={onFalsePositive}
              >
                Mark as false positive
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
