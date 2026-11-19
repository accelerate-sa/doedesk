import type { PrivacyImageHandling, PrivacyRedaction, PrivacyStatus } from "@t3tools/contracts";

/** The three ways an image can be sent, in the order they are offered. */
export const IMAGE_HANDLING_CHOICES: ReadonlyArray<{
  readonly value: PrivacyImageHandling;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "redacted",
    label: "Redacted image",
    description:
      "The AI sees the image with a black box over each personal detail, labelled with its stand-in. An image that cannot be redacted safely is sent as masked text instead.",
  },
  {
    value: "text",
    label: "Masked text only",
    description:
      "The AI sees only the text read from the image, with personal details replaced by stand-ins. No part of the picture is sent.",
  },
  {
    value: "withheld",
    label: "Do not send",
    description: "The AI is told an image was withheld. Nothing in it is read or sent.",
  },
];

/** How images are sent now. A server from before this setting sends masked text. */
export const imageHandlingOf = (status: PrivacyStatus): PrivacyImageHandling =>
  status.imageHandling ?? "text";

/** One line saying what a record holds. */
export const describeRedaction = (record: PrivacyRedaction): string => {
  const what = record.kind === "image" ? "Image" : "Document";
  if (record.outcome === "redacted") {
    const boxes = record.valueBoxes + record.unreadableBoxes;
    return `${what} sent redacted, ${boxes} ${boxes === 1 ? "box" : "boxes"}`;
  }
  return record.outcome === "text" ? `${what} sent as masked text` : `${what} withheld`;
};
