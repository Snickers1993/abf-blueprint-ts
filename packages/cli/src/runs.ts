import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RunEntry {
  /** ISO timestamp. */
  at: string;
  step: string;
  seconds: number;
  ok: boolean;
  units?: number;
  mode: "warm" | "cold";
  /** The asset of a per-asset step (`read.editor`). */
  asset?: string;
}

/** Appends one JSON line to the runs file (`.abfc/runs.jsonl`), creating the folder when needed. */
export function recordRun(file: string, entry: RunEntry): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
}

/** Reads the runs file; unreadable lines are skipped. Returns an empty list when the file does not exist. */
export function readRuns(file: string): RunEntry[] {
  if (!existsSync(file)) return [];
  const entries: RunEntry[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as RunEntry);
    } catch {
      // skip a damaged line
    }
  }
  return entries;
}

/** One line per entry: `<at>  <step padded>  <seconds>s  ok|FAILED  [units]`, then a total. */
export function formatTimings(entries: RunEntry[]): string[] {
  const width = Math.max(4, ...entries.map((e) => e.step.length));
  const lines = entries.map(
    (e) =>
      `${e.at}  ${e.step.padEnd(width)}  ${e.seconds.toFixed(1).padStart(7)}s  ${e.ok ? "ok    " : "FAILED"}  ${e.mode}` +
      (e.units !== undefined ? `  ${e.units} unit(s)` : ""),
  );
  const total = entries.reduce((sum, e) => sum + e.seconds, 0);
  lines.push(`total ${total.toFixed(1)}s over ${entries.length} step(s)`);
  return lines;
}
