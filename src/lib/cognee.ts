/**
 * Cognee Cloud client — wraps the /api/v1 REST surface.
 *
 * All calls go against COGNEE_BASE_URL with X-Api-Key header.
 * Tenant URL for this hackathon:
 *   https://tenant-cf529850-d29f-4ecb-b055-d6b200935050.aws.cognee.ai
 *
 * Cognee's endpoints redirect (307) if the trailing slash is wrong.
 * Always include the trailing slash on paths that need it.
 */

const BASE_URL = process.env.COGNEE_BASE_URL!;
const API_KEY = process.env.COGNEE_API_KEY!;

if (!BASE_URL || !API_KEY) {
  console.warn(
    "[cognee-client] COGNEE_BASE_URL or COGNEE_API_KEY missing at import time",
  );
}

function headers(extra: Record<string, string> = {}) {
  return {
    "X-Api-Key": API_KEY,
    ...extra,
  };
}

// ------------- Types -------------

export type SearchType =
  | "GRAPH_COMPLETION"
  | "RAG_COMPLETION"
  | "CHUNKS"
  | "SUMMARIES"
  | "TRIPLET_COMPLETION"
  | "CHUNKS_LEXICAL"
  | "CODING_RULES"
  | "TEMPORAL"
  | "GRAPH_COMPLETION_COT"
  | "GRAPH_COMPLETION_CONTEXT_EXTENSION"
  | "GRAPH_SUMMARY_COMPLETION"
  | "CYPHER"
  | "NATURAL_LANGUAGE"
  | "FEELING_LUCKY"
  | "HYBRID_COMPLETION"
  | "GRAPH_COMPLETION_DECOMPOSITION"
  | "AGENTIC_COMPLETION";

export interface Dataset {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string | null;
  ownerId: string;
}

export interface RememberResult {
  status: "running" | "completed" | "failed";
  dataset_id: string;
  dataset_name: string | null;
  pipeline_run_id: string | null;
  items_processed: number;
  elapsed_seconds: number | null;
  items?: Array<{ id: string }>;
}

export interface RecallResult {
  kind: string;
  search_type: SearchType;
  text: string;
  score: number | null;
  dataset_id: string;
  dataset_name: string;
  metadata: Record<string, unknown>;
  raw: unknown;
  structured: unknown;
  source: string;
}

// ------------- Datasets -------------

