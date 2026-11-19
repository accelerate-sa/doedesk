import type { ProviderVolume, ProviderVolumeKind } from "@t3tools/contracts";

export interface MountEntry {
  readonly device: string;
  readonly mountPoint: string;
  readonly fsType: string;
  readonly options: ReadonlyArray<string>;
}

const NETWORK_FS = new Set([
  "nfs",
  "nfs4",
  "smbfs",
  "smb3",
  "cifs",
  "afpfs",
  "webdav",
  "ftp",
  "sshfs",
  "fuse.sshfs",
  "fuse.rclone",
  "davfs",
  "9p",
  "afs",
  "ceph",
  "glusterfs",
]);

/** `/sbin/mount` on macOS: `/dev/disk7s1 on /Volumes/work (apfs, local, nodev, journaled)`. */
export const parseDarwinMount = (output: string): ReadonlyArray<MountEntry> =>
  output.split("\n").flatMap((line) => {
    const match = /^(.+?) on (.+) \(([^()]*)\)$/.exec(line.trim());
    if (match === null) return [];
    const [fsType = "", ...options] = match[3]!.split(",").map((part) => part.trim());
    return [{ device: match[1]!, mountPoint: match[2]!, fsType, options }];
  });

const unescapeMountField = (field: string) =>
  field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );

/** `/proc/mounts` on Linux: device, mount point, type, options, with spaces as `\040`. */
export const parseLinuxMounts = (output: string): ReadonlyArray<MountEntry> =>
  output.split("\n").flatMap((line) => {
    const [device, mountPoint, fsType, options] = line.trim().split(/\s+/);
    if (!device || !mountPoint || !fsType) return [];
    return [
      {
        device: unescapeMountField(device),
        mountPoint: unescapeMountField(mountPoint),
        fsType,
        options: (options ?? "").split(","),
      },
    ];
  });

/** Mount points of disk images, from `hdiutil info -plist`. Only names are read from it. */
export const parseDiskImageMountPoints = (plist: string): ReadonlySet<string> =>
  new Set(
    [...plist.matchAll(/<key>mount-point<\/key>\s*<string>([^<]*)<\/string>/g)].map((match) =>
      match[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
    ),
  );

const LINUX_VOLUME_ROOTS = ["/media/", "/run/media/", "/mnt/"];

const kindOf = (
  platform: NodeJS.Platform,
  entry: MountEntry,
  diskImages: ReadonlySet<string>,
): ProviderVolumeKind => {
  if (NETWORK_FS.has(entry.fsType)) return "network";
  if (platform === "darwin" && !entry.options.includes("local")) return "network";
  if (diskImages.has(entry.mountPoint) || entry.device.startsWith("/dev/loop")) return "diskImage";
  return "local";
};

/**
 * The drives a person can choose to search: mounted drives other than the system drive, which
 * the automatic check covers. Network drives and disk images are listed with their kind so the
 * page can leave them out unless asked.
 */
export const listVolumesFromMounts = (input: {
  readonly platform: NodeJS.Platform;
  readonly mounts: ReadonlyArray<MountEntry>;
  readonly diskImages: ReadonlySet<string>;
}): ReadonlyArray<ProviderVolume> => {
  const volumes = new Map<string, ProviderVolume>();
  for (const entry of input.mounts) {
    const underRoot =
      input.platform === "darwin"
        ? entry.mountPoint.startsWith("/Volumes/")
        : LINUX_VOLUME_ROOTS.some((root) => entry.mountPoint.startsWith(root));
    if (!underRoot || entry.mountPoint === "/") continue;
    const name = entry.mountPoint.slice(entry.mountPoint.lastIndexOf("/") + 1);
    if (name.length === 0) continue;
    volumes.set(entry.mountPoint, {
      path: entry.mountPoint,
      name,
      kind: kindOf(input.platform, entry, input.diskImages),
    });
  }
  return [...volumes.values()].toSorted((a, b) => a.name.localeCompare(b.name));
};
