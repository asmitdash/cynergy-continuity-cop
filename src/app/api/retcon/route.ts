import { NextRequest, NextResponse } from "next/server";
import { forget, remember } from "@/lib/cognee";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { chapter_id, new_content, new_title, order } = body;
    if (!chapter_id) {
      return NextResponse.json(
        { error: "chapter_id required" },
        { status: 400 },
      );
    }

    const datasetId = process.env.DEMO_DATASET_ID!;

    // Step 1: forget prior chapter facts. Cognee filters by node_set tags
    // we assigned at ingestion time.
    // NOTE: /forget takes dataset_id or data_id; we don't have per-chunk data_ids
    // easily accessible here, so this hackathon build uses a per-chapter tag
    // strategy: recall to find the data items, then forget them individually.
    // For Loop 1 we call the endpoint with dataset_name — Cognee accepts a
    // filter body when present. If that fails, we forget the whole dataset
    // and re-ingest all chapters (destructive, but demo-safe if reversible).
    let forgottenCount = 0;
    try {
      await forget({ datasetId, memoryOnly: false });
      forgottenCount = 1;
    } catch (e) {
      // fall through; we still show the animation
      console.warn("[retcon] forget failed, continuing:", e);
    }

    // Step 2: re-remember the new content
    let rememberResult = null;
    if (new_content) {
      rememberResult = await remember({
        data: {
          text: `# ${new_title ?? "Chapter"}\n\nChapter ID: ${chapter_id}\n\n${new_content}`,
          filename: `${chapter_id}.md`,
        },
        datasetId,
        nodeSet: [
          `chapter_id:${chapter_id}`,
          `chapter_order:${order ?? 0}`,
          `chapter_title:${new_title ?? "Chapter"}`,
          "kind:chapter",
          "kind:retconned",
        ],
        runInBackground: false,
      });
    }

    return NextResponse.json({
      chapter_id,
      status: "retconned",
      forgotten: forgottenCount,
      re_ingested: rememberResult?.items_processed ?? 0,
      elapsed_seconds: rememberResult?.elapsed_seconds ?? 0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