export async function listDatasets(): Promise<Dataset[]> {
  const res = await fetch(`${BASE_URL}/api/v1/datasets/`, {
    method: "GET",
    headers: headers(),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`listDatasets ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function createDataset(name: string): Promise<Dataset> {
  const res = await fetch(`${BASE_URL}/api/v1/datasets/`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name }),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`createDataset ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function deleteDataset(datasetId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/datasets/${datasetId}/`, {
    method: "DELETE",
    headers: headers(),
    redirect: "follow",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`deleteDataset ${res.status}: ${await res.text()}`);
  }
}

// ------------- Remember (permanent, no session_id) -------------

export interface RememberInput {
  data: Blob | { text: string; filename?: string };
  datasetName?: string;
  datasetId?: string;
  nodeSet?: string[];
  runInBackground?: boolean;
  contentType?: "skills" | undefined;
  ontologyKey?: string[];
  customPrompt?: string;
}

/**
 * Hand-built multipart POST for Cognee's /api/v1/remember/.
 *
 * WHY: Node undici's built-in FormData + fetch combination produces a
 * multipart body that Cognee's FastAPI parser rejects with
 * `{"detail":"There was an error parsing the body"}`, even though the
 * fields match exactly what curl sends successfully. Writing the body
 * ourselves works. Verified end-to-end 2026-07-02.
 */
export async function remember(input: RememberInput): Promise<RememberResult> {
  const boundary =
    "----CogneeBoundary" +
    Math.random().toString(16).slice(2) +
    Date.now().toString(16);
  const CRLF = "\r\n";
  const parts: Buffer[] = [];
  const pushText = (s: string) => parts.push(Buffer.from(s, "utf8"));
  const pushRaw = (b: Buffer) => parts.push(b);

  const addField = (name: string, value: string) => {
    pushText(`--${boundary}${CRLF}`);
    pushText(`Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`);
    pushText(`${value}${CRLF}`);
  };

  // Scalar fields first
  if (input.datasetId) addField("datasetId", input.datasetId);
  if (input.datasetName) addField("datasetName", input.datasetName);
  if (input.nodeSet) addField("node_set", JSON.stringify(input.nodeSet));
  if (typeof input.runInBackground === "boolean")
    addField("run_in_background", String(input.runInBackground));
  if (input.contentType) addField("content_type", input.contentType);
  if (input.ontologyKey)
    input.ontologyKey.forEach((k) => addField("ontology_key", k));
  if (input.customPrompt) addField("custom_prompt", input.customPrompt);

  // File field last
  let filename = "upload.bin";
  let mime = "application/octet-stream";
  let bytes: Buffer;
  if (input.data instanceof Blob) {
    if (input.data instanceof File) filename = input.data.name || filename;
    mime = input.data.type || mime;
    const ab = await input.data.arrayBuffer();
    bytes = Buffer.from(ab);
  } else {
    filename = input.data.filename ?? "note.md";
    mime = "text/markdown";
    bytes = Buffer.from(input.data.text, "utf8");
  }
  pushText(`--${boundary}${CRLF}`);
  pushText(
    `Content-Disposition: form-data; name="data"; filename="${filename}"${CRLF}`,
  );
  pushText(`Content-Type: ${mime}${CRLF}${CRLF}`);
  pushRaw(bytes);
  pushText(CRLF);
  pushText(`--${boundary}--${CRLF}`);

  const body = Buffer.concat(parts);

  const res = await fetch(`${BASE_URL}/api/v1/remember/`, {
    method: "POST",
    headers: {
      ...headers(),
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(body.length),
    },
    body,
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`remember ${res.status}: ${await res.text()}`);
  return res.json();
}

// ------------- Recall -------------

export interface RecallInput {
  query: string;
  datasetIds?: string[];
  datasetNames?: string[];
  searchType?: SearchType;
  nodeName?: string[];
  nodeNameFilterOperator?: "AND" | "OR";
  topK?: number;
  onlyContext?: boolean;
  includeReferences?: boolean;
}

export async function recall(input: RecallInput): Promise<RecallResult[]> {
  const body: Record<string, unknown> = { query: input.query };
  if (input.datasetIds) body.datasetIds = input.datasetIds;
  if (input.datasetNames) body.datasetNames = input.datasetNames;
  if (input.searchType) body.searchType = input.searchType;
  if (input.nodeName) body.node_name = input.nodeName;
  if (input.nodeNameFilterOperator)
    body.node_name_filter_operator = input.nodeNameFilterOperator;
  if (typeof input.topK === "number") body.top_k = input.topK;
  if (typeof input.onlyContext === "boolean") body.only_context = input.onlyContext;
  if (typeof input.includeReferences === "boolean")
    body.include_references = input.includeReferences;

  const res = await fetch(`${BASE_URL}/api/v1/recall/`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`recall ${res.status}: ${await res.text()}`);
  return res.json();
}

// ------------- Forget -------------

export interface ForgetInput {
  dataId?: string;
  datasetId?: string;
  datasetName?: string;
  memoryOnly?: boolean;
}

export async function forget(input: ForgetInput): Promise<{ deleted: boolean }> {
  const body: Record<string, unknown> = {};
  if (input.dataId) body.data_id = input.dataId;
  if (input.datasetId) body.dataset_id = input.datasetId;
  if (input.datasetName) body.dataset_name = input.datasetName;
  if (typeof input.memoryOnly === "boolean") body.memory_only = input.memoryOnly;

  const res = await fetch(`${BASE_URL}/api/v1/forget/`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`forget ${res.status}: ${await res.text()}`);
  return res.json();
}

// ------------- Improve -------------

export interface ImproveInput {
  datasetId?: string;
  datasetName?: string;
  sessionIds?: string[];
  feedbackAlpha?: number;
  buildTruthSubspace?: boolean;
  nodeName?: string[];
}

export async function improve(input: ImproveInput): Promise<{ status: string }> {
  const body: Record<string, unknown> = {};
  if (input.datasetId) body.dataset_id = input.datasetId;
  if (input.datasetName) body.dataset_name = input.datasetName;
  if (input.sessionIds) body.session_ids = input.sessionIds;
  if (typeof input.feedbackAlpha === "number")
    body.feedback_alpha = input.feedbackAlpha;
  if (typeof input.buildTruthSubspace === "boolean")
    body.build_truth_subspace = input.buildTruthSubspace;
  if (input.nodeName) body.node_name = input.nodeName;

  const res = await fetch(`${BASE_URL}/api/v1/improve/`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`improve ${res.status}: ${await res.text()}`);
  return res.json();
}

// ------------- Graph export -------------

export interface GraphNode {
  id: string;
  label: string;
  type?: string;
  properties?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}

export interface GraphExport {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export async function exportGraph(datasetId: string): Promise<GraphExport> {
  const res = await fetch(
    `${BASE_URL}/api/v1/datasets/${datasetId}/graph/`,
    {
      method: "GET",
      headers: headers(),
      redirect: "follow",
    },
  );
  if (!res.ok) throw new Error(`exportGraph ${res.status}: ${await res.text()}`);
  return res.json();
}
