"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { upload } from "@vercel/blob/client";
import {
  Brain,
  ArrowLeft,
  Upload,
  FileText,
  CheckCircle,
  AlertTriangle,
  Loader,
} from "lucide-react";
import { VerbPill, type CogneeVerb } from "@/components/VerbPill";

type Mode = "paste" | "file";

const ACCEPTED = ".pdf,.doc,.docx,.txt,.md,.markdown,.rtf,.odt";
const ACCEPTED_LABEL = "PDF, DOC, DOCX, TXT, MD, RTF, ODT";

async function readErrorMessage(res: Response): Promise<string> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      return body.error ?? body.message ?? `${res.status} ${res.statusText}`;
    } catch {
      /* fall through */
    }
  }
  const text = await res.text();
  return text.slice(0, 300) || `${res.status} ${res.statusText}`;
}

interface Flag {
  new_scene_span: string;
  contradicts_fact: string;
  contradiction_kind: string;
  explanation: string;
  confidence: number;
}

interface ChapterState {
  index: number;
  title: string;
  wordCount?: number;
  phase: "pending" | "ingesting" | "ingested" | "analyzing" | "error";
  errorMsg?: string;
}

export default function IngestPage() {
  const [mode, setMode] = useState<Mode>("paste");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [verb, setVerb] = useState<CogneeVerb>(null);
  const [result, setResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Streaming state for file ingest
  const [streaming, setStreaming] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [totalChapters, setTotalChapters] = useState<number>(0);
  const [chapterStates, setChapterStates] = useState<ChapterState[]>([]);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [flagsAfterTitle, setFlagsAfterTitle] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<string | null>(null);
  const [analysisMode, setAnalysisMode] = useState<string | null>(null);
  const [analyzerPasses, setAnalyzerPasses] = useState<number>(0);
  const [done, setDone] = useState(false);

  // Auto-scroll progress into view when it starts
  const progressRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (streaming && progressRef.current) {
      progressRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [streaming]);

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
      if (!res.ok) throw new Error(await readErrorMessage(res));
      const body = await res.json();
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

  function resetStreamState() {
    setStreaming(false);
    setStatusLine(null);
    setTotalChapters(0);
    setChapterStates([]);
    setFlags([]);
    setFlagsAfterTitle(null);
    setStrategy(null);
    setAnalysisMode(null);
    setAnalyzerPasses(0);
    setDone(false);
  }

  async function ingestFile() {
    if (!file) return;
    setVerb("remember");
    resetStreamState();
    setStreaming(true);

    try {
      // Step 1: client-direct upload to Vercel Blob
      setStatusLine(`Uploading ${file.name} (${(file.size / 1024).toFixed(0)} KB)…`);
      const blob = await upload(file.name, file, {
        access: "public",
        handleUploadUrl: "/api/blob",
      });

      setStatusLine("Uploaded. Streaming chapter ingestion…");

      // Step 2: open SSE stream
      const res = await fetch("/api/chapters/stream-ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blob_url: blob.url,
          filename: file.name,
        }),
      });
      if (!res.ok || !res.body) {
        throw new Error(await readErrorMessage(res));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      // Parse SSE frames
      while (true) {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });

        // Split on double-newline (SSE frame separator)
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          if (!frame.trim()) continue;
          let event = "message";
          let dataStr = "";
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
          }
          if (!dataStr) continue;
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(dataStr) as Record<string, unknown>;
          } catch {
            continue;
          }
          handleEvent(event, data);
        }
      }
    } catch (e) {
      setStatusLine(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setVerb(null);
      // Don't wipe stream state — user wants to see the results.
    }
  }

  function handleEvent(event: string, data: Record<string, unknown>) {
    switch (event) {
      case "status": {
        const message = data.message as string | undefined;
        if (message) setStatusLine(message);
        return;
      }
      case "split": {
        const total = Number(data.totalChapters) || 0;
        const titles = (data.titles as string[]) ?? [];
        const strat = data.strategy as string | undefined;
        const mode = data.analysisMode as string | undefined;
        setTotalChapters(total);
        setStrategy(strat ?? null);
        setAnalysisMode(mode ?? null);
        setChapterStates(
          titles.map((t, i) => ({ index: i, title: t, phase: "pending" })),
        );
        const modeNote =
          mode === "final-pass"
            ? "Large doc — one final contradiction sweep at the end (saves credits)."
            : "Rolling contradiction analysis after each chapter.";
        setStatusLine(
          `${total} chapter${total === 1 ? "" : "s"} detected (${strat}). ${modeNote}`,
        );
        return;
      }
      case "progress": {
        const index = Number(data.index) || 0;
        const phase = data.phase as string | undefined;
        setChapterStates((prev) => {
          const next = [...prev];
          if (!next[index]) return prev;
          if (phase === "ingest") {
            // Belt-and-suspenders: when a NEW chapter starts ingesting,
            // any earlier row still visually stuck on "analyzing" gets
            // promoted to "ingested". Fixes the stuck-analyzing UI bug.
            for (let j = 0; j < index; j++) {
              if (next[j]?.phase === "analyzing") {
                next[j] = { ...next[j], phase: "ingested" };
              }
            }
            next[index] = { ...next[index], phase: "ingesting" };
          } else if (phase === "ingested") {
            next[index] = { ...next[index], phase: "ingested" };
          } else if (phase === "analyze") {
            next[index] = { ...next[index], phase: "analyzing" };
          }
          return next;
        });
        return;
      }
      case "contradictions": {
        const incomingFlags = (data.flags as Flag[]) ?? [];
        const afterTitle = data.afterTitle as string | undefined;
        // E: accumulate + dedup instead of overwrite. Dedup key = quoted span.
        setFlags((prev) => {
          const seen = new Set(prev.map((f) => f.new_scene_span));
          const merged = [...prev];
          for (const f of incomingFlags) {
            if (!seen.has(f.new_scene_span)) {
              seen.add(f.new_scene_span);
              merged.push(f);
            }
          }
          return merged;
        });
        setFlagsAfterTitle(afterTitle ?? null);
        setAnalyzerPasses((n) => n + 1);
        return;
      }
      case "error": {
        const index = data.index as number | undefined;
        const message = String(data.message ?? "unknown error");
        if (typeof index === "number") {
          setChapterStates((prev) => {
            const next = [...prev];
            if (next[index]) next[index] = { ...next[index], phase: "error", errorMsg: message };
            return next;
          });
        } else {
          setStatusLine(`Error: ${message}`);
        }
        return;
      }
      case "done": {
        setDone(true);
        setStatusLine("Ingestion complete.");
        return;
      }
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) setFile(dropped);
  }

  const ingestedCount = chapterStates.filter(
    (c) => c.phase === "ingested" || c.phase === "analyzing",
  ).length;
  const progressPct =
    totalChapters === 0 ? 0 : Math.round((ingestedCount / totalChapters) * 100);

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "60px 24px" }}>
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
        Large documents are split into chapters and streamed one at a time.
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
          {result && (
            <div
              className="mono"
              style={{
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
        </div>
      ) : (
        <div className="card" style={{ display: "grid", gap: 16 }}>
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
          <button className="btn btn-primary" onClick={ingestFile} disabled={!file || streaming}>
            <Upload size={16} /> {streaming ? "Streaming…" : "Upload & Stream Ingest"}
          </button>
        </div>
      )}

      {(streaming || chapterStates.length > 0) && (
        <div ref={progressRef} style={{ marginTop: 24 }}>
          <ProgressPanel
            statusLine={statusLine}
            totalChapters={totalChapters}
            chapterStates={chapterStates}
            progressPct={progressPct}
            strategy={strategy}
            done={done}
          />
          <ContradictionsPanel
            flags={flags}
            afterTitle={flagsAfterTitle}
            analyzerPasses={analyzerPasses}
            analysisMode={analysisMode}
            done={done}
          />
        </div>
      )}
    </main>
  );
}

