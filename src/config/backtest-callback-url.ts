/** Public ingress URL for backtest completion webhooks (no trailing slash). */
export function buildBacktestCallbackUrl(
  publicUrl: string | undefined,
  token: string | undefined,
): string | undefined {
  if (!publicUrl || !token) return undefined;
  const base = publicUrl.replace(/\/$/, '');
  // Backtester posts JSON only (no Authorization header). Query token is validated by callbackBearerAuth.
  return `${base}/callbacks/backtest-completed?token=${encodeURIComponent(token)}`;
}
