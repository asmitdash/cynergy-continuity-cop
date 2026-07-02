import { NextRequest } from "next/server";
import { del } from "@vercel/blob";
import { remember, recall, type SearchType } from "@/lib/cognee";
import { callOpus } from "@/lib/bedrock";
import { extractChapters } from "@/lib/pdf-split";
import { CONTRADICTION_DETECT_SYSTEM, contradictionUserPrompt } from "@/lib/prompts";

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

/**
 * Above this section count, we skip per-chapter analysis and run ONE final
 * contradiction pass at the end. Massively cheaper on Cognee credits + faster.
 * (D + A fixes.)
 */
const PER_CHAPTER_ANALYZER_MAX = 12;

/**
 * When running per-chapter analysis, cap total analyzer calls to protect credits.
 */
const MAX_ANALYZER_CALLS = 20;

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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(sseFrame(event, data));
      };

      try {
        send("status", { phase: "download", message: `Fetching ${filename}…` });
        const fetched = await fetch(blob_url);
        if (!fetched.ok) throw new Error(`blob fetch failed: ${fetched.status}`);
        const buffer = Buffer.from(await fetched.arrayBuffer());
        send("status", {
          phase: "download",
          message: `Downloaded ${(buffer.length / 1024).toFixed(0)} KB`,
        });

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

        // Build the full-text view up front — we'll use this for the analyzer
        // regardless of chapter count. This is the "just read the whole thing"
        // path: for small docs, one Opus call finds every internal contradiction
        // without needing Cognee at all.
        const fullText = chapters.map((c) => c.content).join("\n\n");

        // Decide analysis mode up-front so the UI can render the right affordance.
        //  - "full-text-only": doc is small enough that we just hand it to Opus
        //     directly. No Cognee round-trips for the analyzer. Zero Cognee credits.
        //     Ingestion still happens so the doc lives in your memory graph.
        //  - "per-chapter": moderate size, we run rolling cross-chapter checks
        //  - "final-pass": large doc, one big analyzer at the end
        const SMALL_DOC_MAX_WORDS = 15000;
        const isSmallDoc = totalWords <= SMALL_DOC_MAX_WORDS;
        const perChapterAnalyze =
          !isSmallDoc && chapters.length <= PER_CHAPTER_ANALYZER_MAX;
        const analysisMode = isSmallDoc
          ? "full-text-only"
          : perChapterAnalyze
            ? "per-chapter"
            : "final-pass";

        send("split", {
          totalChapters: chapters.length,
          totalPages,
          totalWords,
          strategy,
          analysisMode,
          titles: chapters.map((c) => c.title),
        });

        // 3. Ingest phase — always sequential, but never analyze during ingest
        //    when the doc is large. Fires cognee.remember(runInBackground=true)
        //    which returns fast; Cognee cognifies in the background.
        const ingestedTitles: string[] = [];
        let analyzerCalls = 0;
        for (let i = 0; i < chapters.length; i++) {
          const ch = chapters[i];
          const chapterId = `ch_${Date.now()}_${i}`;

          send("progress", {
            index: i,
            total: chapters.length,
            phase: "ingest",
            title: ch.title,
            wordCount: ch.wordCount,
          });

          try {
            const rememberResult = await remember({
              data: {
                text: `# ${ch.title}\n\nChapter ID: ${chapterId}\n\n${ch.content}`,
                filename: `${chapterId}.md`,
              },
              datasetId,
              nodeSet: [
                `chapter_id:${chapterId}`,
                `chapter_order:${i}`,
                `chapter_title:${ch.title}`,
                `source_file:${filename}`,
                "kind:chapter",
                "kind:file_upload",
              ],
              runInBackground: true,
            });
            ingestedTitles.push(ch.title);

            send("progress", {
              index: i,
              total: chapters.length,
              phase: "ingested",
              title: ch.title,
              cognee_status: rememberResult.status,
            });
          } catch (e) {
            send("error", {
              index: i,
              title: ch.title,
              message: e instanceof Error ? e.message : String(e),
            });
            continue;
          }

          // Per-chapter contradiction sweep. For chapters 2..N, we check against
          // everything ingested so far (cross-chapter contradictions). For the
          // very first chapter, we run a SELF-CONSISTENCY pass — checking the
          // chapter's own facts against each other. Single-chapter uploads
          // NEED this or contradictions inside one document are never found.
          if (perChapterAnalyze && analyzerCalls < MAX_ANALYZER_CALLS) {
            send("progress", {
              index: i,
              total: chapters.length,
              phase: "analyze",
              title: ch.title,
            });
            try {
              const flags =
                i === 0
                  ? await analyzeSelfConsistency(ch.content)
                  : await analyzeContradictions(datasetId, ch.content);
              analyzerCalls++;
              send("contradictions", {
                afterChapter: i,
                afterTitle: ch.title,
                chapters_ingested: ingestedTitles,
                flags,
              });
              send("progress", {
                index: i,
                total: chapters.length,
                phase: "ingested",
                title: ch.title,
              });
            } catch (e) {
              send("error", {
                index: i,
                title: ch.title,
                phase: "analyze",
                message: e instanceof Error ? e.message : String(e),
              });
            }
          }
        }

        // FULL-TEXT ANALYZER — the primary path for small docs.
        //
        // For small docs we don't do per-chapter analysis at all. Instead we
        // hand Opus the ENTIRE document text and ask it to find internal
        // contradictions. This is what a human reader would do. No Cognee
        // round-trips, no splitting artifacts, no "well, I'm on chapter 2 so
        // I can't see chapter 1" gaps.
        //
        // For large docs, we ALSO run this at the end — same idea, but on a
        // sampled seed of chapter openers so it fits in the LLM context.
        if (analysisMode === "full-text-only" || analysisMode === "final-pass") {
          send("status", {
            phase: "final-analysis",
            message:
              analysisMode === "full-text-only"
                ? "Reading the document end-to-end for contradictions…"
                : `Running final contradiction analysis across ${ingestedTitles.length} sections…`,
          });
          try {
            const analyzerInput =
              analysisMode === "full-text-only"
                ? fullText
                : buildFinalAnalyzerSeed(chapters);
            const flags = await analyzeSelfConsistency(analyzerInput);
            send("contradictions", {
              afterChapter: chapters.length - 1,
              afterTitle: "full-text analysis",
              chapters_ingested: ingestedTitles,
              flags,
              final: true,
            });
          } catch (e) {
            send("error", {
              phase: "final-analysis",
              message: e instanceof Error ? e.message : String(e),
            });
          }
        }

        send("done", {
          totalChapters: chapters.length,
          strategy,
          analysisMode,
          analyzerCalls,
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
 * For the final-pass analyzer on large docs, sample the first ~500 words of
 * each ingested chapter so the analyzer's query captures cross-chapter facts
 * rather than only the last one. Keeps the Opus prompt manageable.
 */
function buildFinalAnalyzerSeed(
  chapters: Array<{ title: string; content: string }>,
): string {
  const parts: string[] = [];
  for (const ch of chapters) {
    const snippet = ch.content
      .replace(/\s+/g, " ")
      .split(" ")
      .slice(0, 500)
      .join(" ");
    parts.push(`[${ch.title}] ${snippet}`);
  }
  return parts.join("\n\n").slice(0, 12000);
}

/**
 * Self-consistency pass: hand the WHOLE chapter to Opus and ask it to find
 * pairs of contradicting facts within the same text. No Cognee call — pure
 * LLM. This is the mode that catches "Sarah is left-handed on page 2 /
 * writes with her right hand on page 5" in a single-chapter upload.
 * Cost: 1 Opus call. Zero Cognee credits.
 */
async function analyzeSelfConsistency(chapterText: string): Promise<Flag[]> {
  const text = chapterText.slice(0, 12000);
  const system = `You are a continuity checker. Given a chapter of prose, find every pair of factual statements within it that CONTRADICT each other — a character described one way in one paragraph and differently later, a location distance stated two ways, an object owned by two people, a timeline that doesn't add up, etc.

Return a strict JSON array. Each item:
{
  "new_scene_span": "the later or contradicting quote (verbatim, short)",
  "contradicts_fact": "the earlier or contradicted quote (verbatim, short)",
  "contradiction_kind": "identity|location|time|possession|relationship|physical_attribute|causal",
  "explanation": "one sentence, plain English",
  "confidence": 0.0-1.0
}

Rules:
- Only flag FACTUAL contradictions. Not tone shifts, not stylistic drift.
- Both quotes must actually appear in the text.
- Empty array is a valid answer when the chapter is internally consistent.
- Return ONLY the JSON array. No prose, no code fences.`;
  const user = `CHAPTER TEXT:
<<<
${text}
>>>

Find every internal contradiction. Return the JSON array.`;

  const opus = await callOpus({
    system,
    messages: [{ role: "user", content: user }],
    maxTokens: 1024,
  });

  const match = opus.text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]) as Flag[];
  } catch {
    return [];
  }
}

