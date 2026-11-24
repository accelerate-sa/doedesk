/**
 * A file's name put into a sentence, kept apart from it and taking its direction from its own
 * first letter: a Latin, dotted or numbered name stays left to right inside Arabic (`.env` does
 * not read `env.`), and an Arabic name runs right to left. Elements use `dir="auto"` instead.
 */
export const fileNameInText = (name: string): string => `\u2068${name}\u2069`;

/** A path, or a handle such as `DOC_1.pdf`, put into a sentence: always left to right. */
export const pathInText = (path: string): string => `\u2066${path}\u2069`;
