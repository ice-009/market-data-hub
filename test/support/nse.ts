import { deflateRawSync } from "node:zlib";

// Fakes for NSE tests: a hand-built zip, a clock whose sleeps advance time
// instantly, and a fetch that answers from a table of URLs (404 otherwise).

/** A one-file zip, built by hand, to test the reader's edges (from Tradex's tests). */
export function makeZip(name: string, data: Buffer, method: 0 | 8 = 8, files = 1): Buffer {
  const body = method === 8 ? deflateRawSync(data) : data;
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files, 8);
  end.writeUInt16LE(files, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(local.length + nameBytes.length + body.length, 16);
  return Buffer.concat([local, nameBytes, body, central, nameBytes, end]);
}

/** A fake clock + sleep: sleeping advances time instantly and is recorded. */
export function fakeTime(start: number) {
  const state = { now: start, sleeps: [] as number[] };
  return {
    state,
    clock: () => state.now,
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      state.now += ms;
    },
  };
}

export type Route = Response | (() => Response);
export function fakeFetch(routes: Record<string, Route | Route[]>, log: Array<{ url: string; at: number; headers: Record<string, string> }>, clock: () => number): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    log.push({ url, at: clock(), headers: (init?.headers ?? {}) as Record<string, string> });
    let route = routes[url];
    if (Array.isArray(route)) route = route.length > 1 ? route.shift()! : route[0];
    if (!route) return new Response("not found", { status: 404 });
    return typeof route === "function" ? route() : route.clone();
  }) as typeof fetch;
}
