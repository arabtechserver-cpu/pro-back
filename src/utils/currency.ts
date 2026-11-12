export function roundCurrency(value: unknown, decimals = 2): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** decimals;
  const adjusted = num + Math.sign(num) * 1e-11;
  const rounded = Math.round(adjusted * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}
