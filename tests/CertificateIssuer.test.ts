import { describe, it, expect, beforeEach } from "vitest";
import { ClarityValue, stringAsciiCV, stringUtf8CV, uintCV, bufferCV, noneCV, someCV, listCV, tupleCV } from "@stacks/transactions";

const ERR_NOT_AUTHORIZED = 100;
const ERR_INVALID_ARTIST = 101;
const ERR_INVALID_METADATA = 102;
const ERR_INVALID_HASH = 103;
const ERR_CERT_NOT_FOUND = 104;
const ERR_CERT_ALREADY_ISSUED = 105;
const ERR_INVALID_STATUS = 106;
const ERR_INVALID_TIMESTAMP = 107;
const ERR_INVALID_FEE = 108;
const ERR_INVALID_AUTHORITY = 109;
const ERR_MAX_CERTS_EXCEEDED = 110;

interface Certificate {
  artist: string;
  artworkHash: Buffer;
  metadata: string;
  issuedAt: number;
  status: string;
  revokedAt: number | null;
  certUri: string;
}

interface Transfer {
  from: string;
  to: string;
  timestamp: number;
}

interface Result<T> {
  ok: boolean;
  value: T;
}

class CertificateIssuerMock {
  state: {
    certCounter: number;
    maxCerts: number;
    issuanceFee: number;
    platformFeeRate: number;
    authorityContract: string | null;
    certificates: Map<number, Certificate>;
    certsByHash: Map<string, number>;
    certTransfers: Map<number, Transfer[]>;
  } = {
    certCounter: 0,
    maxCerts: 100000,
    issuanceFee: 500,
    platformFeeRate: 250,
    authorityContract: null,
    certificates: new Map(),
    certsByHash: new Map(),
    certTransfers: new Map(),
  };
  blockHeight: number = 0;
  caller: string = "ST1ARTIST";
  stxTransfers: Array<{ amount: number; from: string; to: string | null }> = [];

  reset(): void {
    this.state = {
      certCounter: 0,
      maxCerts: 100000,
      issuanceFee: 500,
      platformFeeRate: 250,
      authorityContract: null,
      certificates: new Map(),
      certsByHash: new Map(),
      certTransfers: new Map(),
    };
    this.blockHeight = 0;
    this.caller = "ST1ARTIST";
    this.stxTransfers = [];
  }

  setAuthorityContract(contractPrincipal: string): Result<boolean> {
    if (contractPrincipal === "SP000000000000000000002Q6VF78") {
      return { ok: false, value: ERR_INVALID_AUTHORITY };
    }
    if (this.state.authorityContract !== null) {
      return { ok: false, value: ERR_INVALID_AUTHORITY };
    }
    this.state.authorityContract = contractPrincipal;
    return { ok: true, value: true };
  }

  setIssuanceFee(newFee: number): Result<boolean> {
    if (!this.state.authorityContract) {
      return { ok: false, value: ERR_INVALID_AUTHORITY };
    }
    if (newFee < 0) {
      return { ok: false, value: ERR_INVALID_FEE };
    }
    this.state.issuanceFee = newFee;
    return { ok: true, value: true };
  }

  setPlatformFeeRate(newRate: number): Result<boolean> {
    if (!this.state.authorityContract) {
      return { ok: false, value: ERR_INVALID_AUTHORITY };
    }
    if (newRate > 1000) {
      return { ok: false, value: ERR_INVALID_FEE };
    }
    this.state.platformFeeRate = newRate;
    return { ok: true, value: true };
  }

  issueCertificate(artworkHash: Buffer, metadata: string, certUri: string): Result<number> {
    if (this.state.certCounter >= this.state.maxCerts) {
      return { ok: false, value: ERR_MAX_CERTS_EXCEEDED };
    }
    if (this.caller !== "ST1ARTIST") {
      return { ok: false, value: ERR_INVALID_ARTIST };
    }
    if (artworkHash.length !== 32) {
      return { ok: false, value: ERR_INVALID_HASH };
    }
    if (metadata.length === 0 || metadata.length > 512) {
      return { ok: false, value: ERR_INVALID_METADATA };
    }
    if (this.state.certsByHash.has(artworkHash.toString("hex"))) {
      return { ok: false, value: ERR_CERT_ALREADY_ISSUED };
    }
    if (!this.state.authorityContract) {
      return { ok: false, value: ERR_INVALID_AUTHORITY };
    }

    this.stxTransfers.push({ amount: this.state.issuanceFee, from: this.caller, to: this.state.authorityContract });

    const certId = this.state.certCounter;
    const certificate: Certificate = {
      artist: this.caller,
      artworkHash,
      metadata,
      issuedAt: this.blockHeight,
      status: "active",
      revokedAt: null,
      certUri,
    };
    this.state.certificates.set(certId, certificate);
    this.state.certsByHash.set(artworkHash.toString("hex"), certId);
    this.state.certTransfers.set(certId, []);
    this.state.certCounter++;
    return { ok: true, value: certId };
  }

