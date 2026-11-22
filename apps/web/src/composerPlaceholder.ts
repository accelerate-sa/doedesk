import { msg } from "gt-react";

import { isDeveloperMode } from "~/doedesk/product";

const PLAIN_PLACEHOLDER = msg("Ask anything");
const DEVELOPER_PLACEHOLDER = msg("Ask anything. @ files, $ skills, / commands");

/**
 * The composer's hint, as a message to resolve where it renders. The shortcuts for files, skills
 * and commands are spelled out in Developer mode.
 */
export const composerPlaceholder = (): string =>
  isDeveloperMode() ? DEVELOPER_PLACEHOLDER : PLAIN_PLACEHOLDER;
