/** A TCP port as an integer 1-65535 (numbers or digit strings), else the fallback: the value ends up inside URLs. */
export function normalizePort(value, fallback = 8890) {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,5}$/.test(value.trim()) ? Number(value.trim()) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback
}
