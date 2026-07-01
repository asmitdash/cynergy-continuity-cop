import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    project: "continuity-cop",
    cognee: process.env.COGNEE_BASE_URL ? "configured" : "missing",
    bedrock: process.env.AWS_ACCESS_KEY_ID ? "configured" : "missing",
    model: process.env.BEDROCK_MODEL_ID ?? "global.anthropic.claude-opus-4-7[1m]",
  });
}
