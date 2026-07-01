/**
 * Extract chapters from a PDF buffer.
 *
 * Strategy:
 *  1. Extract raw text with pdf-parse v2 (PDFParse class).
 *  2. Try to split on chapter markers (Chapter 1, CHAPTER I, Part 1, Book 1, etc.).
 *  3. If no markers found, fall back to fixed-size chunks (~3500 words each).
 */

import { PDFParse } from "pdf-parse";

export interface ExtractedChapter {
  title: string;
  content: string;
  wordCount: number;
}

const CHAPTER_REGEXES: RegExp[] = [
  /^\s*(Chapter|CHAPTER)\s+(\d+|[IVXLCDM]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|Thirteen|Fourteen|Fifteen|Sixteen|Seventeen|Eighteen|Nineteen|Twenty)\b[^\n]*$/im,
  /^\s*(Part|PART)\s+(\d+|[IVXLCDM]+|One|Two|Three|Four|Five)\b[^\n]*$/im,
  /^\s*(Book|BOOK)\s+(\d+|[IVXLCDM]+)\b[^\n]*$/im,
];

const TARGET_CHUNK_WORDS = 3500;

function splitByMarker(text: string, re: RegExp): ExtractedChapter[] | null {
  const globalRe = new RegExp(
    re.source,
    re.flags.includes("g") ? re.flags : re.flags + "g",
  );
  const positions: Array<{ index: number; heading: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = globalRe.exec(text)) !== null) {
    positions.push({ index: m.index, heading: m[0].trim() });
    if (m.index === globalRe.lastIndex) globalRe.lastIndex++;
  }
  if (positions.length < 2) return null;

  const chapters: ExtractedChapter[] = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index;
    const end = i + 1 < positions.length ? positions[i + 1].index : text.length;
    const content = text.slice(start, end).trim();
    if (content.length < 200) continue;
    chapters.push({
      title: positions[i].heading.slice(0, 120),
      content,
      wordCount: content.split(/\s+/).filter(Boolean).length,
    });
  }
  return chapters.length >= 2 ? chapters : null;
}

function splitByWordCount(text: string): ExtractedChapter[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: ExtractedChapter[] = [];
  for (let i = 0; i < words.length; i += TARGET_CHUNK_WORDS) {
    const slice = words.slice(i, i + TARGET_CHUNK_WORDS);
    const content = slice.join(" ");
    chunks.push({
      title: `Section ${chunks.length + 1}`,
      content,
      wordCount: slice.length,
    });
  }
  return chunks;
}

export async function extractChapters(
  buffer: Buffer,
  filename: string,
): Promise<{
  chapters: ExtractedChapter[];
  totalPages: number;
  totalWords: number;
  strategy: "chapter-marker" | "fixed-chunk" | "single";
}> {
  // pdf-parse v2 API — PDFParse instance with getText() method
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let text = "";
  let totalPages = 0;
  try {
    const info = await parser.getInfo();
    totalPages = info?.total ?? 0;
    const result = await parser.getText();
    text = (result?.text ?? "").trim();
  } finally {
    try {
      await parser.destroy();
    } catch {
      /* ignore */
    }
  }

  let best: { chapters: ExtractedChapter[]; strategy: "chapter-marker" } | null = null;
  for (const re of CHAPTER_REGEXES) {
    const split = splitByMarker(text, re);
    if (split && (!best || split.length > best.chapters.length)) {
      best = { chapters: split, strategy: "chapter-marker" };
    }
  }

  if (best && best.chapters.length >= 2) {
    return {
      chapters: best.chapters,
      totalPages,
      totalWords: text.split(/\s+/).filter(Boolean).length,
      strategy: "chapter-marker",
    };
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount <= TARGET_CHUNK_WORDS) {
    return {
      chapters: [
        {
          title: filename.replace(/\.[^.]+$/, ""),
          content: text,
          wordCount,
        },
      ],
      totalPages,
      totalWords: wordCount,
      strategy: "single",
    };
  }

  return {
    chapters: splitByWordCount(text),
    totalPages,
    totalWords: wordCount,
    strategy: "fixed-chunk",
  };
}
