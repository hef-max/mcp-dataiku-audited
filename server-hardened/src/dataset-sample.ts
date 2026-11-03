import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
export const sampleRequestSchema = z.strictObject({
  project_key: identifier, dataset_name: identifier,
  rows: z.number().int().min(1).max(1000).default(100),
  columns: z.array(z.string().min(1)).min(1).refine(c => new Set(c).size === c.length, 'Duplicate sample columns').optional(),
});
export const SAMPLE_BYTE_LIMIT = 1024 * 1024;

/** Official iter_rows uses tsv-excel-noheader, quoting with doubled quotes.
 * Stop and cancel on the row/byte bound; never buffer a whole dataset.
 * Values remain strings to preserve identifiers and bigint precision.
 */
export async function readTsvSample(response: Response, limit: number, width: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(width) || width < 1) throw new Error('Invalid sample bounds');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('DSS data response has no readable stream');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const rows: string[][] = [];
  let row: string[] = [], cell = '', state: 'plain' | 'quoted' | 'closed' = 'plain';
  let bytes = 0, skipLF = false, touched = false, eof = false;
  const commitRow = () => {
    row.push(cell);
    if (row.length !== width) throw new Error('DSS data row width does not match dataset schema');
    rows.push(row); row = []; cell = ''; touched = false;
  };
  const consume = (text: string) => {
    for (const ch of text) {
      if (skipLF) { skipLF = false; if (ch === '\n') continue; }
      if (state === 'quoted') {
        if (ch === '"') state = 'closed'; else cell += ch;
        continue;
      }
      if (state === 'closed' && ch === '"') { cell += '"'; state = 'quoted'; continue; }
      if (ch === '\t') { row.push(cell); cell = ''; state = 'plain'; touched = true; }
      else if (ch === '\n' || ch === '\r') { commitRow(); state = 'plain'; skipLF = ch === '\r'; }
      else if (state === 'closed') throw new Error('Malformed quoted DSS data');
      else if (ch === '"' && cell === '') { state = 'quoted'; touched = true; }
      else { cell += ch; touched = true; }
      if (rows.length === limit) return;
    }
  };
  try {
    while (rows.length < limit) {
      const { value, done } = await reader.read();
      if (done) { eof = true; consume(decoder.decode()); break; }
      bytes += value.byteLength;
      if (bytes > SAMPLE_BYTE_LIMIT) throw new Error('DSS sample exceeds 1 MiB byte limit; request fewer rows/columns');
      consume(decoder.decode(value, { stream: true }));
    }
    if (eof) {
      if ((state as string) === 'quoted') throw new Error('Truncated quoted DSS data');
      if (touched || row.length || cell.length) commitRow();
    }
    return { rows, row_count: rows.length, limit_reached: rows.length === limit, complete: eof, bytes_read: bytes };
  } catch (error) {
    if (error instanceof TypeError) throw new Error('DSS data stream is unreadable or invalid UTF-8');
    throw error;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
