import type {
  PrivacySealedDocument,
  PrivacySealedFolder,
  PrivacySealedListing,
  PrivacyStatus,
} from "@t3tools/contracts";

/**
 * The host of the person's own server, when that is what reads a sealed file. Null: no server of
 * theirs is connected. `sealReader` in `sealReader.logic.ts` also knows DoeDesk Cloud's worker.
 */
export const sealReaderHost = (status: PrivacyStatus): string | null => {
  const worker = status.worker;
  if (worker === undefined || worker.kind !== "custom" || worker.address === null) return null;
  try {
    return new URL(worker.address).host;
  } catch {
    return worker.address;
  }
};

const READ_FIRST = /\.(?:pdf|png|jpe?g|webp|tiff?)$/i;

/**
 * A PDF or an image has no text a model can be given, so the reading service reads it before it
 * is sealed. The person is told: that service sees the file too.
 */
export const readByReadingServiceFirst = (name: string): boolean => READ_FIRST.test(name);

/** The images the reading service takes. Any other image cannot be sealed, so it gets no Seal. */
export const sealableImage = (name: string): boolean =>
  READ_FIRST.test(name) && !/\.pdf$/i.test(name);

/** Sealing is offered while masking runs: with it off, agents are not given the tools to ask. */
export const sealingOffered = (status: PrivacyStatus | null): boolean => status?.active === true;

/**
 * Where a folder's files are sealed from. Privacy calls go to this computer only, so a folder on
 * another connected computer is sealed in DoeDesk there, and the person is told so here.
 */
export const folderSealing = (input: {
  readonly environmentId: string | null;
  readonly primaryEnvironmentId: string | null;
  readonly projectId: string | null | undefined;
  readonly status: PrivacyStatus | null;
}): "here" | "elsewhere" | "none" => {
  if (input.projectId == null || input.environmentId === null) return "none";
  if (!sealingOffered(input.status)) return "none";
  return input.environmentId === input.primaryEnvironmentId ? "here" : "elsewhere";
};

const samePath = (left: string, right: string): boolean =>
  left.replaceAll("\\", "/") === right.replaceAll("\\", "/");

/** The sealed document that was moved out of this path, if any. */
export const sealedDocumentAt = (
  listing: PrivacySealedListing | null,
  absolutePath: string | null,
): PrivacySealedDocument | undefined =>
  absolutePath === null
    ? undefined
    : listing?.documents.find(
        (document) => document.origin !== undefined && samePath(document.origin, absolutePath),
      );

const withSlashes = (path: string): string => path.replaceAll("\\", "/").replace(/\/+$/, "");

/** `path` as written from inside `folder`, or undefined when it does not lie in it. */
const pathInside = (folder: string, path: string): string | undefined => {
  const root = `${withSlashes(folder)}/`;
  const inside = withSlashes(path);
  return inside.startsWith(root) ? inside.slice(root.length) : undefined;
};

/** The sealed folder at exactly this path, if any. */
export const sealedFolderAt = (
  listing: PrivacySealedListing | null,
  absolutePath: string | null,
): PrivacySealedFolder | undefined =>
  absolutePath === null
    ? undefined
    : listing?.folders?.find((folder) =>
        samePath(withSlashes(folder.path), withSlashes(absolutePath)),
      );

/** The sealed folder that holds this path, at any depth. */
export const sealedFolderHolding = (
  listing: PrivacySealedListing | null,
  absolutePath: string | null,
): PrivacySealedFolder | undefined =>
  absolutePath === null
    ? undefined
    : listing?.folders?.find((folder) => pathInside(folder.path, absolutePath) !== undefined);

export interface SealedFolderGroup {
  readonly folder: PrivacySealedFolder;
  readonly name: string;
  /** Its sealed files, each with its path as written from inside the folder. */
  readonly documents: ReadonlyArray<{
    readonly document: PrivacySealedDocument;
    readonly path: string;
  }>;
  /** Files still readable in the folder, by the same kind of path, each with the reason. */
  readonly left: ReadonlyArray<{ readonly path: string; readonly message: string }>;
}

/**
 * A listing as the person reads it: each sealed folder as one row holding its files, then the
 * files sealed one by one. Forty files of one folder are one row, not forty.
 */
export const groupSealedListing = (
  listing: PrivacySealedListing,
): {
  readonly folders: ReadonlyArray<SealedFolderGroup>;
  readonly loose: ReadonlyArray<PrivacySealedDocument>;
} => {
  const folders = (listing.folders ?? []).map((folder) => ({
    folder,
    name: fileNameOf(folder.path),
    documents: listing.documents.flatMap((document) => {
      const path =
        document.origin === undefined ? undefined : pathInside(folder.path, document.origin);
      return path === undefined ? [] : [{ document, path }];
    }),
    left: folder.left.map((file) => ({
      path: pathInside(folder.path, file.path) ?? fileNameOf(file.path),
      message: file.message,
    })),
  }));
  const grouped = new Set(
    folders.flatMap((group) => group.documents.map(({ document }) => document)),
  );
  return { folders, loose: listing.documents.filter((document) => !grouped.has(document)) };
};

/** The sealed folder a path lies in, as the prompt to unseal it needs it. */
export const sealedFolderToUnseal = (
  listing: PrivacySealedListing | null,
  absolutePath: string | null,
): { readonly name: string; readonly path: string; readonly files: number } | undefined => {
  const folder =
    sealedFolderHolding(listing, absolutePath) ?? sealedFolderAt(listing, absolutePath);
  if (listing === null || folder === undefined) return undefined;
  const group = groupSealedListing(listing).folders.find((entry) => entry.folder === folder);
  return { name: fileNameOf(folder.path), path: folder.path, files: group?.documents.length ?? 0 };
};

type SealedUnread = NonNullable<PrivacySealedDocument["unread"]>;

/**
 * Whether reading a sealed file again can turn out differently while the file stays as it is:
 * when the reading service did not answer, or found no text. A kind of file that cannot be read,
 * or one too large, reads the same every time.
 */
export const worthReadingAgain = (unread: SealedUnread): boolean =>
  unread.kind === "service" || unread.kind === "noText";

/** The last part of a path written with either kind of slash. */
export const fileNameOf = (filePath: string): string =>
  filePath
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) ?? filePath;
