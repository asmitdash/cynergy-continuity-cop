import { NextRequest, NextResponse } from "next/server";
import {
  getJob,
  getBatchStates,
  getSweepStates,
  getFlags,
  countBatches,
} from "@/lib/job-store";

export const runtime = "nodejs";

/**
 * Poll job progress. Client hits this every ~2s.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });

  const [batchStates, sweepStates, flags, counts] = await Promise.all([
    getBatchStates(id),
    getSweepStates(id),
    getFlags(id),
    countBatches(id),
  ]);

  const ingestedPct =
    counts.total === 0 ? 0 : Math.round((counts.ingested / counts.total) * 100);
  const sweepsDone = sweepStates.filter((s) => s.state === "done").length;
  const overallPct =
    job.state === "done"
      ? 100
      : Math.min(
          95,
          Math.round(
            ingestedPct * 0.7 +
              (sweepsDone / Math.max(1, sweepStates.length)) * 25,
          ),
        );

  return NextResponse.json({
    job,
    batches: batchStates,
    sweeps: sweepStates.map((s) => ({ kind: s.kind, state: s.state })),
    counts,
    flags,
    progress: {
      ingested_pct: ingestedPct,
      overall_pct: overallPct,
    },
  });
}
