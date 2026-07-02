import { NextRequest, NextResponse } from "next/server";
import { extractChapters, batchChapters } from "@/lib/pdf-split";
import { createJob, insertBatches, insertSweeps } from "@/lib/job-store";

export const runtime = "nodejs";
export const maxDuration = 60;

const BATCH_TARGET_WORDS = 20000;

/**
 * Kick off a long-running ingestion job.
 *
 * Body: { blob_url, filename }
 * Response: { job_id, batches, totalWords, totalPages, strategy }
 *
 * Work done here: download the file, split into chapters, batch into ~20k-word
 * groups, and write both the job row and per-batch rows to Neon. All of that
 * fits comfortably in 60s even for large books.
 *
 * The actual ingestion (Cognee remember() calls) is deferred to /api/job/[id]/tick,
 * which the client polls.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { blob_url, filename } = body as {
      blob_url?: string;
      filename?: string;
    };
    if (!blob_url || !filename) {
      return NextResponse.json(
        { error: "blob_url and filename required" },
        { status: 400 },
      );
    }

    const fetched = await fetch(blob_url);
    if (!fetched.ok) {
      return NextResponse.json(
        { error: `blob fetch failed: ${fetched.status}` },
        { status: 502 },
      );
    }
    const buffer = Buffer.from(await fetched.arrayBuffer());

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

    const batches = batchChapters(chapters, BATCH_TARGET_WORDS);
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    await createJob({
      id: jobId,
      filename,
      totalPages,
      totalWords,
      totalChapters: chapters.length,
      strategy,
    });
    await insertBatches(jobId, batches);
    await insertSweeps(jobId, ["graph-cot", "triplet"]);

    return NextResponse.json({
      job_id: jobId,
      filename,
      totalPages,
      totalWords,
      totalChapters: chapters.length,
      totalBatches: batches.length,
      strategy,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
