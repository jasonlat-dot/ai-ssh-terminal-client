import type { OutputRange, OutputReference } from '../api/agent';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);

export function outputReferences(value: unknown): OutputReference[] {
  if (!record(value) || !Array.isArray(value.outputs)) return [];
  return value.outputs.filter((ref): ref is OutputReference => record(ref) && typeof ref.id === 'string'
    && (ref.channel === 'stdout' || ref.channel === 'stderr') && typeof ref.size === 'number' && Number.isSafeInteger(ref.size) && ref.size >= 0 && typeof ref.sha256 === 'string');
}

export function joinOutput(parts: string[]): string {
  return parts.filter(Boolean).reduce((text, part) => text && !text.endsWith('\n') && !part.startsWith('\n') ? `${text}\n${part}` : text + part, '');
}

export function parseToolOutput(output: string) {
  let envelope: RecordValue | null = null;
  try { const value: unknown = JSON.parse(output); if (record(value) && typeof value.ok === 'boolean') envelope = value; } catch { /* Plain tool text. */ }
  const data = envelope && record(envelope.data) ? envelope.data : null;
  const references = outputReferences(data);
  let text = output;
  if (data) {
    if (typeof data.stdout === 'string' || typeof data.stderr === 'string') {
      text = joinOutput([typeof data.stdout === 'string' ? data.stdout : '', typeof data.stderr === 'string' ? data.stderr : '']);
    } else {
      const content = typeof data.content === 'string' ? data.content : Array.isArray(data.content)
        ? data.content.filter(record).filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : undefined;
      text = [data.text, data.report, data.preview, content].find((value): value is string => typeof value === 'string') ?? (references.length ? '' : JSON.stringify(data, null, 2));
    }
  } else if (envelope) {
    text = typeof envelope.error === 'string' ? envelope.error : output;
  }
  return { envelope, data, references, text };
}

/** Read immutable stored evidence; never re-run a tool or request it from the model. */
export async function readCompleteToolOutput(
  parsed: ReturnType<typeof parseToolOutput>,
  read: (reference: OutputReference, offset: number, limit: number, signal: AbortSignal) => Promise<OutputRange>,
  signal: AbortSignal,
) {
  const channels = new Map<string, string[]>();
  let lossy = false;
  for (const reference of parsed.references) {
    if (signal.aborted) throw new Error('输出读取已取消');
    if (reference.size > 16 * 1024 * 1024) throw new Error('原始输出超过保存上限，无法完整读取。');
    const bytes = new Uint8Array(reference.size);
    let offset = 0;
    while (offset < reference.size) {
      if (signal.aborted) throw new Error('输出读取已取消');
      const limit = Math.min(65536, reference.size - offset);
      const range = await read(reference, offset, limit, signal);
      if (signal.aborted) throw new Error('输出读取已取消');
      if (range.offset !== offset || range.size !== reference.size || range.channel !== reference.channel
        || !Number.isSafeInteger(range.nextOffset) || range.nextOffset <= offset || range.nextOffset > offset + limit
        || !Array.isArray(range.bytes) || range.bytes.length !== range.nextOffset - offset
        || range.bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)
        || range.eof !== (range.nextOffset === reference.size)) throw new Error('原始输出读取不完整，请重试。');
      bytes.set(range.bytes, offset);
      offset = range.nextOffset;
    }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { lossy = true; text = new TextDecoder().decode(bytes); }
    const parts = channels.get(reference.channel) ?? [];
    parts.push(text); channels.set(reference.channel, parts);
  }
  const text = parsed.references.length ? joinOutput(['stdout', 'stderr'].map(channel => channels.has(channel)
    ? channels.get(channel)!.join('') : typeof parsed.data?.[channel] === 'string' ? parsed.data[channel] as string : '')) : parsed.text;
  return { text, lossy };
}
