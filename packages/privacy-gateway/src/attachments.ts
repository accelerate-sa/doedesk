import type { Reader } from "./reader.ts";

export const WITHHELD_IMAGE_NOTE =
  "[Image withheld by DoeDesk: it could not be checked for personal data before sending.]";
export const WITHHELD_FILE_NOTE =
  "[File withheld by DoeDesk: it could not be checked for personal data before sending.]";
/** Sent in an image's place when the user chose that no image is sent at all. */
export const IMAGES_OFF_NOTE =
  "[Image withheld by DoeDesk: sending images is turned off in Settings, under Privacy.]";

/** How an image in a request is treated. Chosen in Settings, under Privacy. */
export type ImageHandling =
  /** The image itself, with a labelled black box over each value. Falls back to `text`. */
  | "redacted"
  /** The text read from the image, masked. No pixel is sent. */
  | "text"
  /** A note that the image was withheld. Nothing is read. */
  | "withheld";

/** Said before the text of an image that could not be sent redacted. `reason` never quotes the image. */
export const redactionFailedNote = (reason: string): string =>
  `[DoeDesk did not send this image: ${reason.replace(/[.\s]+$/, "")}. What follows is the text read from it instead.]`;

export interface AttachmentText {
  /** The text that takes the attachment's place. When `read` is true it still has to be masked. */
  readonly text: string;
  readonly read: boolean;
}

/**
 * The text that replaces an image or a file, the same for every front end: what the reading
 * service found in it, or a note that it was withheld.
 */
export const attachmentText = async (
  kind: "image" | "file",
  reader: Reader | undefined,
  attachment: { readonly bytes: Buffer; readonly mediaType: string } | undefined,
): Promise<AttachmentText> => {
  const note = kind === "image" ? WITHHELD_IMAGE_NOTE : WITHHELD_FILE_NOTE;
  if (reader === undefined || attachment === undefined) return { text: note, read: false };
  let text: string;
  try {
    text = await reader.read(attachment.bytes, attachment.mediaType);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "it could not be read";
    return { text: `${note.slice(0, -1)} (${reason})]`, read: false };
  }
  return readAttachmentText(kind, text);
};

/** The block of text that stands for an attachment once it has been read. Still to be masked. */
export const readAttachmentText = (kind: "image" | "file", text: string): AttachmentText => {
  const label = kind === "image" ? "image" : "file";
  return {
    text:
      text.trim().length === 0
        ? `[DoeDesk found no text in this ${label}.]`
        : `[Text read from an attached ${label} by DoeDesk. The ${label} itself was not sent.]\n${text}`,
    read: true,
  };
};
