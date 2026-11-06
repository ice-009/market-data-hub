// Why a broker request didn't produce data. The HTTP layer turns these into
// 503 (with whatever is stored) or, for a symbol the broker doesn't know, 404.
// Messages are written by the hub and never contain credentials.

export type BrokerErrorKind =
  | "not_configured" // no credentials in the environment
  | "not_owner" // another hub process owns the broker connection
  | "auth" // login failed or the token was rejected
  | "budget" // today's budget is spent, or calls are stopped after strikes
  | "rate_limited" // the broker answered 429 (a strike was counted)
  | "bad_symbol" // the broker doesn't know the symbol
  | "upstream" // the broker answered with an error
  | "network"; // couldn't reach the broker

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly kind: BrokerErrorKind,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}
