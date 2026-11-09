// Reading Server-Sent Events from a fetch Response body, one read() at a time,
// so a test controls exactly when the "client" reads (and can show backpressure).

export interface SseEvent {
  event: string;
  id?: string;
  data?: unknown;
  comment?: string;
  retry?: number;
}

/** Reads SSE frames from a stream body. */
export class SseReader {
  private buffer = "";
  private decoder = new TextDecoder();
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}
  static of(res: Response) {
    return new SseReader(res.body!.getReader());
  }
  /** One read() of the body, parsed into its events. */
  async chunk(timeoutMs = 1000): Promise<SseEvent[]> {
    const read = this.reader.read();
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no data from stream")), timeoutMs));
    const { value, done } = await Promise.race([read, timeout]);
    if (done) return [];
    this.buffer += this.decoder.decode(value, { stream: true });
    const frames = this.buffer.split("\n\n");
    this.buffer = frames.pop()!;
    return frames.map(parseFrame);
  }
  async until(count: number): Promise<SseEvent[]> {
    const events: SseEvent[] = [];
    while (events.length < count) events.push(...(await this.chunk()));
    return events;
  }
  cancel() {
    return this.reader.cancel();
  }
}

export function parseFrame(frame: string): SseEvent {
  const event: SseEvent = { event: "message" };
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) event.comment = line.slice(1).trim();
    else if (line.startsWith("event: ")) event.event = line.slice(7);
    else if (line.startsWith("id: ")) event.id = line.slice(4);
    else if (line.startsWith("retry: ")) event.retry = Number(line.slice(7));
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  if (data.length) event.data = JSON.parse(data.join("\n"));
  if (event.comment !== undefined && !data.length) event.event = "comment";
  return event;
}
