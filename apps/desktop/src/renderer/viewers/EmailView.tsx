import { useEffect, useMemo, useState } from "react";
import { parseEml, ParsedEmail } from "./eml";
import { parseMsg } from "./msg";
import { useFileBytes } from "./useFileBytes";
import "./email.css";

/**
 * A saved message (`.eml`), rendered as mail rather than as its wire format.
 *
 * The file used to have no viewer: it landed on the plain-text card showing
 * MIME headers, boundary markers and base64 blobs. The parse is deliberately
 * the same shape as the Rust reader that feeds search (`extraction/data.rs`),
 * so what the screen shows and what the model reads agree.
 */
export default function EmailView({
  text,
  name,
  mediaToken,
  dataB64,
}: {
  text: string;
  name?: string;
  mediaToken?: string | null;
  dataB64?: string | null;
}) {
  const isMsg = name?.toLocaleLowerCase().endsWith(".msg") ?? false;
  const { bytes, error: readError, loading } = useFileBytes(
    isMsg ? mediaToken : null,
    isMsg ? dataB64 : null,
  );
  const eml = useMemo(() => parseEml(text), [text]);
  const [msg, setMsg] = useState<ParsedEmail | null>(null);
  const [msgError, setMsgError] = useState("");

  useEffect(() => {
    if (!isMsg || !bytes) return;
    try {
      setMsg(parseMsg(bytes));
      setMsgError("");
    } catch (error) {
      setMsg(null);
      setMsgError(`This Outlook message could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [bytes, isMsg]);

  if (isMsg && loading) return <div className="empty-hint">Opening message…</div>;
  if (isMsg && readError) return <div className="empty-hint">{readError}</div>;
  if (isMsg && msgError) return <div className="empty-hint">{msgError}</div>;
  if (isMsg && !msg) return <div className="empty-hint">Reading Outlook message…</div>;
  const mail = isMsg ? msg! : eml;

  return (
    <div className="eml-view">
      <header className="eml-head">
        {/* `dir="auto"` for the same reason the fields and the body already
            carry it: a Hebrew or Arabic subject line was the one part of the
            message still being forced left-to-right. */}
        <h1 className="eml-subject" dir="auto">
          {mail.subject || "(no subject)"}
        </h1>
        <dl className="eml-fields">
          {(
            [
              ["From", mail.from],
              ["To", mail.to],
              ["Cc", mail.cc],
              ["Date", mail.date],
            ] as const
          )
            .filter(([, v]) => !!v)
            .map(([label, v]) => (
              <div key={label} className="eml-field">
                <dt>{label}</dt>
                <dd dir="auto">{v}</dd>
              </div>
            ))}
        </dl>
        {mail.attachments.length > 0 && (
          <ul className="eml-attachments">
            {mail.attachments.map((a, i) => (
              <li key={i}>
                📎 {a.name}
                {a.sizeHint ? ` · ${a.sizeHint}` : ""}
              </li>
            ))}
          </ul>
        )}
      </header>
      {mail.body.trim() ? (
        <pre className="eml-body" dir="auto">
          {mail.body}
        </pre>
      ) : (
        <div className="empty-hint">This message has no readable text body.</div>
      )}
    </div>
  );
}
