// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Checks DoeDesk's Windows and Linux release files before they are uploaded
// (.github/workflows/doedesk-release*.yml).
//
//   payload --resources <dir> --update-repository <owner/repo> [--fonts <dir>]
//     The packaged app's resources folder: app-update.yml points the updater at
//     the repository, and the app's .asar archives carry every brand font byte for byte.
//   manifests --dir <dir>
//     Each latest*.yml in the folder names files that are in it, with their
//     sha512 and size.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { positionals, values } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    resources: { type: "string" },
    "update-repository": { type: "string" },
    fonts: { type: "string" },
    dir: { type: "string" },
  },
});

const problems: Array<string> = [];

// Loaded here so `manifests` runs from a bare checkout, with no install.
async function checkPayload(
  resources: string,
  updateRepository: string,
  fontsDir: string | undefined,
) {
  const { extractFile, listPackage } = await import("@electron/asar");
  const updateConfig = NodeFS.readFileSync(NodePath.join(resources, "app-update.yml"), "utf8");
  const [owner, repo] = updateRepository.split("/");
  if (!new RegExp(`^owner: ${owner}$`, "m").test(updateConfig)) {
    problems.push(`app-update.yml does not name owner ${owner}:\n${updateConfig}`);
  }
  if (!new RegExp(`^repo: ${repo}$`, "m").test(updateConfig)) {
    problems.push(`app-update.yml does not name repo ${repo}:\n${updateConfig}`);
  }

  // The web client is in app.asar on Linux and macOS, and in server.asar on Windows.
  const fontEntries = NodeFS.readdirSync(resources)
    .filter((name) => name.endsWith(".asar"))
    .flatMap((name) => {
      const archive = NodePath.join(resources, name);
      return listPackage(archive, { isPack: false })
        .filter((entry) => /[\\/]client[\\/]brand-fonts[\\/][^\\/]+\.otf$/.test(entry))
        .map((entry) => ({ archive, entry }));
    });
  if (fontEntries.length === 0) {
    problems.push(`No .asar in ${resources} has brand-fonts/*.otf in the web client.`);
    return;
  }
  if (fontsDir === undefined) {
    console.log(`The app carries ${fontEntries.length} brand fonts.`);
    return;
  }
  const expected = NodeFS.readdirSync(fontsDir).filter((name) => name.endsWith(".otf"));
  const before = problems.length;
  for (const name of expected) {
    const found = fontEntries.find(({ entry }) => NodePath.basename(entry) === name);
    if (found === undefined) {
      problems.push(`The app is missing brand font ${name}.`);
      continue;
    }
    const packaged = extractFile(found.archive, found.entry.replace(/^[\\/]/, ""));
    if (!packaged.equals(NodeFS.readFileSync(NodePath.join(fontsDir, name)))) {
      problems.push(
        `${NodePath.basename(found.archive)}'s ${name} differs from the original file.`,
      );
    }
  }
  if (problems.length === before) {
    console.log(`The app carries the ${expected.length} original brand fonts.`);
  }
}

interface ManifestFile {
  readonly url: string;
  readonly sha512: string;
  readonly size: number | undefined;
}

// electron-builder writes these manifests in a fixed, flat shape.
function readManifest(text: string) {
  const files: Array<ManifestFile> = [];
  const [header = "", ...entries] = text.split(/^\s+- url: /m);
  for (const entry of entries) {
    const url = entry.split("\n")[0]!.trim();
    const sha512 = /^\s+sha512: (\S+)$/m.exec(entry)?.[1] ?? "";
    const size = /^\s+size: (\d+)$/m.exec(entry)?.[1];
    files.push({ url, sha512, size: size === undefined ? undefined : Number(size) });
  }
  // The top-level path and sha512 come after the files list.
  const tail =
    entries
      .at(-1)
      ?.split(/^(?=\S)/m)
      .slice(1)
      .join("") ?? header;
  return {
    files,
    path: /^path: (\S+)$/m.exec(tail)?.[1],
    sha512: /^sha512: (\S+)$/m.exec(tail)?.[1],
  };
}

function checkManifests(dir: string) {
  const manifests = NodeFS.readdirSync(dir).filter((name) => /^latest.*\.yml$/.test(name));
  if (manifests.length === 0) problems.push(`No latest*.yml in ${dir}.`);
  for (const name of manifests) {
    const manifest = readManifest(NodeFS.readFileSync(NodePath.join(dir, name), "utf8"));
    if (manifest.files.length === 0) problems.push(`${name} lists no files.`);
    for (const file of manifest.files) {
      const filePath = NodePath.join(dir, file.url);
      if (!NodeFS.existsSync(filePath)) {
        problems.push(`${name} names ${file.url}, which is not in ${dir}.`);
        continue;
      }
      const bytes = NodeFS.readFileSync(filePath);
      const sha512 = NodeCrypto.createHash("sha512").update(bytes).digest("base64");
      if (sha512 !== file.sha512) {
        problems.push(`${name}: sha512 of ${file.url} does not match.`);
      } else if (file.size !== undefined && file.size !== bytes.length) {
        problems.push(`${name}: size of ${file.url} is ${bytes.length}, not ${file.size}.`);
      } else {
        console.log(`${name}: ${file.url} matches (${bytes.length} bytes).`);
      }
    }
    const main = manifest.files.find((file) => file.url === manifest.path);
    if (manifest.path !== undefined && main?.sha512 !== manifest.sha512) {
      problems.push(`${name}: path ${manifest.path} and its sha512 do not match the files list.`);
    }
  }
}

const [command] = positionals;
if (command === "payload" && values.resources && values["update-repository"]) {
  await checkPayload(values.resources, values["update-repository"], values.fonts);
} else if (command === "manifests" && values.dir) {
  checkManifests(values.dir);
} else {
  throw new Error(
    "Usage: doedesk-check-release.ts payload --resources <dir> --update-repository <owner/repo> [--fonts <dir>] | manifests --dir <dir>",
  );
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
