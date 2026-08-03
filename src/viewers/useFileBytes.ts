import { useEffect, useState } from "react";
import { base64ToBytes } from "./util";

/** The URL a streamed room file is served from.
 *
 * `roommedia://` is the app's own URI scheme, handled in-process by Rust and
 * answered from the in-memory staged-bytes map (decrypted, capped, cleared when
 * the room locks). It speaks HTTP Range, which is why `<video>` could seek
 * through it — and why every other viewer now reads through it too. */
export function fileUrl(token: string | null | undefined): string | null {
  return token ? `roommedia://localhost/${token}` : null;
}

export interface FileBytes {
  bytes: Uint8Array | null;
  /** Empty string while fine — a human-readable reason when the read failed. */
  error: string;
  loading: boolean;
}

/** Read a streamed room file's whole bytes.
 *
 * Replaces the base64 `dataB64` payload the viewers used to receive over IPC.
 * That payload was 4/3 the size of the file, had to be built in Rust, copied
 * across the IPC boundary and parsed by JS before anything could render, which
 * is why a 50 MB ceiling sat on it — and why a file one byte over that ceiling
 * silently lost its real viewer and opened as a plain `<pre>`.
 *
 * `dataB64` is still honoured when present so a viewer keeps working if byte
 * delivery is ever switched back; nothing in the app populates it today.
 */
export function useFileBytes(
  token: string | null | undefined,
  dataB64?: string | null,
): FileBytes {
  const [state, setState] = useState<FileBytes>({
    bytes: null,
    error: "",
    loading: !!(token || dataB64),
  });

  useEffect(() => {
    let alive = true;
    if (dataB64) {
      try {
        setState({ bytes: base64ToBytes(dataB64), error: "", loading: false });
      } catch {
        setState({ bytes: null, error: "This file could not be decoded.", loading: false });
      }
      return;
    }
    const url = fileUrl(token);
    if (!url) {
      setState({ bytes: null, error: "", loading: false });
      return;
    }
    setState({ bytes: null, error: "", loading: true });
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`the room returned ${res.status}`);
        const buf = await res.arrayBuffer();
        if (!alive) return;
        setState({ bytes: new Uint8Array(buf), error: "", loading: false });
      } catch (e) {
        if (!alive) return;
        // A staged token is dropped when the room locks or when enough other
        // files have been opened to evict it, so this is a real, reachable
        // state — say so instead of rendering an empty viewer.
        setState({
          bytes: null,
          error: `This file could not be read (${String(e)}). Close and reopen it to try again.`,
          loading: false,
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, dataB64]);

  return state;
}

/** Decode a streamed file as UTF-8 text (notebooks, mail, subtitles read this
 * way when they arrive as bytes rather than as the `text` field). */
export function bytesToText(bytes: Uint8Array | null): string {
  if (!bytes) return "";
  return new TextDecoder("utf-8").decode(bytes);
}
