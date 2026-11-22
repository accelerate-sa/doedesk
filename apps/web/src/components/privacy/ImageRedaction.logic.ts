import type { PrivacyImageHandling, PrivacyRedaction, PrivacyStatus } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/** The three ways an image can be sent, in the order they are offered. */
export const IMAGE_HANDLING_CHOICES: ReadonlyArray<{
  readonly value: PrivacyImageHandling;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "redacted",
    label: msg("Redacted image", { $context: "how images are sent" }),
    description: msg(
      "The AI sees the image with a black box over each personal detail, labelled with its stand-in. An image that cannot be redacted safely is sent as masked text instead.",
    ),
  },
  {
    value: "text",
    label: msg("Masked text only"),
    description: msg(
      "The AI sees only the text read from the image, with personal details replaced by stand-ins. No part of the picture is sent.",
    ),
  },
  {
    value: "withheld",
    label: msg("Do not send"),
    description: msg("The AI is told an image was withheld. Nothing in it is read or sent."),
  },
];

/** How images are sent now. A server from before this setting sends masked text. */
export const imageHandlingOf = (status: PrivacyStatus): PrivacyImageHandling =>
  status.imageHandling ?? "text";

/** One line saying what a record holds. Labels and descriptions above resolve the same way. */
export const describeRedaction = (
  record: PrivacyRedaction,
  resolve: MessageResolver = m,
): string => {
  const image = record.kind === "image";
  if (record.outcome === "redacted") {
    const count = record.valueBoxes + record.unreadableBoxes;
    return image
      ? resolve(
          msg(
            "{count, plural, one {Image sent redacted, {count} box} other {Image sent redacted, {count} boxes}}",
            { count },
          ),
        )
      : resolve(
          msg(
            "{count, plural, one {Document sent redacted, {count} box} other {Document sent redacted, {count} boxes}}",
            { count },
          ),
        );
  }
  if (record.outcome === "text") {
    return resolve(image ? msg("Image sent as masked text") : msg("Document sent as masked text"));
  }
  return resolve(image ? msg("Image withheld") : msg("Document withheld"));
};
