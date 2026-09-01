import MsgReader, { type FieldsData } from "@kenjiuno/msgreader";
import type { ParsedEmail } from "./eml";

function trimmed(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function displayAddress(nameValue?: string, emailValue?: string): string {
  const name = trimmed(nameValue);
  const email = trimmed(emailValue);
  if (!name) return email;
  if (!email) return name;
  return name.toLocaleLowerCase() === email.toLocaleLowerCase()
    ? name
    : `${name} <${email}>`;
}

function recipients(fields: FieldsData, kind: "to" | "cc"): string {
  return (fields.recipients ?? [])
    .filter((recipient) => recipient.recipType === kind)
    .map((recipient) => displayAddress(recipient.name, recipient.email))
    .filter(Boolean)
    .join(", ");
}

function messageDate(fields: FieldsData): string {
  return (
    fields.messageDeliveryTime ??
    fields.clientSubmitTime ??
    fields.creationTime ??
    ""
  );
}

function messageBody(fields: FieldsData): string {
  return fields.body ?? fields.preview ?? "";
}

function attachmentName(attachment: FieldsData): string {
  if (attachment.fileName != null) return attachment.fileName;
  if (attachment.fileNameShort != null) return attachment.fileNameShort;
  if (attachment.name != null) return attachment.name;
  return "(unnamed attachment)";
}

function attachmentSizeHint(attachment: FieldsData): string {
  if (typeof attachment.contentLength !== "number") return "";
  return `${Math.ceil(attachment.contentLength / 1024).toLocaleString()} KB`;
}

function attachmentsOf(fields: FieldsData): ParsedEmail["attachments"] {
  return (fields.attachments ?? []).map((attachment) => ({
    name: attachmentName(attachment),
    sizeHint: attachmentSizeHint(attachment),
  }));
}

/** Convert the library's broad MAPI result into the same small, safe model
 * used by the existing EML viewer. Keeping this adapter pure makes malformed
 * or partially populated Outlook messages straightforward to test. */
export function msgFieldsToEmail(fields: FieldsData): ParsedEmail {
  return {
    subject: fields.subject?.trim() ?? "",
    from: displayAddress(fields.senderName, fields.senderEmail),
    to: recipients(fields, "to"),
    cc: recipients(fields, "cc"),
    date: messageDate(fields),
    body: messageBody(fields),
    attachments: attachmentsOf(fields),
  };
}

export function parseMsg(bytes: Uint8Array): ParsedEmail {
  const owned = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const fields = new MsgReader(owned).getFileData();
  if (fields.error) throw new Error(fields.error);
  return msgFieldsToEmail(fields);
}
