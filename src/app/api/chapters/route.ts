import { NextRequest, NextResponse } from "next/server";
import { remember } from "@/lib/cognee";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { title, content, order, projectId } = body;

    if (!title || !content) {
      return NextResponse.json(
        { error: "title and content required" },
        { status: 400 },
      );
    }

    const datasetId = process.env.DEMO_DATASET_ID!;
    const chapterId = `ch_${order ?? Date.now()}`;

    // Ingest into Cognee as permanent memory (no session_id).
    // NodeSet tags tag every entity extracted with provenance.
    const result = await remember({
      data: {
        text: `# ${title}\n\nChapter ID: ${chapterId}\n\n${content}`,
        filename: `${chapterId}.md`,
      },
      datasetId,
      nodeSet: [
        `project:${projectId ?? "default"}`,
        `chapter_id:${chapterId}`,
        `chapter_order:${order ?? 0}`,
        `chapter_title:${title}`,
        "kind:chapter",
      ],
      runInBackground: false,
    });

    return NextResponse.json({
      chapter_id: chapterId,
      title,
      status: result.status,
      items_processed: result.items_processed,
      elapsed_seconds: result.elapsed_seconds,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
