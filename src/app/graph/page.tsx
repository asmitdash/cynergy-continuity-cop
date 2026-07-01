"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { ArrowLeft, Brain } from "lucide-react";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

interface GraphNode { id: string; label?: string; type?: string; }
interface GraphEdge { source: string; target: string; relation?: string; }

export default function GraphPage() {
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; links: GraphEdge[] }>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/graph")
      .then((r) => r.json())
      .then((data) => {
        const nodes = (data.nodes ?? []).map((n: GraphNode) => ({ ...n, id: String(n.id) }));
        const links = (data.edges ?? []).map((e: GraphEdge) => ({
          source: String(e.source),
          target: String(e.target),
          relation: e.relation,
        }));
        setGraph({ nodes, links });
      })
      .finally(() => setLoading(false));
  }, []);

  const colorFor = (type?: string) => {
    switch (type) {
      case "Character": return "#9b59b6";
      case "Location": return "#4a9eff";
      case "Event": return "#f59e0b";
      case "EstablishedFact": return "#ededef";
      default: return "#a1a1a8";
    }
  };

  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <header style={{ padding: 16, borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 16 }}>
        <Link href="/" className="btn btn-ghost" style={{ padding: "6px 12px", fontSize: 13 }}>
          <ArrowLeft size={14} /> Home
        </Link>
        <h1 style={{ fontSize: 20, display: "flex", alignItems: "center", gap: 10 }}>
          <Brain size={20} color="var(--accent)" /> Memory Graph
        </h1>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <span className="mono badge">{graph.nodes.length} nodes</span>
          <span className="mono badge">{graph.links.length} edges</span>
        </div>
      </header>
      <div style={{ flex: 1, position: "relative", background: "var(--bg)" }}>
        {loading ? (
          <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}>
            Loading graph from Cognee…
          </div>
        ) : graph.nodes.length === 0 ? (
          <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, color: "var(--text-muted)" }}>
            <Brain size={48} />
            <div>Ingest a chapter to see your story&apos;s memory form.</div>
            <Link href="/ingest" className="btn btn-primary">Ingest a chapter</Link>
          </div>
        ) : (
          <ForceGraph2D
            graphData={graph}
            backgroundColor="#0a0a0b"
            nodeColor={(n) => colorFor((n as GraphNode).type)}
            nodeLabel={(n) => `${(n as GraphNode).label ?? (n as GraphNode).id} (${(n as GraphNode).type ?? "?"})`}
            linkColor={() => "#2a2a2e"}
            linkDirectionalArrowLength={4}
            linkDirectionalArrowRelPos={1}
          />
        )}
      </div>
    </main>
  );
}