function ProgressPanel({
  statusLine,
  totalChapters,
  chapterStates,
  progressPct,
  strategy,
  done,
}: {
  statusLine: string | null;
  totalChapters: number;
  chapterStates: ChapterState[];
  progressPct: number;
  strategy: string | null;
  done: boolean;
}) {
  return (
    <div className="card" style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {done ? "Ingestion complete" : "Streaming ingestion"}
          </div>
          {statusLine && (
            <div className="mono" style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
              {statusLine}
            </div>
          )}
        </div>
        {totalChapters > 0 && (
          <div style={{ textAlign: "right" }}>
            <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--success, #51cf66)" }}>
              {progressPct}%
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {chapterStates.filter((c) => c.phase === "ingested" || c.phase === "analyzing").length}/{totalChapters}
            </div>
          </div>
        )}
      </div>

      <div
        style={{
          width: "100%",
          height: 8,
          background: "var(--surface-elevated)",
          borderRadius: 999,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${progressPct}%`,
            height: "100%",
            background:
              "linear-gradient(90deg, var(--success, #51cf66), var(--accent, #8b7fff))",
            transition: "width 400ms ease",
          }}
        />
      </div>

      {strategy && (
        <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Split strategy: {strategy}
        </div>
      )}

      {chapterStates.length > 0 && (
        <div style={{ display: "grid", gap: 4, maxHeight: 240, overflowY: "auto", paddingRight: 4 }}>
          {chapterStates.map((c) => (
            <ChapterRow key={c.index} state={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChapterRow({ state }: { state: ChapterState }) {
  const iconFor = () => {
    switch (state.phase) {
      case "ingested":
        return <CheckCircle size={14} color="var(--success, #51cf66)" />;
      case "analyzing":
        return <Loader size={14} className="spin" color="var(--accent, #8b7fff)" />;
      case "ingesting":
        return <Loader size={14} className="spin" color="var(--accent, #8b7fff)" />;
      case "error":
        return <AlertTriangle size={14} color="var(--contradiction, #ff6b6b)" />;
      default:
        return (
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: 999,
              border: "1.5px solid var(--text-muted)",
              opacity: 0.4,
            }}
          />
        );
    }
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "20px 1fr auto",
        alignItems: "center",
        gap: 10,
        padding: "6px 0",
        fontSize: 13,
      }}
    >
      {iconFor()}
      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {state.title}
      </div>
      <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
        {state.phase === "error" ? state.errorMsg ?? "error" : state.phase}
      </div>
      <style>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function ContradictionsPanel({
  flags,
  afterTitle,
  analyzerPasses,
  analysisMode,
  done,
}: {
  flags: Flag[];
  afterTitle: string | null;
  analyzerPasses: number;
  analysisMode: string | null;
  done: boolean;
}) {
  const hasFlags = flags.length > 0;
  const hasRun = analyzerPasses > 0 || done;
  const borderColor = hasFlags
    ? "var(--contradiction, #ff6b6b)"
    : "var(--border)";
  return (
    <div className="card" style={{ marginTop: 16, borderColor }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <AlertTriangle
          size={18}
          color={hasFlags ? "var(--contradiction, #ff6b6b)" : "var(--text-muted)"}
        />
        <div>
          <div style={{ fontWeight: 600 }}>
            {hasFlags
              ? `${flags.length} contradiction${flags.length === 1 ? "" : "s"} found`
              : hasRun
                ? "No contradictions detected"
                : "Analyzer will run when the doc finishes ingesting…"}
          </div>
          {afterTitle && (
            <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
              after: {afterTitle}
              {analysisMode && ` · mode: ${analysisMode}`}
            </div>
          )}
        </div>
      </div>
      {!hasFlags && hasRun && (
        <div
          className="mono"
          style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}
        >
          Opus read the whole document and found no factual conflicts.
          {analysisMode === "full-text-only"
            ? " The analyzer looked at your document end-to-end for pairs of statements that contradict each other."
            : " The analyzer sampled across every ingested section."}
          If you expected a flag here, the contradicting facts may not be
          worded clearly enough for the model — try being more specific
          (e.g. explicit character attributes, exact dates, precise locations).
        </div>
      )}
      <div style={{ display: "grid", gap: 10 }}>
        {flags.map((f, i) => (
          <div
            key={i}
            style={{
              background: "var(--surface-elevated)",
              padding: 12,
              borderRadius: 8,
              borderLeft: "3px solid var(--contradiction, #ff6b6b)",
            }}
          >
            <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
              {f.contradiction_kind} · {Math.round((f.confidence ?? 0) * 100)}% confidence
            </div>
            <div style={{ fontSize: 14, fontStyle: "italic", marginBottom: 6 }}>
              &ldquo;{f.new_scene_span}&rdquo;
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>{f.explanation}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
