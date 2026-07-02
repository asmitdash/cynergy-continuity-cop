import { NextRequest, NextResponse } from "next/server";
import {
  getJob,
  setJobState,
  claimNextQueuedBatch,
  markBatchDone,
  markBatchError,
  countBatches,
  claimNextQueuedSweep,
  saveSweep,
  markSweepError,
  getSweepStates,
  saveFlags,
} from "@/lib/job-store";
import { remember, recall, type SearchType } from "@/lib/cognee";
import { callOpus } from "@/lib/bedrock";

export const runtime = "nodejs";
// Well under Vercel Hobby 60s cap. One tick does one meaningful step.
export const maxDuration = 55;

interface Flag {
  new_scene_span: string;
  contradicts_fact: string;
  contradiction_kind: string;
  explanation: string;
  confidence: number;
}

/**
 * Advance a job by ONE step. Called repeatedly by the client's polling loop.
 * Each call does at most one of:
 *   - ingest one queued batch (~30s each)
 *   - run one sweep query (GRAPH_COMPLETION_COT or TRIPLET_COMPLETION, ~15s)
 *   - run the final Opus normalize pass (~15s)
 *   - noop (all work already done)
 *
 * Returns { did } describing what happened this tick.
 */
export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: jobId } = await ctx.params;
  try {
    const job = await getJob(jobId);
    if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
    if (job.state === "done" || job.state === "error") {
      return NextResponse.json({ did: "noop", state: job.state });
    }

    // Step 1: any queued batches? Ingest the next one.
    const batch = await claimNextQueuedBatch(jobId);
    if (batch) {
      try {
        const batchId = `${jobId}_b${batch.idx}`;
        await remember({
          data: {
            text: `# ${batch.title}\n\nBatch ID: ${batchId}\n\n${batch.content}`,
            filename: `${batchId}.md`,
          },
          datasetId: process.env.DEMO_DATASET_ID!,
          nodeSet: [
            `job_id:${jobId}`,
            `batch_id:${batchId}`,
            `batch_index:${batch.idx}`,
            `source_file:${job.filename}`,
            "kind:chapter",
            "kind:file_upload",
          ],
          runInBackground: true,
        });
        await markBatchDone(jobId, batch.idx);
        return NextResponse.json({
          did: "ingest",
          batch_idx: batch.idx,
          title: batch.title,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await markBatchError(jobId, batch.idx, msg);
        return NextResponse.json({
          did: "ingest-error",
          batch_idx: batch.idx,
          error: msg,
        });
      }
    }

    // Step 2: all batches ingested. Run next queued sweep.
    const counts = await countBatches(jobId);
    if (counts.ingested === 0 && counts.error > 0) {
      // Nothing ingested successfully — no point sweeping.
      await setJobState(jobId, "error", "no batches ingested successfully");
      return NextResponse.json({ did: "abort", reason: "no batches ingested" });
    }

    await setJobState(jobId, "sweeping");
    const sweep = await claimNextQueuedSweep(jobId);
    if (sweep) {
      const searchType: SearchType =
        sweep.kind === "graph-cot" ? "GRAPH_COMPLETION_COT" : "TRIPLET_COMPLETION";
      try {
        const items = await recall({
          query: buildSweepQuery(),
          datasetIds: [process.env.DEMO_DATASET_ID!],
          searchType,
          nodeName: [`job_id:${jobId}`],
          topK: 20,
          includeReferences: true,
        });
        const joined = items.map((it) => it.text).join("\n\n") || "";
        await saveSweep(jobId, sweep.kind, joined);
        return NextResponse.json({ did: "sweep", kind: sweep.kind });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await markSweepError(jobId, sweep.kind, msg);
        return NextResponse.json({ did: "sweep-error", kind: sweep.kind, error: msg });
      }
    }

    // Step 3: all sweeps done — run final Opus normalize pass.
    const sweeps = await getSweepStates(jobId);
    const allSweepsDone = sweeps.every((s) => s.state !== "queued" && s.state !== "running");
    if (allSweepsDone) {
      await setJobState(jobId, "normalizing");
      const merged = sweeps
        .filter((s) => s.state === "done" && s.raw_text)
        .map((s) => `[${s.kind}]\n${s.raw_text}`)
        .join("\n\n===\n\n");

      let flags: Flag[] = [];
      if (merged.trim().length > 0) {
        try {
          flags = await normalizeToFlags(merged);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await setJobState(jobId, "error", `normalize failed: ${msg}`);
          return NextResponse.json({ did: "normalize-error", error: msg });
        }
      }
      await saveFlags(jobId, flags);
      await setJobState(jobId, "done");
      return NextResponse.json({ did: "done", flag_count: flags.length });
    }

    return NextResponse.json({ did: "noop" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setJobState(jobId, "error", msg).catch(() => {});
    return NextResponse.json({ did: "error", error: msg }, { status: 500 });
  }
}

function buildSweepQuery(): string {
  return `Identify every pair of facts in this knowledge graph that CONTRADICT each other. For each contradiction, describe both facts and cite where each appears. Be exhaustive — include direct contradictions like character attributes stated differently, timeline conflicts, location conflicts, possession conflicts, relationship conflicts. Return concrete quoted evidence. Only flag FACTUAL contradictions, not stylistic differences.`;
}

async function normalizeToFlags(merged: string): Promise<Flag[]> {
  const opus = await callOpus({
    system: `You are a normalizer. You receive Cognee's contradiction analysis of a document and convert it into a strict JSON array of Flag objects.

Each Flag has:
- new_scene_span: string (a short quoted piece of text that IS the contradiction)
- contradicts_fact: string (the other side)
- contradiction_kind: one of "identity" | "location" | "time" | "possession" | "relationship" | "physical_attribute" | "causal"
- explanation: one plain-English sentence
- confidence: number in [0, 1]

Rules:
- Return ONLY the JSON array. No prose, no code fences.
- Dedup: if two contradictions are the same, keep only one.
- If Cognee found nothing, return [].
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
