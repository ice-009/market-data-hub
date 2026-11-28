import { summarizeOptions, type OptionSummary } from "./optionSummary.js";
import { parseFoOptions, parseFoOptionsLegacy } from "./parsers/foOptions.js";

// An F&O bhavcopy (unzipped CSV, either format) → that day's option summaries.
// Pure. The format is told by the header (the old one starts INSTRUMENT,SYMBOL).

export type OptionFileRead = { kind: "ok"; summaries: OptionSummary[]; badRows: number } | { kind: "mismatch"; note: string };

const legacy = (csv: string) => /^\uFEFF?\s*INSTRUMENT\s*,/i.test(csv);

export function summarizeFoCsv(day: number, csv: string): OptionFileRead {
  const parsed = legacy(csv) ? parseFoOptionsLegacy(csv) : parseFoOptions(csv);
  if (parsed.mixedDates) return { kind: "mismatch", note: "file has more than one trade date" };
  if (parsed.tradeDate !== day) return { kind: "mismatch", note: `file is for ${parsed.tradeDate === null ? "no date" : new Date(parsed.tradeDate).toISOString().slice(0, 10)}` };
  return { kind: "ok", summaries: summarizeOptions(day, parsed.options, parsed.futures), badRows: parsed.badRows };
}
