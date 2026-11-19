import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

const DiscoveryPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));

/**
 * Where a provider's program was found. `path` is the login shell's PATH; `knownLocation` an
 * install folder the provider's installers or a version manager use; `appBundle` inside an app the
 * provider ships; `volume` a drive the user chose to search; `manual` a path the user typed.
 */
export const ProviderFindSource = Schema.Literals([
  "path",
  "knownLocation",
  "appBundle",
  "volume",
  "manual",
]);
export type ProviderFindSource = typeof ProviderFindSource.Type;

export const ProviderFind = Schema.Struct({
  driver: ProviderDriverKind,
  /** The executable to run, as `binaryPath` would hold it. */
  path: DiscoveryPath,
  source: ProviderFindSource,
  /** What `--version` printed, or null when it did not run or printed none. */
  version: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  /** The app the program came inside, such as "ChatGPT.app". */
  app: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type ProviderFind = typeof ProviderFind.Type;

export const ProviderDataFolder = Schema.Struct({
  driver: ProviderDriverKind,
  path: DiscoveryPath,
});
export type ProviderDataFolder = typeof ProviderDataFolder.Type;

export const ProviderDiscoveryScanResult = Schema.Struct({
  finds: Schema.Array(ProviderFind),
  /** A provider's own settings or data folder, which shows it was used here before. */
  dataFolders: Schema.Array(ProviderDataFolder),
});
export type ProviderDiscoveryScanResult = typeof ProviderDiscoveryScanResult.Type;

export const ProviderVolumeKind = Schema.Literals(["local", "network", "diskImage"]);
export type ProviderVolumeKind = typeof ProviderVolumeKind.Type;

export const ProviderVolume = Schema.Struct({
  path: DiscoveryPath,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  kind: ProviderVolumeKind,
});
export type ProviderVolume = typeof ProviderVolume.Type;

export const ProviderVolumeList = Schema.Struct({
  /** False where DoeDesk cannot list drives on this kind of computer. */
  supported: Schema.Boolean,
  /** Mounted drives other than the system drive, which the automatic check already covers. */
  volumes: Schema.Array(ProviderVolume),
});
export type ProviderVolumeList = typeof ProviderVolumeList.Type;

export const ProviderVolumeSearchInput = Schema.Struct({
  /** Only drives the user ticked. Each must be one the volume list returned. */
  volumes: Schema.Array(DiscoveryPath).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
export type ProviderVolumeSearchInput = typeof ProviderVolumeSearchInput.Type;

export const ProviderVolumeSearchStop = Schema.Literals(["time", "folders"]);
export type ProviderVolumeSearchStop = typeof ProviderVolumeSearchStop.Type;

export const ProviderVolumeSearchProgress = Schema.Struct({
  state: Schema.Literals(["searching", "done"]),
  /** The drive being searched now. */
  volume: Schema.NullOr(DiscoveryPath),
  foldersChecked: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  finds: Schema.Array(ProviderFind),
  /** Which bound ended the search early, if one did. */
  stoppedBy: Schema.NullOr(ProviderVolumeSearchStop),
});
export type ProviderVolumeSearchProgress = typeof ProviderVolumeSearchProgress.Type;

export const ProviderInspectInput = Schema.Struct({
  driver: ProviderDriverKind,
  path: DiscoveryPath,
});
export type ProviderInspectInput = typeof ProviderInspectInput.Type;

export const ProviderInspectResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), find: ProviderFind }),
  Schema.Struct({
    ok: Schema.Literal(false),
    reason: Schema.Literals(["notAbsolute", "notFound", "notExecutable"]),
  }),
]);
export type ProviderInspectResult = typeof ProviderInspectResult.Type;

export class ProviderDiscoveryError extends Schema.TaggedError<ProviderDiscoveryError>()(
  "ProviderDiscoveryError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
