import { useEffect, useMemo, useState } from "react";
import { parseEml, type ParsedEmail } from "./eml";
import { parseMsg } from "./msg";
import { useFileBytes } from "./useFileBytes";
import "./email.css";

type EmailViewProps = {
  text: string;
  name?: string;
  mediaToken?: string | null;
  dataB64?: string | null;
};

type OutlookMailState = {
  loading: boolean;
  message: ParsedEmail | null;
  messageError: string;
  readError: string;
};

const FIELD_LABELS = [
  ["From", "from"],
  ["To", "to"],
  ["Cc", "cc"],
  ["Date", "date"],
] as const;

function isOutlookMessage(name?: string): boolean {
  return name?.toLocaleLowerCase().endsWith(".msg") ?? false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useOutlookMail(
  isOutlook: boolean,
  mediaToken?: string | null,
  dataB64?: string | null,
): OutlookMailState {
  const {
    bytes,
    error: readError,
    loading,
  } = useFileBytes(isOutlook ? mediaToken : null, isOutlook ? dataB64 : null);
  const [message, setMessage] = useState<ParsedEmail | null>(null);
  const [messageError, setMessageError] = useState("");

  useEffect(() => {
    if (!isOutlook || !bytes) return;
    try {
      setMessage(parseMsg(bytes));
      setMessageError("");
    } catch (error) {
      setMessage(null);
      setMessageError(
        `This Outlook message could not be read: ${errorMessage(error)}`,
      );
    }
  }, [bytes, isOutlook]);

  return { loading, message, messageError, readError };
}

function outlookHint(
  isOutlook: boolean,
  state: OutlookMailState,
): string | null {
  if (!isOutlook) return null;
  if (state.loading) return "Opening message…";
  if (state.readError) return state.readError;
  if (state.messageError) return state.messageError;
  if (!state.message) return "Reading Outlook message…";
  return null;
}

function MailFields({ mail }: { mail: ParsedEmail }) {
  const fields = FIELD_LABELS.filter(([, key]) => !!mail[key]);
  if (!fields.length) return null;

  return (
    <dl className="eml-fields">
      {fields.map(([label, key]) => (
        <div key={label} className="eml-field">
          <dt>{label}</dt>
          <dd dir="auto">{mail[key]}</dd>
        </div>
      ))}
    </dl>
  );
}

function MailAttachments({ attachments }: Pick<ParsedEmail, "attachments">) {
  if (!attachments.length) return null;

  return (
    <ul className="eml-attachments">
      {attachments.map((attachment, index) => (
        <li key={index}>
          📎 {attachment.name}
          {attachment.sizeHint ? ` · ${attachment.sizeHint}` : ""}
        </li>
      ))}
    </ul>
  );
}

function MailBody({ body }: Pick<ParsedEmail, "body">) {
  if (!body.trim()) {
    return (
      <div className="empty-hint">This message has no readable text body.</div>
    );
  }

  return (
    <pre className="eml-body" dir="auto">
      {body}
    </pre>
  );
}

function MailContent({ mail }: { mail: ParsedEmail }) {
  return (
    <div className="eml-view">
      <header className="eml-head">
        {/* `dir="auto"` for the same reason the fields and the body already
            carry it: a Hebrew or Arabic subject line was the one part of the
            message still being forced left-to-right. */}
        <h1 className="eml-subject" dir="auto">
          {mail.subject || "(no subject)"}
        </h1>
        <MailFields mail={mail} />
        <MailAttachments attachments={mail.attachments} />
      </header>
      <MailBody body={mail.body} />
    </div>
  );
}

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
}: EmailViewProps) {
  const isOutlook = isOutlookMessage(name);
  const outlook = useOutlookMail(isOutlook, mediaToken, dataB64);
  const eml = useMemo(() => parseEml(text), [text]);
  const hint = outlookHint(isOutlook, outlook);

  if (hint) return <div className="empty-hint">{hint}</div>;
  return <MailContent mail={isOutlook ? outlook.message! : eml} />;
}
