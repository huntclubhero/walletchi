import forge from "node-forge";
import { config } from "../config.js";

export interface PassCertificates {
  signerCertPem: string;
  signerKeyPem: string;
  wwdrPem: string;
  passphrase: string;
}

let cached: PassCertificates | null = null;

// Extract the signer certificate + private key (PEM) from the PASS .p12, plus
// the WWDR intermediate cert. Used both for pkpass signing and APNs mTLS.
// Returns null in stub mode (no cert configured).
export function loadPassCertificates(): PassCertificates | null {
  if (!config.modes.appleLive) return null;
  if (cached) return cached;
  if (!config.PASS_CERT_P12_BASE64 || !config.PASS_CERT_PASSWORD) return null;

  const der = forge.util.decode64(config.PASS_CERT_P12_BASE64);
  const asn1 = forge.asn1.fromDer(der);
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, config.PASS_CERT_PASSWORD);

  const certBagOid = forge.pki.oids.certBag as string;
  const shroudedOid = forge.pki.oids.pkcs8ShroudedKeyBag as string;
  const keyBagOid = forge.pki.oids.keyBag as string;

  // Certificate bag
  const certBags = p12.getBags({ bagType: certBagOid });
  const certBagList = certBags[certBagOid] ?? [];
  if (!certBagList.length || !certBagList[0]?.cert) {
    throw new Error("PASS_CERT_P12: no certificate found in p12");
  }
  const signerCertPem = forge.pki.certificateToPem(certBagList[0].cert);

  // Private key bag (try shrouded then plain)
  const shrouded = p12.getBags({ bagType: shroudedOid })[shroudedOid];
  const plain = p12.getBags({ bagType: keyBagOid })[keyBagOid];
  const keyObj: forge.pki.PrivateKey | undefined =
    shrouded?.[0]?.key ?? plain?.[0]?.key ?? undefined;
  if (!keyObj) {
    throw new Error("PASS_CERT_P12: no private key found in p12");
  }
  const signerKeyPem = forge.pki.privateKeyToPem(keyObj);

  if (!config.APPLE_WWDR_PEM_BASE64) {
    throw new Error(
      "APPLE_WWDR_PEM_BASE64 required in live pass mode (Apple WWDR G4 cert). See README.",
    );
  }
  const wwdrPem = Buffer.from(config.APPLE_WWDR_PEM_BASE64, "base64").toString(
    "utf8",
  );

  cached = {
    signerCertPem,
    signerKeyPem,
    wwdrPem,
    passphrase: "", // key already decrypted to PEM above
  };
  return cached;
}
