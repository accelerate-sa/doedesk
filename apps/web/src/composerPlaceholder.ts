import { isDeveloperMode } from "~/doedesk/product";

const PLAIN_PLACEHOLDER = "Ask anything";
const DEVELOPER_PLACEHOLDER = "Ask anything. @ files, $ skills, / commands";

/** The composer's hint. The shortcuts for files, skills and commands are spelled out in Developer mode. */
export const composerPlaceholder = (): string =>
  isDeveloperMode() ? DEVELOPER_PLACEHOLDER : PLAIN_PLACEHOLDER;
