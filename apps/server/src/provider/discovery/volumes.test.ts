import { describe, expect, it } from "@effect/vitest";

import {
  listVolumesFromMounts,
  parseDarwinMount,
  parseDiskImageMountPoints,
  parseLinuxMounts,
} from "./volumes.ts";

// A Mac with the system drive, a second internal drive, two disk images, a share and OrbStack.
const DARWIN_MOUNT = `/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)
devfs on /dev (devfs, local, nobrowse)
/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)
/dev/disk7s1 on /Volumes/work (apfs, local, nodev, nosuid, journaled, noowners)
/dev/disk29s1 on /Volumes/LedOK Express (apfs, local, nodev, nosuid, read-only, journaled, noowners, nobrowse, mounted by sam)
/dev/disk30s1 on /Volumes/Audacity-4.0.2 (hfs, local, nodev, nosuid, read-only, noowners, mounted by sam)
//sam@nas/Team on /Volumes/Team (smbfs, nodev, nosuid, mounted by sam)
OrbStack:/OrbStack on /Users/sam/OrbStack (nfs, nodev, nosuid, noatime, mounted by sam)
/dev/disk13s1 on /Library/Developer/CoreSimulator/Volumes/iOS_23F77 (apfs, sealed, local, nodev, nosuid, read-only, journaled, noatime, nobrowse)`;

const HDIUTIL_PLIST = `<dict>
  <key>system-entities</key>
  <array>
    <dict><key>mount-point</key>
      <string>/Volumes/Audacity-4.0.2</string></dict>
    <dict><key>mount-point</key>
      <string>/Volumes/LedOK Express</string></dict>
    <dict><key>mount-point</key>
      <string>/Library/Developer/CoreSimulator/Volumes/iOS_23F77</string></dict>
  </array>
</dict>`;

describe("listVolumesFromMounts", () => {
  it("lists a Mac's other drives with their kind and leaves out the system drive", () => {
    expect(
      listVolumesFromMounts({
        platform: "darwin",
        mounts: parseDarwinMount(DARWIN_MOUNT),
        diskImages: parseDiskImageMountPoints(HDIUTIL_PLIST),
      }),
    ).toEqual([
      { path: "/Volumes/Audacity-4.0.2", name: "Audacity-4.0.2", kind: "diskImage" },
      { path: "/Volumes/LedOK Express", name: "LedOK Express", kind: "diskImage" },
      { path: "/Volumes/Team", name: "Team", kind: "network" },
      { path: "/Volumes/work", name: "work", kind: "local" },
    ]);
  });

  it("lists a Linux computer's mounted drives", () => {
    const procMounts = `/dev/nvme0n1p2 / ext4 rw,relatime 0 0
/dev/sdb1 /media/sam/Work\\040Drive ext4 rw,nosuid,nodev 0 0
server:/export /mnt/share nfs4 rw 0 0
/dev/loop3 /media/sam/image squashfs ro 0 0
tmpfs /run/user/1000 tmpfs rw 0 0`;
    expect(
      listVolumesFromMounts({
        platform: "linux",
        mounts: parseLinuxMounts(procMounts),
        diskImages: new Set(),
      }),
    ).toEqual([
      { path: "/media/sam/image", name: "image", kind: "diskImage" },
      { path: "/mnt/share", name: "share", kind: "network" },
      { path: "/media/sam/Work Drive", name: "Work Drive", kind: "local" },
    ]);
  });
});
