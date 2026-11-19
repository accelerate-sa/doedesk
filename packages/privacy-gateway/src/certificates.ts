import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

import forge from "node-forge";

/**
 * A certificate authority that exists only on this machine, so the gateway can read and rewrite
 * agents' encrypted requests. Its key never leaves this directory, and only programs DoeDesk
 * starts are told to trust it; the operating system's trust store is not changed.
 */
export interface LocalAuthority {
  /** Path to the authority certificate alone, for programs that add to their defaults. */
  readonly certificatePath: string;
  /** Path to the usual public roots plus the authority, for programs that replace defaults. */
  readonly bundlePath: string;
  readonly contextFor: (host: string) => NodeTls.SecureContext;
}

const randomSerial = (): string => {
  const bytes = NodeCrypto.randomBytes(16);
  // A serial number must be positive: clear the top bit.
  bytes[0] = (bytes[0] ?? 0) & 0x7f;
  return bytes.toString("hex");
};

const generateRsaKeyPem = (): { readonly privateKey: string; readonly publicKey: string } =>
  NodeCrypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

const AUTHORITY_SUBJECT = [
  { name: "commonName", value: "DoeDesk Local Privacy Gateway" },
  { name: "organizationName", value: "DoeDesk (this device only)" },
];

const createAuthority = (): { readonly certificate: string; readonly privateKey: string } => {
  const keys = generateRsaKeyPem();
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
  certificate.serialNumber = randomSerial();
  certificate.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  certificate.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
  certificate.setSubject(AUTHORITY_SUBJECT);
  certificate.setIssuer(AUTHORITY_SUBJECT);
  certificate.setExtensions([
    { name: "basicConstraints", cA: true, pathLenConstraint: 0, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  certificate.sign(forge.pki.privateKeyFromPem(keys.privateKey), forge.md.sha256.create());
  return { certificate: forge.pki.certificateToPem(certificate), privateKey: keys.privateKey };
};

export const loadLocalAuthority = (directory: string): LocalAuthority => {
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const certificatePath = NodePath.join(directory, "authority.pem");
  const keyPath = NodePath.join(directory, "authority.key");
  const bundlePath = NodePath.join(directory, "trust-bundle.pem");

  let authority: { readonly certificate: string; readonly privateKey: string };
  if (NodeFS.existsSync(certificatePath) && NodeFS.existsSync(keyPath)) {
    authority = {
      certificate: NodeFS.readFileSync(certificatePath, "utf8"),
      privateKey: NodeFS.readFileSync(keyPath, "utf8"),
    };
  } else {
    authority = createAuthority();
    NodeFS.writeFileSync(keyPath, authority.privateKey, { mode: 0o600 });
    NodeFS.writeFileSync(certificatePath, authority.certificate, { mode: 0o644 });
  }
  NodeFS.writeFileSync(
    bundlePath,
    `${NodeTls.rootCertificates.join("\n")}\n${authority.certificate}`,
    {
      mode: 0o644,
    },
  );

  const authorityCertificate = forge.pki.certificateFromPem(authority.certificate);
  const authorityKey = forge.pki.privateKeyFromPem(authority.privateKey);
  // One key serves every host certificate: generating a key per host would cost seconds each.
  const hostKeys = generateRsaKeyPem();
  const hostPublicKey = forge.pki.publicKeyFromPem(hostKeys.publicKey);
  const contexts = new Map<string, NodeTls.SecureContext>();

  return {
    certificatePath,
    bundlePath,
    contextFor: (host) => {
      const cached = contexts.get(host);
      if (cached !== undefined) return cached;
      const certificate = forge.pki.createCertificate();
      certificate.publicKey = hostPublicKey;
      certificate.serialNumber = randomSerial();
      certificate.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
      certificate.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      certificate.setSubject([{ name: "commonName", value: host }]);
      certificate.setIssuer(authorityCertificate.subject.attributes);
      certificate.setExtensions([
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: host }] },
      ]);
      certificate.sign(authorityKey, forge.md.sha256.create());
      const context = NodeTls.createSecureContext({
        key: hostKeys.privateKey,
        cert: `${forge.pki.certificateToPem(certificate)}\n${authority.certificate}`,
      });
      contexts.set(host, context);
      return context;
    },
  };
};
