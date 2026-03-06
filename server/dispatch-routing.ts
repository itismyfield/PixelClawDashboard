/**
 * Dispatch type → default agent routing.
 * Used when handoff file has no explicit `to` field.
 */
export const DISPATCH_ROUTING: Record<string, string> = {
  test_request: "QAD",
  implementation_request: "TD",
  review_request: "QAD",
  // generic → no default; will escalate to CEO
};

export function resolveAgent(
  dispatchType: string,
  fromAgent: string,
): string | null {
  return DISPATCH_ROUTING[dispatchType] ?? null;
}
