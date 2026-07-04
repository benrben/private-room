export function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export const BOX_COLORS = ["#8b7cf6", "#4cc38a", "#e3b341", "#e5646c", "#5ab8d4"];
