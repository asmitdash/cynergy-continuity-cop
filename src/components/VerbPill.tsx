"use client";

import { Brain, Search, AlertTriangle, Trash2 } from "lucide-react";

export type CogneeVerb = "remember" | "recall" | "improve" | "forget" | null;

const config = {
  remember: { icon: Brain, label: "remembering…" },
  recall: { icon: Search, label: "recalling…" },
  improve: { icon: AlertTriangle, label: "improving…" },
  forget: { icon: Trash2, label: "forgetting…" },
};

export function VerbPill({ verb }: { verb: CogneeVerb }) {
  if (!verb) return null;
  const { icon: Icon, label } = config[verb];
  return (
    <div className="verb-pill">
      <Icon size={14} strokeWidth={2.5} />
      <span className="mono">{label}</span>
    </div>
  );
}
