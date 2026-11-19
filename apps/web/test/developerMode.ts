import { __setClientSettingsForTests, getClientSettings } from "../src/hooks/useSettings";

/**
 * Turns DoeDesk's Developer mode on until disposed. Git, pull requests, terminals and the other
 * programming tools render only in Developer mode, so tests of those tools acquire this first.
 */
export function developerMode(): Disposable {
  const previous = getClientSettings();
  __setClientSettingsForTests({ ...previous, developerMode: true });
  return { [Symbol.dispose]: () => __setClientSettingsForTests(previous) };
}
