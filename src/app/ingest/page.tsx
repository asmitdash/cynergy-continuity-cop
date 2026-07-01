"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Brain, ArrowLeft, Upload, FileText } from "lucide-react";
import { VerbPill, type CogneeVerb } from "@/components/VerbPill";

type Mode = "paste" | "file";

const ACCEPTED = ".pdf,.doc,.docx,.txt,.md,.markdown,.rtf,.odt";
const ACCEPTED_LABEL = "PDF, DOC, DOCX, TXT, MD, RTF, ODT";

export default function IngestPage() {
  const [mode, setMode] = useState<Mode>("paste");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [verb, setVerb] = useState<CogneeVerb>(null);
  const [result, setResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function ingestText() {
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
      setResult(
        `Chapter ingested. status=${body.status} · items_processed=${body.items_processed} · ${body.elapsed_seconds?.toFixed(1)}s`,
      );
      setTitle("");
      setContent("");
    } catch (e) {
      setResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setVerb(null);
    }
  }

  async function ingestFile() {
    if (!file) return;
    setVerb("remember");
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("order", String(Date.now()));
      if (title.trim()) form.append("title", title);
      const res = await fetch("/api/chapters/upload", {
        method: "POST",
        body: form,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "upload failed");
      setResult(
        `${body.filename} ingested. type=${body.extension} · status=${body.status} · items_processed=${body.items_processed} · ${body.elapsed_seconds?.toFixed(1)}s`,
      );
      setFile(null);
      setTitle("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      setResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setVerb(null);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) setFile(dropped);
  }

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: "60px 24px" }}>
      <VerbPill verb={verb} />
      <Link
        href="/"
        className="btn btn-ghost"
        style={{ marginBottom: 24, padding: "6px 12px", fontSize: 13 }}
      >
        <ArrowLeft size={14} /> Home
      </Link>
      <h1 style={{ fontSize: 32, marginBottom: 8, display: "flex", alignItems: "center", gap: 12 }}>
        <Brain size={28} color="var(--accent)" /> Ingest a chapter
      </h1>
      <p style={{ color: "var(--text-secondary)", marginBottom: 24 }}>
        Cognee will extract characters, locations, events, and facts into your story&apos;s memory graph.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => setMode("paste")}
          className={mode === "paste" ? "btn btn-primary" : "btn btn-ghost"}
          style={{ padding: "8px 14px", fontSize: 13 }}
        >
          Paste text
        </button>
        <button
          onClick={() => setMode("file")}
          className={mode === "file" ? "btn btn-primary" : "btn btn-ghost"}
          style={{ padding: "8px 14px", fontSize: 13 }}
        >
          <FileText size={14} /> Upload file
        </button>
      </div>

      {mode === "paste" ? (
        <div className="card" style={{ display: "grid", gap: 16 }}>
          <div>
            <label style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 6, display: "block" }}>
              Chapter title
            </label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. A Study in Scarlet — Chapter 1"
            />
          </div>
          <div>
            <label style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 6, display: "block" }}>
              Chapter text
            </label>
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
            onClick={ingestText}
            disabled={!title.trim() || !content.trim() || verb !== null}
          >
            <Upload size={16} /> {verb === "remember" ? "Remembering…" : "Ingest with cognee.remember()"}
          </button>
        </div>
      ) : (
        <div className="card" style={{ display: "grid", gap: 16 }}>
          <div>
            <label style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 6, display: "block" }}>
              Chapter title (optional — defaults to filename)
            </label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Chapter 7 — The Waterfront"
            />
          </div>
          <div>
            <label style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 6, display: "block" }}>
              File
            </label>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 12,
                padding: "36px 20px",
                textAlign: "center",
                cursor: "pointer",
                background: dragOver
                  ? "color-mix(in oklab, var(--accent) 8%, transparent)"
                  : "transparent",
                transition: "all 150ms ease",
              }}
            >
              <FileText size={32} color="var(--text-muted)" style={{ marginBottom: 12 }} />
              <div style={{ fontSize: 15, marginBottom: 6 }}>
                {file ? (
                  <>
                    <strong>{file.name}</strong>{" "}
                    <span className="mono" style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      · {(file.size / 1024).toFixed(1)} KB
                    </span>
                  </>
                ) : (
                  <>Click to browse, or drop a file here</>
                )}
              </div>
              <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                Accepted: {ACCEPTED_LABEL} · max 20 MB
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                style={{ display: "none" }}
              />
            </div>
          </div>
          <button className="btn btn-primary" onClick={ingestFile} disabled={!file || verb !== null}>
            <Upload size={16} /> {verb === "remember" ? "Remembering…" : "Upload & Ingest"}
          </button>
        </div>
      )}

      {result && (
        <div
          className="mono"
          style={{
            marginTop: 20,
            fontSize: 13,
            color: "var(--text-secondary)",
            background: "var(--surface-elevated)",
            padding: 12,
            borderRadius: 8,
          }}
        >
          {result}
        </div>
      )}
    </main>
  );
}
