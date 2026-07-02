import { NextRequest } from "next/server";
import { del } from "@vercel/blob";
import { remember, recall, type SearchType } from "@/lib/cognee";
import { callOpus } from "@/lib/bedrock";
import { extractChapters, batchChapters } from "@/lib/pdf-split";

export const runtime = "nodejs";
export const maxDuration = 300;

interface Flag {
  new_scene_span: string;
  contradicts_fact: string;
  contradiction_kind: string;
  explanation: string;
  confidence: number;
}

function sseFrame(event: string, data: unknown): Uint8Array {
  const enc = new TextEncoder();
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Parallel ingestion concurrency. Higher = faster but more Cognee load.
const INGEST_CONCURRENCY = 5;

// Words per batch when concatenating small chapters into one remember() call.
// Cuts credit cost roughly N-fold where N = chapters-per-batch.
const BATCH_TARGET_WORDS = 20000;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { blob_url, filename } = body as { blob_url?: string; filename?: string };
  if (!blob_url || !filename) {
    return new Response(
      JSON.stringify({ error: "blob_url and filename required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const datasetId = process.env.DEMO_DATASET_ID!;
  const uploadId = `up_${Date.now()}`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(sseFrame(event, data));
      };

      try {
        // 1. Download bytes
        send("status", { phase: "download", message: `Fetching ${filename}…` });
        const fetched = await fetch(blob_url);
        if (!fetched.ok) throw new Error(`blob fetch failed: ${fetched.status}`);
        const buffer = Buffer.from(await fetched.arrayBuffer());
        send("status", {
          phase: "download",
          message: `Downloaded ${(buffer.length / 1024).toFixed(0)} KB`,
        });

        // 2. Split into chapters (no hard cap)
        send("status", { phase: "split", message: "Extracting chapters…" });
        const isPdf = filename.toLowerCase().endsWith(".pdf");
        let chapters: Array<{ title: string; content: string; wordCount: number }> = [];
        let totalPages = 0;
        let totalWords = 0;
        let strategy = "single";

        if (isPdf) {
          const result = await extractChapters(buffer, filename);
          chapters = result.chapters;
          totalPages = result.totalPages;
          totalWords = result.totalWords;
          strategy = result.strategy;
        } else {
          const text = buffer.toString("utf8");
          chapters = [
            {
              title: filename.replace(/\.[^.]+$/, ""),
              content: text,
              wordCount: text.split(/\s+/).filter(Boolean).length,
            },
          ];
          totalWords = chapters[0].wordCount;
          strategy = "single";
        }

        // 3. Batch chapters so we make fewer, larger Cognee calls
        const batches = batchChapters(chapters, BATCH_TARGET_WORDS);

        send("split", {
          totalChapters: chapters.length,
          totalPages,
          totalWords,
          strategy,
          totalBatches: batches.length,
          batchConcurrency: INGEST_CONCURRENCY,
          titles: chapters.map((c) => c.title),
          analysisMode: "cognee-sweep",
        });

        // 4. Ingest batches in parallel with a concurrency cap.
        //    Each batch → one Cognee.remember() call with node_set tags.
        const batchStates = batches.map((b, i) => ({
          index: i,
          title: b.title,
          wordCount: b.wordCount,
          phase: "pending" as "pending" | "ingesting" | "ingested" | "error",
        }));

        let inflight = 0;
        let next = 0;
        let finished = 0;
        await new Promise<void>((resolve) => {
          const tick = () => {
            while (inflight < INGEST_CONCURRENCY && next < batches.length) {
              const i = next++;
              inflight++;
              const b = batches[i];
              batchStates[i].phase = "ingesting";
              send("progress", {
                index: i,
                total: batches.length,
                phase: "ingest",
                title: b.title,
                wordCount: b.wordCount,
              });

              const batchId = `${uploadId}_b${i}`;
              remember({
                data: {
                  text: `# ${b.title}\n\nBatch ID: ${batchId}\n\n${b.content}`,
                  filename: `${batchId}.md`,
                },
                datasetId,
                nodeSet: [
                  `upload_id:${uploadId}`,
                  `batch_id:${batchId}`,
                  `batch_index:${i}`,
                  `source_file:${filename}`,
                  "kind:chapter",
                  "kind:file_upload",
                ],
                runInBackground: true,
              })
                .then((res) => {
                  batchStates[i].phase = "ingested";
                  send("progress", {
                    index: i,
                    total: batches.length,
                    phase: "ingested",
                    title: b.title,
                    cognee_status: res.status,
                  });
                })
                .catch((err) => {
                  batchStates[i].phase = "error";
                  send("error", {
                    index: i,
                    title: b.title,
                    message: err instanceof Error ? err.message : String(err),
                  });
                })
                .finally(() => {
                  inflight--;
                  finished++;
                  if (finished >= batches.length) resolve();
                  else tick();
                });
            }
          };
          tick();
        });

        // 5. Two Cognee-native contradiction sweeps
        send("status", {
          phase: "sweep",
          message: `Ingestion complete. Running contradiction analysis on your knowledge graph…`,
        });

        const flags = await cogneeContradictionSweep(datasetId, uploadId, send);

        send("contradictions", {
          afterTitle: "full-document sweep",
          chapters_ingested: chapters.map((c) => c.title),
          flags,
          final: true,
        });

        send("done", {
          totalChapters: chapters.length,
          totalBatches: batches.length,
          strategy,
          analysisMode: "cognee-sweep",
          contradictionsFound: flags.length,
        });
      } catch (e) {
        send("error", {
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        try {
          await del(blob_url);
        } catch {
          /* ignore */
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Two-sweep contradiction detection using Cognee's own graph reasoning.
 * No LLM sampling of raw text. Cognee's knowledge graph is the source of truth.
 *
 * Sweep 1: GRAPH_COMPLETION_COT — chain-of-thought reasoning over the graph.
 *   Asks Cognee: "list every pair of facts that contradict, with citations."
 *
 * Sweep 2: TRIPLET_COMPLETION — structural (subject, predicate, object) view.
 *   Finds structural contradictions (same subject+predicate, incompatible objects).
 *
 * Results are unioned + dedup'd by the quoted span.
 */
async function cogneeContradictionSweep(
  datasetId: string,
  uploadId: string,
  send: (event: string, data: unknown) => void,
): Promise<Flag[]> {
  const contradictionQuery = `Identify every pair of facts in this knowledge graph that CONTRADICT each other. For each contradiction, describe both facts and cite where each appears in the source. Be exhaustive — include every direct contradiction (character attributes stated differently in different places, timeline conflicts, location conflicts, possession conflicts, relationship conflicts). Return concrete quoted evidence, not summaries. If two statements say the same person did two incompatible things at the same time or place, that's a contradiction. If a character is described as left-handed in one place and right-handed in another, that's a contradiction. If a date is stated as X in one section and Y in another, that's a contradiction. Only flag FACTUAL contradictions, not stylistic differences.`;

  const sweeps: Array<{ label: string; searchType: SearchType }> = [
    { label: "graph-cot", searchType: "GRAPH_COMPLETION_COT" },
    { label: "triplet", searchType: "TRIPLET_COMPLETION" },
  ];

  const sweepResults: Array<{ label: string; text: string }> = [];
  for (const s of sweeps) {
    send("status", { phase: "sweep", message: `Cognee ${s.searchType}…` });
    try {
      const items = await recall({
        query: contradictionQuery,
        datasetIds: [datasetId],
        searchType: s.searchType,
        nodeName: [`upload_id:${uploadId}`],
        topK: 20,
        includeReferences: true,
      });
      const joined = items.map((it) => it.text).join("\n\n");
      sweepResults.push({ label: s.label, text: joined });
    } catch (e) {
      send("error", {
        phase: "sweep",
        sweep: s.label,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Merge Cognee's outputs, then have Opus normalize them into the Flag JSON
  // shape the UI expects. Cognee returns prose; Opus turns prose into structured
  // findings. This is ONE Opus call, not per-chapter.
  const merged = sweepResults
    .filter((r) => r.text.trim().length > 0)
    .map((r) => `[${r.label}]\n${r.text}`)
    .join("\n\n===\n\n");

  if (!merged) return [];

  const opus = await callOpus({
    system: `You are a normalizer. You receive Cognee's contradiction analysis of a document (prose text) and convert it into a strict JSON array of Flag objects for a UI to render.

Each Flag has:
- new_scene_span: string (a short quoted piece of text that IS the contradiction — try to use verbatim quotes from Cognee's analysis)
- contradicts_fact: string (the other side of the contradiction — the fact this contradicts)
- contradiction_kind: one of "identity" | "location" | "time" | "possession" | "relationship" | "physical_attribute" | "causal"
- explanation: one plain-English sentence
- confidence: number in [0, 1]

Rules:
- Return ONLY the JSON array. No prose, no code fences.
- Dedup: if two contradictions are the same, keep only one.
- If Cognee returned no contradictions (e.g. "no contradictions found"), return [].
- Do not invent contradictions Cognee didn't mention.`,
    messages: [
      {
        role: "user",
        content: `Cognee analysis:\n\n${merged}\n\nReturn the JSON array.`,
      },
    ],
    maxTokens: 3000,
  });

  const match = opus.text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]) as Flag[];
  } catch {
    return [];
  }
}