  revokeCertificate(certId: number): Result<boolean> {
    const cert = this.state.certificates.get(certId);
    if (!cert) {
      return { ok: false, value: ERR_CERT_NOT_FOUND };
    }
    if (cert.artist !== this.caller) {
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    }
    if (cert.status !== "active") {
      return { ok: false, value: ERR_INVALID_STATUS };
    }
    this.state.certificates.set(certId, { ...cert, status: "revoked", revokedAt: this.blockHeight });
    return { ok: true, value: true };
  }

  transferCertificate(certId: number, recipient: string): Result<boolean> {
    const cert = this.state.certificates.get(certId);
    if (!cert) {
      return { ok: false, value: ERR_CERT_NOT_FOUND };
    }
    if (cert.status !== "active") {
      return { ok: false, value: ERR_INVALID_STATUS };
    }
    if (recipient === this.caller) {
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    }
    const transfers = this.state.certTransfers.get(certId) || [];
    if (transfers.length >= 50) {
      return { ok: false, value: ERR_MAX_CERTS_EXCEEDED };
    }
    transfers.push({ from: this.caller, to: recipient, timestamp: this.blockHeight });
    this.state.certTransfers.set(certId, transfers);
    return { ok: true, value: true };
  }

  verifyCertificate(certId: number): Result<boolean> {
    const cert = this.state.certificates.get(certId);
    if (!cert) {
      return { ok: false, value: ERR_CERT_NOT_FOUND };
    }
    return { ok: true, value: cert.status === "active" };
  }

  getCertificate(certId: number): Certificate | null {
    return this.state.certificates.get(certId) || null;
  }

  getCertByHash(hash: Buffer): number | null {
    return this.state.certsByHash.get(hash.toString("hex")) || null;
  }

  getCertTransfers(certId: number): Transfer[] | null {
    return this.state.certTransfers.get(certId) || null;
  }

  getCertCount(): Result<number> {
    return { ok: true, value: this.state.certCounter };
  }

  setMaxCerts(newMax: number): Result<boolean> {
    if (!this.state.authorityContract) {
      return { ok: false, value: ERR_INVALID_AUTHORITY };
    }
    if (newMax <= 0) {
      return { ok: false, value: ERR_MAX_CERTS_EXCEEDED };
    }
    this.state.maxCerts = newMax;
    return { ok: true, value: true };
  }
}

