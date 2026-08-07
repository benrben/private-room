import { useMemo } from "react";
import { parseEml, ParsedEmail } from "./eml";
import "./email.css";

/**
 * A saved message (`.eml`), rendered as mail rather than as its wire format.
 *
 * The file used to have no viewer: it landed on the plain-text card showing
 * MIME headers, boundary markers and base64 blobs. The parse is deliberately
 * the same shape as the Rust reader that feeds search (`extraction/data.rs`),
 * so what the screen shows and what the model reads agree.
 */
export default function EmailView({ text }: { text: string }) {
  const mail: ParsedEmail = useMemo(() => parseEml(text), [text]);

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
