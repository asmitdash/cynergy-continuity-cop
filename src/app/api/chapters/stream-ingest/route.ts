import { NextRequest } from "next/server";
import { del } from "@vercel/blob";
import { remember, recall, type SearchType } from "@/lib/cognee";
import { callOpus } from "@/lib/bedrock";
import { extractChapters } from "@/lib/pdf-split";
import { CONTRADICTION_DETECT_SYSTEM, contradictionUserPrompt } from "@/lib/prompts";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 min ceiling — long books hit this on Hobby

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
 * Server-Sent Events endpoint: stream chapter-by-chapter ingestion progress
 * plus rolling contradiction analysis. Body: JSON with { blob_url, filename }.
 */
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
        // 1. Fetch bytes from Blob
        send("status", { phase: "download", message: `Fetching ${filename}…` });
        const fetched = await fetch(blob_url);
        if (!fetched.ok) throw new Error(`blob fetch failed: ${fetched.status}`);
        const buffer = Buffer.from(await fetched.arrayBuffer());
        send("status", {
          phase: "download",
          message: `Downloaded ${(buffer.length / 1024).toFixed(0)} KB`,
        });

        // 2. Split into chapters
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
          // For non-PDF (txt/md/etc), treat as a single chapter for now.
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

        send("split", {
          totalChapters: chapters.length,
          totalPages,
          totalWords,
          strategy,
          titles: chapters.map((c) => c.title),
        });

        // 3. For each chapter: ingest, then run contradiction check across all-ingested-so-far
        const ingestedTitles: string[] = [];
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
              // Background ingestion — Cognee cognifies async while we move on.
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

          // Contradiction sweep — only starting at chapter 2 (need something to contradict).
          if (i >= 1) {
            send("progress", {
              index: i,
              total: chapters.length,
              phase: "analyze",
              title: ch.title,
            });
            try {
              const flags = await analyzeContradictions(datasetId, ch.content);
              send("contradictions", {
                afterChapter: i,
                afterTitle: ch.title,
                chapters_ingested: ingestedTitles,
                flags,
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

        send("done", {
          totalChapters: chapters.length,
          strategy,
        });
      } catch (e) {
        send("error", {
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        // Best-effort cleanup of the transient blob.
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

async function analyzeContradictions(
  datasetId: string,
  newChapterText: string,
): Promise<Flag[]> {
  const searchTypes: SearchType[] = [
    "GRAPH_COMPLETION",
    "TEMPORAL",
    "TRIPLET_COMPLETION",
  ];

  // Use a shorter query slice so retrieval is snappy.
  const querySlice = newChapterText.slice(0, 4000);
  const recalls = await Promise.allSettled(
    searchTypes.map((st) =>
      recall({
        query: `Facts contradicting: ${querySlice}`,
        datasetIds: [datasetId],
        searchType: st,
        topK: 6,
        includeReferences: true,
      }),
    ),
  );

  const chunks: string[] = [];
  recalls.forEach((r, i) => {
    if (r.status === "fulfilled") {
      for (const item of r.value) {
        chunks.push(`[${searchTypes[i]}] ${item.text}`);
      }
    }
  });
  const retrievedContext = chunks.slice(0, 15).join("\n\n") || "(no prior facts retrieved yet)";

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
