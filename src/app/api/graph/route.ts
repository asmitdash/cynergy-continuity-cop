import { NextRequest, NextResponse } from "next/server";
import { exportGraph } from "@/lib/cognee";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(_req: NextRequest) {
  try {
    const datasetId = process.env.DEMO_DATASET_ID!;
    const graph = await exportGraph(datasetId);
    return NextResponse.json(graph);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // On error, return an empty graph so the UI can still render.
    return NextResponse.json(
      { nodes: [], edges: [], error: msg },
      { status: 200 },
    );
  }
}
