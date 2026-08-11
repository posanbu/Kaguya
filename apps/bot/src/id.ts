export function createTraceScopedIdFactory(
  traceId: string,
): (prefix: string) => string {
  let sequence = 0;
  return (prefix: string) =>
    `${traceId}-${prefix}-${String(++sequence).padStart(6, "0")}`;
}
