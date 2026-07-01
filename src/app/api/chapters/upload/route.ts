import { NextRequest, NextResponse } from "next/server";
import { remember } from "@/lib/cognee";

export const runtime = "nodejs";
export const maxDuration = 60;

const ALLOWED_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".txt",
  ".md",
  ".markdown",
  ".rtf",
  ".odt",
];

const MAX_FILE_MB = 20;

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const projectId = String(form.get("project_id") ?? "default");
    const rawOrder = form.get("order");
    const order = rawOrder ? Number(rawOrder) : Date.now();
    const overrideTitle = form.get("title");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "no file provided (form field 'file' required)" },
        { status: 400 },
      );
    }

    const ext = extOf(file.name);
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return NextResponse.json(
        {
          error: "unsupported file type",
          got: ext || "(no extension)",
          allowed: ALLOWED_EXTENSIONS,
        },
        { status: 415 },
      );
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      return NextResponse.json(
        { error: `file too large; max ${MAX_FILE_MB}MB`, got_bytes: file.size },
        { status: 413 },
      );
    }

    const chapterId = `ch_${order}`;
    const title = overrideTitle ? String(overrideTitle) : file.name.replace(/\.[^.]+$/, "");
    const datasetId = process.env.DEMO_DATASET_ID!;

    // Cognee's /api/v1/remember accepts binary uploads — PDFs, DOCX, etc.
    // We forward the file as a Blob (with its original filename preserved so
    // Cognee's file-type detection works) plus node_set tags for provenance.
    const blob = new Blob([await file.arrayBuffer()], {
      type: file.type || "application/octet-stream",
    });

    // We need to pass the filename to Cognee via multipart. `remember()` reads
    // Blob metadata; append filename via a small shim by wrapping in a File.
    const namedBlob = new File([blob], file.name, {
      type: file.type || "application/octet-stream",
    });

    const result = await remember({
      data: namedBlob,
      datasetId,
      nodeSet: [
        `project:${projectId}`,
        `chapter_id:${chapterId}`,
        `chapter_order:${order}`,
        `chapter_title:${title}`,
        `file_type:${ext.slice(1)}`,
        "kind:chapter",
        "kind:file_upload",
      ],
      runInBackground: false,
    });

    return NextResponse.json({
      chapter_id: chapterId,
      title,
      filename: file.name,
      size_bytes: file.size,
      mime: file.type,
      extension: ext,
      status: result.status,
      items_processed: result.items_processed,
      elapsed_seconds: result.elapsed_seconds,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
