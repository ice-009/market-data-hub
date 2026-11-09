import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ACCESS_TOKEN, FAKE_SECRETS } from "./mockFyers.js";

// A stand-in for Fyers' /data/quotes endpoint (the login stays on mockFyers.ts):
// point FYERS_DATA_URL at `${url}/data`. Answers every symbol with a made-up
// quote; NSE:NOSUCH-EQ gets a per-symbol error, as the real API does.

export interface MockQuotes {
  url: string;
  /** Symbols of each /data/quotes call, in order. */
  calls: string[][];
  /** Answer the next N calls with this status. */
  failNext: (status: number, count?: number) => void;
  close: () => Promise<void>;
}

/** Price the mock quotes for a Fyers symbol. */
export const mockPrice = (fyersSymbol: string) => 100 + (fyersSymbol.length % 7);

export async function startMockQuotes(): Promise<MockQuotes> {
  const failures: number[] = [];
  const mock: MockQuotes = {
    url: "",
    calls: [],
    failNext: (status, count = 1) => failures.push(...Array.from({ length: count }, () => status)),
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== "GET" || url.pathname !== "/data/quotes") return reply(404, { s: "error", message: "not found" });
    const symbols = (url.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
    mock.calls.push(symbols);
    if (req.headers.authorization !== `${FAKE_SECRETS.FYERS_CLIENT_ID}:${ACCESS_TOKEN}`) return reply(401, { s: "error", code: -16, message: "invalid token" });
    const forced = failures.shift();
    if (forced) return reply(forced, { s: "error", code: -429, message: `forced ${forced}` });
    const d = symbols.map((n) =>
      n === "NSE:NOSUCH-EQ"
        ? { n, s: "error", v: { errmsg: "invalid symbol" } }
        : {
            n,
            s: "ok",
            v: {
              ch: 1.5,
              chp: 1.2,
              lp: mockPrice(n),
              open_price: 99,
              high_price: 110,
              low_price: 98,
              prev_close_price: 98.5,
              volume: 12_345,
              tt: "1762646400",
              cmd: { t: 1_762_662_000, o: 100, h: 101, l: 99, c: 100.5, v: 50 },
            },
          },
    );
    reply(200, { s: "ok", code: 200, d });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return mock;
}