describe("CertificateIssuer", () => {
  let contract: CertificateIssuerMock;
  const artworkHash = Buffer.from("a".repeat(64), "hex");
  const metadata = "Artwork: Sunset, Oil on Canvas, 2025";
  const certUri = "https://artcertify.io/cert/1";

  beforeEach(() => {
    contract = new CertificateIssuerMock();
    contract.reset();
  });

  it("issues a certificate successfully", () => {
    contract.setAuthorityContract("ST2AUTH");
    const result = contract.issueCertificate(artworkHash, metadata, certUri);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0);

    const cert = contract.getCertificate(0);
    expect(cert?.artist).toBe("ST1ARTIST");
    expect(cert?.artworkHash).toEqual(artworkHash);
    expect(cert?.metadata).toBe(metadata);
    expect(cert?.issuedAt).toBe(0);
    expect(cert?.status).toBe("active");
    expect(cert?.revokedAt).toBe(null);
    expect(cert?.certUri).toBe(certUri);
    expect(contract.stxTransfers).toEqual([{ amount: 500, from: "ST1ARTIST", to: "ST2AUTH" }]);
  });

  it("rejects certificate issuance with invalid artist", () => {
    contract.setAuthorityContract("ST2AUTH");
    contract.caller = "ST2FAKE";
    const result = contract.issueCertificate(artworkHash, metadata, certUri);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_ARTIST);
  });

  it("rejects certificate issuance with invalid hash", () => {
    contract.setAuthorityContract("ST2AUTH");
    const invalidHash = Buffer.from("a".repeat(60), "hex");
    const result = contract.issueCertificate(invalidHash, metadata, certUri);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_HASH);
  });

  it("rejects certificate issuance with invalid metadata", () => {
    contract.setAuthorityContract("ST2AUTH");
    const invalidMetadata = "";
    const result = contract.issueCertificate(artworkHash, invalidMetadata, certUri);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_METADATA);
  });

  it("rejects certificate issuance with duplicate hash", () => {
    contract.setAuthorityContract("ST2AUTH");
    contract.issueCertificate(artworkHash, metadata, certUri);
    const result = contract.issueCertificate(artworkHash, metadata, certUri);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_CERT_ALREADY_ISSUED);
  });

  it("rejects certificate issuance without authority contract", () => {
    const result = contract.issueCertificate(artworkHash, metadata, certUri);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_AUTHORITY);
  });

  it("revokes a certificate successfully", () => {
    contract.setAuthorityContract("ST2AUTH");
    contract.issueCertificate(artworkHash, metadata, certUri);
    const result = contract.revokeCertificate(0);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const cert = contract.getCertificate(0);
    expect(cert?.status).toBe("revoked");
    expect(cert?.revokedAt).toBe(0);
  });

  it("rejects revocation of non-existent certificate", () => {
    contract.setAuthorityContract("ST2AUTH");
    const result = contract.revokeCertificate(99);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_CERT_NOT_FOUND);
  });

  it("rejects revocation by non-artist", () => {
    contract.setAuthorityContract("ST2AUTH");
    contract.issueCertificate(artworkHash, metadata, certUri);
    contract.caller = "ST2FAKE";
    const result = contract.revokeCertificate(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("rejects revocation of already revoked certificate", () => {
    contract.setAuthorityContract("ST2AUTH");
    contract.issueCertificate(artworkHash, metadata, certUri);
    contract.revokeCertificate(0);
    const result = contract.revokeCertificate(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_STATUS);
  });

  it("transfers a certificate successfully", () => {
    contract.setAuthorityContract("ST2AUTH");
    contract.issueCertificate(artworkHash, metadata, certUri);
    const result = contract.transferCertificate(0, "ST3RECIPIENT");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const transfers = contract.getCertTransfers(0);
    expect(transfers).toEqual([{ from: "ST1ARTIST", to: "ST3RECIPIENT", timestamp: 0 }]);
  });

  it("rejects transfer of non-existent certificate", () => {
    contract.setAuthorityContract("ST2AUTH");
    const result = contract.transferCertificate(99, "ST3RECIPIENT");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_CERT_NOT_FOUND);
  });

  it("rejects transfer of revoked certificate", () => {
    contract.setAuthorityContract("ST2AUTH");
    contract.issueCertificate(artworkHash, metadata, certUri);
    contract.revokeCertificate(0);
    const result = contract.transferCertificate(0, "ST3RECIPIENT");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_STATUS);
  });

  it("verifies a certificate successfully", () => {
    contract.setAuthorityContract("ST2AUTH");
    contract.issueCertificate(artworkHash, metadata, certUri);
    const result = contract.verifyCertificate(0);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
  });

  it("verifies a revoked certificate as inactive", () => {
    contract.setAuthorityContract("ST2AUTH");
    contract.issueCertificate(artworkHash, metadata, certUri);
    contract.revokeCertificate(0);
    const result = contract.verifyCertificate(0);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(false);
  });

  it("sets issuance fee successfully", () => {
    contract.setAuthorityContract("ST2AUTH");
    const result = contract.setIssuanceFee(1000);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.issuanceFee).toBe(1000);
  });

  it("sets platform fee rate successfully", () => {
    contract.setAuthorityContract("ST2AUTH");
    const result = contract.setPlatformFeeRate(500);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.platformFeeRate).toBe(500);
  });

  it("rejects certificate issuance when max certs exceeded", () => {
    contract.setAuthorityContract("ST2AUTH");
    contract.state.maxCerts = 1;
    contract.issueCertificate(artworkHash, metadata, certUri);
    const result = contract.issueCertificate(artworkHash, metadata + "2", certUri);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_MAX_CERTS_EXCEEDED);
  });

  it("sets max certs successfully", () => {
    contract.setAuthorityContract("ST2AUTH");
    const result = contract.setMaxCerts(50000);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.maxCerts).toBe(50000);
  });
});