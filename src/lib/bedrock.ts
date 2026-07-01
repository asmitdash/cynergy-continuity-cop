/**
 * Bedrock Opus 4.7 (1M context) client for both Continuity Cop and Vegas Deposition.
 *
 * HARD RULE: Every LLM call goes through AWS Bedrock, `global.anthropic.claude-opus-4-7[1m]`,
 * region ap-south-1. No direct Anthropic API. No other providers.
 *
 * KNOWN QUIRK: Opus 4.7 on Bedrock rejects the `temperature` parameter.
 * Passing it returns HTTP 400 with "`temperature` is deprecated for this model".
 * Send only anthropic_version, max_tokens, system, messages.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

const REGION = process.env.AWS_REGION ?? "ap-south-1";
const MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? "global.anthropic.claude-opus-4-7[1m]";

let cachedClient: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (cachedClient) return cachedClient;
  cachedClient = new BedrockRuntimeClient({
    region: REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
  return cachedClient;
}

export interface OpusMessage {
  role: "user" | "assistant";
  content: string;
}

export interface OpusCallInput {
  system: string;
  messages: OpusMessage[];
  maxTokens?: number;
}

export interface OpusCallOutput {
  text: string;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
}

export async function callOpus(input: OpusCallInput): Promise<OpusCallOutput> {
  const client = getClient();

  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: input.maxTokens ?? 4096,
    system: input.system,
    messages: input.messages,
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body),
  });

  const response = await client.send(command);
  const decoded = new TextDecoder().decode(response.body);
  const parsed = JSON.parse(decoded);

  const text = parsed.content?.[0]?.text ?? "";
  const stopReason = parsed.stop_reason ?? "unknown";
  const inputTokens = parsed.usage?.input_tokens ?? 0;
  const outputTokens = parsed.usage?.output_tokens ?? 0;

  return { text, stopReason, inputTokens, outputTokens };
}

export async function* streamOpus(
  input: OpusCallInput,
): AsyncGenerator<string, void, void> {
  const client = getClient();

  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: input.maxTokens ?? 4096,
    system: input.system,
    messages: input.messages,
  };

  const command = new InvokeModelWithResponseStreamCommand({
    modelId: MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body),
  });

  const response = await client.send(command);
  if (!response.body) return;

  for await (const event of response.body) {
    if (!event.chunk?.bytes) continue;
    const chunkText = new TextDecoder().decode(event.chunk.bytes);
    try {
      const parsed = JSON.parse(chunkText);
      if (parsed.type === "content_block_delta" && parsed.delta?.text) {
        yield parsed.delta.text;
      }
    } catch {
      // skip malformed chunks
    }
  }
}
