import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

/** "A, B, and C" in `locale`. Hermes ships without Intl.ListFormat, so it joins with `resolve`. */
export function formatConjunctionList(
  items: ReadonlyArray<string>,
  locale: string,
  resolve: MFunctionType = mFallback,
): string {
  if (typeof Intl.ListFormat === "function") {
    return new Intl.ListFormat(locale, { type: "conjunction" }).format(items);
  }
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) {
    return resolve(
      msg("{first} and {second}", { first: items[0]!, second: items[1]!, $context: "list of two" }),
    );
  }
  let list = resolve(
    msg("{first}, and {last}", {
      first: items.at(-2)!,
      last: items.at(-1)!,
      $context: "last two items of a list of three or more",
    }),
  );
  for (let index = items.length - 3; index >= 0; index -= 1) {
    list = withRest(items[index]!, list, resolve);
  }
  return list;
}

const withRest = (first: string, rest: string, resolve: MFunctionType): string =>
  resolve(
    msg("{first}, {rest}", { first, rest, $context: "an item followed by the rest of a list" }),
  );

/** "A, B, C" with the language's own comma and no "and": for a list that may be cut short. */
export function formatCommaList(
  items: ReadonlyArray<string>,
  resolve: MFunctionType = mFallback,
): string {
  let list = items.at(-1) ?? "";
  for (let index = items.length - 2; index >= 0; index -= 1) {
    list = withRest(items[index]!, list, resolve);
  }
  return list;
}
