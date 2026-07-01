import { NextRequest, NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { remember } from "@/lib/cognee";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Second step of the client-direct upload flow.
 *
 * 1. Browser uploaded file directly to Vercel Blob (via /api/blob) and got back a URL.
 * 2. Browser posts that URL here.
 * 3. We fetch the file from Blob, forward the bytes to Cognee via remember(),
 *    and delete the Blob when done.
 *
 * This bypasses the 4.5 MB serverless function body cap.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      blob_url,
      filename,
      title: overrideTitle,
      project_id: projectIdRaw,
      order: orderRaw,
    } = body as {
      blob_url?: string;
      filename?: string;
      title?: string;
      project_id?: string;
      order?: number | string;
    };

    if (!blob_url || !filename) {
      return NextResponse.json(
        { error: "blob_url and filename required" },
        { status: 400 },
      );
    }

    const projectId = projectIdRaw ?? "default";
    const order = orderRaw ? Number(orderRaw) : Date.now();
    const chapterId = `ch_${order}`;
    const dot = filename.lastIndexOf(".");
    const ext = dot === -1 ? "" : filename.slice(dot).toLowerCase();
    const title = overrideTitle ?? filename.replace(/\.[^.]+$/, "");
    const datasetId = process.env.DEMO_DATASET_ID!;

    // Fetch bytes from Vercel Blob.
    const fetched = await fetch(blob_url);
    if (!fetched.ok) {
      return NextResponse.json(
        { error: `blob fetch failed: ${fetched.status}` },
        { status: 502 },
      );
    }
    const arrayBuffer = await fetched.arrayBuffer();
    const mime =
      fetched.headers.get("content-type") ?? "application/octet-stream";
    const namedBlob = new File([arrayBuffer], filename, { type: mime });

    let result;
    try {
      result = await remember({
        data: namedBlob,
        datasetId,
        nodeSet: [
          `project:${projectId}`,
          `chapter_id:${chapterId}`,
          `chapter_order:${order}`,
          `chapter_title:${title}`,
          `file_type:${ext.slice(1) || "unknown"}`,
          "kind:chapter",
          "kind:file_upload",
        ],
        runInBackground: true, // let Cognee cognify in background; return fast
      });
    } finally {
      // Best-effort cleanup of the transient blob.
      try {
        await del(blob_url);
      } catch (delErr) {
        console.warn("[ingest-blob] blob delete failed:", delErr);
      }
    }

    return NextResponse.json({
      chapter_id: chapterId,
      title,
      filename,
      size_bytes: arrayBuffer.byteLength,
      mime,
      extension: ext,
      status: result.status,
      pipeline_run_id: result.pipeline_run_id,
      items_processed: result.items_processed,
      elapsed_seconds: result.elapsed_seconds,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
