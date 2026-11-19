// An agent may create a thread with neither a title nor a prompt; its name is then a placeholder
// that the first message should replace, unlike a title the caller chose.
export const placeholderThreadTitle = (parentTitle: string, index: number): string =>
  `${parentTitle} chat ${index + 1}`;

export const isPlaceholderThreadTitle = (title: string): boolean =>
  / (?:chat|thread) \d+$/u.test(title);

/** What a chat is called until it gets a name of its own. */
export const NEW_THREAD_TITLE = "New chat";

// Older builds and T3 Code clients still send "New thread".
export const isNewThreadTitle = (title: string): boolean =>
  title === NEW_THREAD_TITLE || title === "New thread";
