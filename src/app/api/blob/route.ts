import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

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

/**
 * Client-direct upload endpoint. The browser POSTs a token request here
 * with the filename; we validate + return a signed upload URL that the
 * browser then uses to PUT the file directly to Vercel Blob storage —
 * bypassing the 4.5 MB serverless function body limit.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        const dot = pathname.lastIndexOf(".");
        const ext = dot === -1 ? "" : pathname.slice(dot).toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(ext)) {
          throw new Error(
            `unsupported file type: ${ext || "(none)"}; allowed: ${ALLOWED_EXTENSIONS.join(", ")}`,
          );
        }
        return {
          allowedContentTypes: [
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "text/plain",
            "text/markdown",
            "application/rtf",
            "text/rtf",
            "application/vnd.oasis.opendocument.text",
            "application/octet-stream",
          ],
          maximumSizeInBytes: MAX_FILE_MB * 1024 * 1024,
          addRandomSuffix: true,
        };
      },
      onUploadCompleted: async () => {
        // Nothing to do server-side here; the ingest happens in a follow-up call.
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
