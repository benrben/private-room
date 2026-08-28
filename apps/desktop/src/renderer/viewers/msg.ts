import MsgReader, { type FieldsData } from "@kenjiuno/msgreader";
import type { ParsedEmail } from "./eml";

function address(field: FieldsData): string {
  const name = field.name?.trim() ?? "";
  const email = field.email?.trim() ?? "";
  if (name && email && name.toLocaleLowerCase() !== email.toLocaleLowerCase()) {
    return `${name} <${email}>`;
  }
  return name || email;
}

function recipients(fields: FieldsData, kind: "to" | "cc"): string {
  return (fields.recipients ?? [])
    .filter((recipient) => recipient.recipType === kind)
    .map(address)
    .filter(Boolean)
    .join(", ");
}

/** Convert the library's broad MAPI result into the same small, safe model
 * used by the existing EML viewer. Keeping this adapter pure makes malformed
 * or partially populated Outlook messages straightforward to test. */
export function msgFieldsToEmail(fields: FieldsData): ParsedEmail {
  const senderName = fields.senderName?.trim() ?? "";
  const senderEmail = fields.senderEmail?.trim() ?? "";
  const from = senderName && senderEmail && senderName.toLocaleLowerCase() !== senderEmail.toLocaleLowerCase()
    ? `${senderName} <${senderEmail}>`
    : senderName || senderEmail;
  return {
    subject: fields.subject?.trim() ?? "",
    from,
    to: recipients(fields, "to"),
    cc: recipients(fields, "cc"),
    date: fields.messageDeliveryTime ?? fields.clientSubmitTime ?? fields.creationTime ?? "",
    body: fields.body ?? fields.preview ?? "",
    attachments: (fields.attachments ?? []).map((attachment) => ({
      name: attachment.fileName ?? attachment.fileNameShort ?? attachment.name ?? "(unnamed attachment)",
      sizeHint: typeof attachment.contentLength === "number"
        ? `${Math.ceil(attachment.contentLength / 1024).toLocaleString()} KB`
        : "",
    })),
  };
}

export function parseMsg(bytes: Uint8Array): ParsedEmail {
  const owned = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const fields = new MsgReader(owned).getFileData();
  if (fields.error) throw new Error(fields.error);
  return msgFieldsToEmail(fields);
}
