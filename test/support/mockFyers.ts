import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { appIdHash } from "../../src/broker/fyersAuth.js";
import { totp } from "../../src/broker/totp.js";
import { DAY_MS, IST_OFFSET_MS, MINUTE_MS, isWeekday, parseIsoDay } from "../../src/time.js";

// A small stand-in for Fyers' login and history endpoints, so the broker client
// is tested end to end without ever touching the real API. Credentials here are
// deliberately fake.

export const FAKE_SECRETS = {
  FYERS_CLIENT_ID: "TESTAPP123-100",
  FYERS_SECRET_KEY: "fake-secret-key-0000",
  FYERS_FY_ID: "ZZ00000",
  FYERS_PIN: "9876",
  FYERS_TOTP_SECRET: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
};

export const ACCESS_TOKEN = "mock-access-token-abcdef0123456789";

export interface MockFyers {
  url: string;
  env: Record<string, string>;
  /** Every /data/history query, in order. */
  history: Array<{ symbol: string; resolution: string; from: string; to: string; status: number }>;
  logins: number;
  /** Answer the next N history calls with this status (0: answer normally). */
  failNext: (status: number, count?: number) => void;
  /** Close price for a bar (default: 100 + days since 2020 / 10). */
  price: (symbol: string, t: number) => number;
  /** History requests starting before this day key answer 422 (the plan's window). */
  windowStart: number | null;
  /** When set, bars starting at or after this time aren't returned (the broker doesn't know the future). */
  until: (() => number) | null;
  wrongPin: boolean;
  close: () => Promise<void>;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const json = (res: ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
};

export async function startMockFyers(): Promise<MockFyers> {
  const failures: number[] = [];
  const mock: MockFyers = {
    url: "",
    env: {},
    history: [],
    logins: 0,
    failNext: (status, count = 1) => failures.push(...Array.from({ length: count }, () => status)),
    price: (_symbol, t) => 100 + Math.round((t - Date.UTC(2020, 0, 1)) / DAY_MS) / 10,
    windowStart: null,
    until: null,
    wrongPin: false,
    close: async () => {},
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://mock");
      const path = url.pathname;
      if (req.method === "POST" && path === "/vagator/v2/send_login_otp") {
        const b = await body(req);
        return b.fy_id === FAKE_SECRETS.FYERS_FY_ID ? json(res, 200, { s: "ok", request_key: "rk-1" }) : json(res, 400, { s: "error", message: "bad id" });
      }
      if (req.method === "POST" && path === "/vagator/v2/verify_otp") {
        const b = await body(req);
        const now = Date.now();
        const valid = [-1, 0, 1].some((skew) => totp(FAKE_SECRETS.FYERS_TOTP_SECRET, now, skew) === b.otp);
        return b.request_key === "rk-1" && valid ? json(res, 200, { s: "ok", request_key: "rk-2" }) : json(res, 400, { s: "error", message: "invalid otp" });
      }
      if (req.method === "POST" && path === "/vagator/v2/verify_pin") {
        const b = await body(req);
        if (mock.wrongPin || b.identifier !== FAKE_SECRETS.FYERS_PIN) return json(res, 400, { s: "error", message: `Invalid PIN ${String(b.identifier)}` });
        return json(res, 200, { s: "ok", data: { access_token: "login-token" } });
      }
      if (req.method === "POST" && path === "/api/v3/token") {
        if (req.headers.authorization !== "Bearer login-token") return json(res, 401, { s: "error" });
        return json(res, 308, { s: "ok", Url: "http://localhost:3000/api/broker/callback?auth_code=AUTH-CODE-1&state=hub" });
      }
      if (req.method === "POST" && path === "/api/v3/validate-authcode") {
        const b = await body(req);
        if (b.code !== "AUTH-CODE-1" || b.appIdHash !== appIdHash(FAKE_SECRETS.FYERS_CLIENT_ID, FAKE_SECRETS.FYERS_SECRET_KEY)) return json(res, 400, { s: "error" });
        mock.logins += 1;
        return json(res, 200, { s: "ok", access_token: ACCESS_TOKEN });
      }
      if (req.method === "GET" && path === "/data/history") {
        const q = url.searchParams;
        const entry = { symbol: q.get("symbol") ?? "", resolution: q.get("resolution") ?? "", from: q.get("range_from") ?? "", to: q.get("range_to") ?? "", status: 200 };
        mock.history.push(entry);
        const reply = (status: number, payload: unknown) => {
          entry.status = status;
          json(res, status, payload);
        };
        if (req.headers.authorization !== `${FAKE_SECRETS.FYERS_CLIENT_ID}:${ACCESS_TOKEN}`) return reply(401, { s: "error", code: -16, message: "invalid token" });
        const forced = failures.shift();
        // (0 queued = answer this one normally)
        if (forced) return reply(forced, { s: "error", code: forced === 422 ? -50 : -1, message: `forced ${forced}` });
        const from = parseIsoDay(entry.from);
        const to = parseIsoDay(entry.to);
        if (from === null || to === null || from > to) return reply(400, { s: "error", message: "bad range" });
        const daily = entry.resolution === "D";
        // The real API's limits: daily spans ≤ 366 days; intraday kept ≤ 91 dates by the client.
        if ((to - from) / DAY_MS > (daily ? 366 : 91)) return reply(422, { s: "error", code: -50, message: "Date range cannot exceed 366 days" });
        if (mock.windowStart !== null && from < mock.windowStart) return reply(422, { s: "error", code: -50, message: "beyond plan" });
        if (entry.symbol === "NSE:NOSUCH-EQ") return reply(200, { s: "error", code: -300, message: "Invalid symbol provided" });
        const step = daily ? DAY_MS : Number(entry.resolution) * MINUTE_MS;
        const candles: number[][] = [];
        for (let day = from; day <= to; day += DAY_MS) {
          if (!isWeekday(day)) continue;
          const start = day - IST_OFFSET_MS; // IST midnight
          const times = daily ? [start] : Array.from({ length: Math.floor((375 * MINUTE_MS) / step) }, (_, i) => start + 555 * MINUTE_MS + i * step);
          for (const t of times) {
            if (mock.until && t >= mock.until()) continue;
            const key = daily ? day : t;
            const c = mock.price(entry.symbol, key);
            candles.push([t / 1000, c - 1, c + 2, c - 2, c, 1000]);
          }
        }
        return reply(200, candles.length ? { s: "ok", candles } : { s: "no_data", candles: [] });
      }
      json(res, 404, { s: "error", message: "not found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  mock.url = `http://127.0.0.1:${port}`;
  mock.env = { ...FAKE_SECRETS, FYERS_API_URL: `${mock.url}/api/v3`, FYERS_DATA_URL: `${mock.url}/data` };
  mock.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return mock;
}
