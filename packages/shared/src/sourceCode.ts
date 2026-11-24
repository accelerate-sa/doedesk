/** Where this build's source is published. A changed build served to others must name its own. */
export const SOURCE_REPOSITORY_URL = "https://github.com/accelerate-sa/doedesk";

const RELEASE_VERSION = /^\d{4}\.\d{1,2}\.\d+$/;

/**
 * AGPL section 13: the source of the version a person is using. Every release is tagged
 * `v<version>`; a build without a release version can only point at the repository.
 */
export function sourceCodeUrl(version: string | null | undefined): string {
  return version && RELEASE_VERSION.test(version)
    ? `${SOURCE_REPOSITORY_URL}/tree/v${version}`
    : SOURCE_REPOSITORY_URL;
}
