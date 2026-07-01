import { NextRequest, NextResponse } from "next/server";
import { improve } from "@/lib/cognee";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { flag_id, resolution, notes } = body;

    const datasetId = process.env.DEMO_DATASET_ID!;

    // improve() records feedback into Cognee's truth-subspace reranker.
    // For Loop 1 we call improve on the whole dataset with a feedback alpha.
    // In a future loop we'd scope this to the specific flag's node_set.
    const result = await improve({
      datasetId,
      feedbackAlpha: resolution === "false_positive" ? -0.5 : 0.5,
      buildTruthSubspace: true,
    });

    return NextResponse.json({
      flag_id,
      resolution,
      notes,
      cognee_status: result.status,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
