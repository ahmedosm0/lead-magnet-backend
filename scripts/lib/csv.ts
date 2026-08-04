/**
 * Minimal CSV reader — no external dependency needed for the header shapes
 * this pipeline deals with (GA4 exports, Meta Ads Manager exports).
 * Handles quoted fields (Meta quotes headers/values that contain commas,
 * e.g. "CPM (cost per 1,000 impressions) (USD)").
 */

function parseLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

export type CsvRecord = Record<string, string>;

export function parseCsv(text: string): CsvRecord[] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const header = parseLine(lines[0]);
  const records: CsvRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const record: CsvRecord = {};
    header.forEach((key, idx) => {
      record[key] = cells[idx] ?? "";
    });
    records.push(record);
  }

  return records;
}

/** Required field lookup that fails loudly instead of silently producing NaN/undefined downstream. */
export function requireField(record: CsvRecord, field: string, context: string): string {
  const value = record[field];
  if (value === undefined) {
    throw new Error(
      `Missing expected column "${field}" while parsing ${context}. ` +
        `Found columns: ${Object.keys(record).join(", ")}`
    );
  }
  return value;
}

export function requireNumber(record: CsvRecord, field: string, context: string): number {
  const raw = requireField(record, field, context);
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Column "${field}" in ${context} is not a number: "${raw}"`);
  }
  return value;
}

/** For columns Meta leaves blank depending on campaign objective (e.g. "Purchase value" on a leads campaign). */
export function optionalNumber(record: CsvRecord, field: string, context: string): number | null {
  const raw = requireField(record, field, context);
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Column "${field}" in ${context} is not a number: "${raw}"`);
  }
  return value;
}
