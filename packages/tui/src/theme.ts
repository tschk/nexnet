export const theme = {
  bg: "#0a0a0a",
  surface: "#141414",
  surfaceLight: "#1e1e1e",
  border: "#2a2a2a",
  borderFocused: "#4a9eff",

  text: "#e0e0e0",
  textDim: "#888888",
  textBright: "#ffffff",

  accent: "#4a9eff",
  accentDim: "#2a6ebb",

  success: "#4ade80",
  warning: "#fbbf24",
  error: "#f87171",

  online: "#4ade80",
  offline: "#555555",

  messageOwn: "#1a3a5c",
  messageOther: "#1e1e1e",

  inputBg: "#1a1a1a",
  inputFocused: "#222222",

  headerBg: "#0f0f0f",
  statusBg: "#0a0a0a",
} as const;

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function hexToShort(hex: string): string {
  return hex.slice(0, 8) + "…";
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}