/**
 * Cross-chapter contradiction: pull facts from Cognee graph, feed to Opus.
 * Single SearchType (GRAPH_COMPLETION) — TEMPORAL/TRIPLET had diminishing
 * returns per credit spent.
 */
async function analyzeContradictions(
  datasetId: string,
  newChapterText: string,
): Promise<Flag[]> {
  const searchType: SearchType = "GRAPH_COMPLETION";
  const querySlice = newChapterText.slice(0, 4000);

  let retrievedContext = "(no prior facts retrieved yet)";
  try {
    const items = await recall({
      query: `Facts contradicting: ${querySlice}`,
      datasetIds: [datasetId],
      searchType,
      topK: 8,
      includeReferences: true,
    });
    const chunks = items.map((it) => `[${searchType}] ${it.text}`);
    if (chunks.length > 0) retrievedContext = chunks.join("\n\n");
  } catch {
    // Cognee failure is not fatal — Opus will just find nothing.
  }

  const opus = await callOpus({
    system: CONTRADICTION_DETECT_SYSTEM,
    messages: [
      {
        role: "user",
        content: contradictionUserPrompt({
          newSceneText: querySlice,
          retrievedContext,
        }),
      },
    ],
    maxTokens: 1024,
  });

  const match = opus.text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    return JSON.parse(match[0]) as Flag[];
  } catch {
    return [];
  }
}
