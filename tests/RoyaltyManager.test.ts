import { describe, it, expect, beforeEach } from "vitest";
import { stringUtf8CV, uintCV } from "@stacks/transactions";

const ERR_NOT_AUTHORIZED = 100;
const ERR_INVALID_ROYALTY_RATE = 101;
const ERR_NFT_NOT_FOUND = 102;
const ERR_NO_ROYALTY_SET = 103;
const ERR_INSUFFICIENT_BALANCE = 104;
const ERR_ROYALTY_ALREADY_SET = 105;
const ERR_INVALID_SALE_AMOUNT = 106;
const ERR_MAX_ROYALTIES_EXCEEDED = 107;
const ERR_AUTHORITY_NOT_VERIFIED = 108;
const ERR_INVALID_SPLIT_PERCENT = 109;
const ERR_UPDATE_NOT_ALLOWED = 110;

interface Royalty {
  nftId: number;
  rate: number;
  totalCollected: number;
  artist: string;
  platformShare: number;
  lastUpdated: number;
  status: boolean;
}

interface Distribution {
  amount: number;
  timestamp: number;
  buyer: string;
  seller: string;
  artistReceived: number;
  platformReceived: number;
}

interface Result<T> {
  ok: boolean;
  value: T;
}

class RoyaltyManagerMock {
  state: {
    nextRoyaltyId: number;
    maxRoyalties: number;
    platformFeeRate: number;
    authorityContract: string | null;
    royalties: Map<number, Royalty>;
    royaltyDistributions: Map<number, Distribution[]>;
    royaltiesByNft: Map<number, number>;
  } = {
    nextRoyaltyId: 0,
    maxRoyalties: 5000,
    platformFeeRate: 200,
    authorityContract: null,
    royalties: new Map(),
    royaltyDistributions: new Map(),
    royaltiesByNft: new Map(),
  };
  blockHeight: number = 0;
  caller: string = "ST1TEST";
  authorities: Set<string> = new Set(["ST1TEST"]);
  stxBalances: Map<string, number> = new Map([["ST1TEST", 1000000]]);
  stxTransfers: Array<{ amount: number; from: string; to: string | null }> = [];

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      nextRoyaltyId: 0,
      maxRoyalties: 5000,
      platformFeeRate: 200,
      authorityContract: null,
      royalties: new Map(),
      royaltyDistributions: new Map(),
      royaltiesByNft: new Map(),
    };
    this.blockHeight = 0;
    this.caller = "ST1TEST";
    this.authorities = new Set(["ST1TEST"]);
    this.stxBalances = new Map([["ST1TEST", 1000000]]);
    this.stxTransfers = [];
  }

  isVerifiedAuthority(principal: string): Result<boolean> {
    return { ok: true, value: this.authorities.has(principal) };
  }

  setAuthorityContract(contractPrincipal: string): Result<boolean> {
    if (contractPrincipal === "SP000000000000000000002Q6VF78") {
      return { ok: false, value: false };
    }
    if (this.state.authorityContract !== null) {
      return { ok: false, value: false };
    }
    this.state.authorityContract = contractPrincipal;
    return { ok: true, value: true };
  }

  setPlatformFeeRate(newRate: number): Result<boolean> {
    if (!this.state.authorityContract) return { ok: false, value: false };
    if (newRate <= 0 || newRate > 10000) return { ok: false, value: false };
    this.state.platformFeeRate = newRate;
    return { ok: true, value: true };
  }

  setRoyalty(nftId: number, rate: number, platformShare: number): Result<number> {
    if (this.state.nextRoyaltyId >= this.state.maxRoyalties) return { ok: false, value: ERR_MAX_ROYALTIES_EXCEEDED };
    if (rate <= 0 || rate > 10000) return { ok: false, value: ERR_INVALID_ROYALTY_RATE };
    if (platformShare <= 0 || platformShare > 10000) return { ok: false, value: ERR_INVALID_SPLIT_PERCENT };
    if (this.state.royaltiesByNft.has(nftId)) return { ok: false, value: ERR_ROYALTY_ALREADY_SET };
    if (!this.state.authorityContract) return { ok: false, value: ERR_AUTHORITY_NOT_VERIFIED };

    const fee = 100;
    if ((this.stxBalances.get(this.caller) || 0) < fee) return { ok: false, value: ERR_INSUFFICIENT_BALANCE };
    this.stxBalances.set(this.caller, (this.stxBalances.get(this.caller) || 0) - fee);
    this.stxBalances.set(this.state.authorityContract, (this.stxBalances.get(this.state.authorityContract) || 0) + fee);
    this.stxTransfers.push({ amount: fee, from: this.caller, to: this.state.authorityContract });

    const id = this.state.nextRoyaltyId;
    const royalty: Royalty = {
      nftId,
      rate,
      totalCollected: 0,
      artist: this.caller,
      platformShare,
      lastUpdated: this.blockHeight,
      status: true,
    };
    this.state.royalties.set(id, royalty);
    this.state.royaltiesByNft.set(nftId, id);
    this.state.nextRoyaltyId++;
    return { ok: true, value: id };
  }

  getRoyalty(id: number): Royalty | null {
    return this.state.royalties.get(id) || null;
  }

  getRoyaltyByNft(nftId: number): Royalty | null {
    const royaltyId = this.state.royaltiesByNft.get(nftId);
    if (!royaltyId) return null;
    return this.getRoyalty(royaltyId) || null;
  }

  updateRoyalty(royaltyId: number, newRate?: number, newPlatformShare?: number): Result<boolean> {
    const royalty = this.state.royalties.get(royaltyId);
    if (!royalty) return { ok: false, value: false };
    if (royalty.artist !== this.caller && this.state.authorityContract !== this.caller) return { ok: false, value: false };
    if (!royalty.status) return { ok: false, value: false };
    if (newRate !== undefined && (newRate <= 0 || newRate > 10000)) return { ok: false, value: false };
    if (newPlatformShare !== undefined && (newPlatformShare <= 0 || newPlatformShare > 10000)) return { ok: false, value: false };

    const updated: Royalty = {
      ...royalty,
      rate: newRate ?? royalty.rate,
      platformShare: newPlatformShare ?? royalty.platformShare,
      lastUpdated: this.blockHeight,
    };
    this.state.royalties.set(royaltyId, updated);
    return { ok: true, value: true };
  }

  distributeRoyalty(royaltyId: number, saleAmount: number, buyer: string, seller: string): Result<number> {
    const royalty = this.state.royalties.get(royaltyId);
    if (!royalty) return { ok: false, value: ERR_NO_ROYALTY_SET };
    if (saleAmount <= 0) return { ok: false, value: ERR_INVALID_SALE_AMOUNT };
    const totalRoyalty = (saleAmount * royalty.rate) / 10000;
    const platformAmount = (totalRoyalty * royalty.platformShare) / 10000;
    const artistAmount = totalRoyalty - platformAmount;
    const totalToTransfer = totalRoyalty;
    if ((this.stxBalances.get(this.caller) || 0) < totalToTransfer) return { ok: false, value: ERR_INSUFFICIENT_BALANCE };

    this.stxBalances.set(this.caller, (this.stxBalances.get(this.caller) || 0) - totalToTransfer);
    this.stxBalances.set(royalty.artist, (this.stxBalances.get(royalty.artist) || 0) + artistAmount);
    this.stxTransfers.push({ amount: artistAmount, from: this.caller, to: royalty.artist });
    if (this.state.authorityContract) {
      this.stxBalances.set(this.state.authorityContract, (this.stxBalances.get(this.state.authorityContract) || 0) + platformAmount);
      this.stxTransfers.push({ amount: platformAmount, from: this.caller, to: this.state.authorityContract });
    }

    const dist: Distribution = {
      amount: saleAmount,
      timestamp: this.blockHeight,
      buyer,
      seller,
      artistReceived: artistAmount,
      platformReceived: platformAmount,
    };
    const history = this.state.royaltyDistributions.get(royaltyId) || [];
    history.push(dist);
    this.state.royaltyDistributions.set(royaltyId, history);

    const updatedRoyalty: Royalty = {
      ...royalty,
      totalCollected: royalty.totalCollected + totalToTransfer,
      lastUpdated: this.blockHeight,
    };
    this.state.royalties.set(royaltyId, updatedRoyalty);
    return { ok: true, value: totalToTransfer };
  }

  deactivateRoyalty(royaltyId: number): Result<boolean> {
    const royalty = this.state.royalties.get(royaltyId);
    if (!royalty) return { ok: false, value: false };
    if (royalty.artist !== this.caller && this.state.authorityContract !== this.caller) return { ok: false, value: false };

    const updated: Royalty = { ...royalty, status: false, lastUpdated: this.blockHeight };
    this.state.royalties.set(royaltyId, updated);
    return { ok: true, value: true };
  }

  getRoyaltyCount(): Result<number> {
    return { ok: true, value: this.state.nextRoyaltyId };
  }

  checkRoyaltyExistence(nftId: number): Result<boolean> {
    return { ok: true, value: this.state.royaltiesByNft.has(nftId) };
  }

  getTotalCollected(id: number): number {
    const royalty = this.getRoyalty(id);
    return royalty ? royalty.totalCollected : 0;
  }
}

describe("RoyaltyManager", () => {
  let contract: RoyaltyManagerMock;

  beforeEach(() => {
    contract = new RoyaltyManagerMock();
    contract.reset();
  });

  it("sets royalty successfully", () => {
    contract.setAuthorityContract("ST2TEST");
    const result = contract.setRoyalty(1, 500, 1000);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0);

    const royalty = contract.getRoyalty(0);
    expect(royalty?.nftId).toBe(1);
    expect(royalty?.rate).toBe(500);
    expect(royalty?.platformShare).toBe(1000);
    expect(royalty?.artist).toBe("ST1TEST");
    expect(royalty?.status).toBe(true);
    expect(contract.stxTransfers).toEqual([{ amount: 100, from: "ST1TEST", to: "ST2TEST" }]);
  });

  it("rejects duplicate royalty for same NFT", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.setRoyalty(1, 500, 1000);
    const result = contract.setRoyalty(1, 600, 1200);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ROYALTY_ALREADY_SET);
  });

  it("rejects royalty without authority contract", () => {
    const result = contract.setRoyalty(1, 500, 1000);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_AUTHORITY_NOT_VERIFIED);
  });

  it("rejects invalid royalty rate", () => {
    contract.setAuthorityContract("ST2TEST");
    const result = contract.setRoyalty(1, 10001, 1000);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_ROYALTY_RATE);
  });

  it("rejects invalid platform share", () => {
    contract.setAuthorityContract("ST2TEST");
    const result = contract.setRoyalty(1, 500, 10001);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_SPLIT_PERCENT);
  });

  it("updates royalty successfully by artist", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.setRoyalty(1, 500, 1000);
    const result = contract.updateRoyalty(0, 600);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const royalty = contract.getRoyalty(0);
    expect(royalty?.rate).toBe(600);
  });

  it("updates royalty successfully by authority", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.setRoyalty(1, 500, 1000);
    contract.caller = "ST2TEST";
    const result = contract.updateRoyalty(0, 600, 1200);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const royalty = contract.getRoyalty(0);
    expect(royalty?.rate).toBe(600);
    expect(royalty?.platformShare).toBe(1200);
  });

  it("rejects update by unauthorized caller", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.setRoyalty(1, 500, 1000);
    contract.caller = "ST3FAKE";
    const result = contract.updateRoyalty(0, 600);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("rejects update for deactivated royalty", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.setRoyalty(1, 500, 1000);
    contract.deactivateRoyalty(0);
    const result = contract.updateRoyalty(0, 600);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("distributes royalty successfully", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.caller = "ST6ARTIST";
    contract.stxBalances.set("ST6ARTIST", 1000000);
    contract.setRoyalty(1, 1000, 5000);
    contract.caller = "ST1TEST";
    contract.stxBalances.set("ST1TEST", 10000);
    const result = contract.distributeRoyalty(0, 10000, "ST3BUYER", "ST4SELLER");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(1000);
    expect(contract.getTotalCollected(0)).toBe(1000);
    expect(contract.stxBalances.get("ST1TEST")).toBe(9000);
    expect(contract.stxBalances.get("ST2TEST")).toBe(100 + 500);
  });

  it("rejects distribution without royalty set", () => {
    const result = contract.distributeRoyalty(99, 10000, "ST3BUYER", "ST4SELLER");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NO_ROYALTY_SET);
  });

  it("rejects distribution with insufficient balance", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.setRoyalty(1, 1000, 1000);
    contract.stxBalances.set("ST1TEST", 500);
    const result = contract.distributeRoyalty(0, 10000, "ST3BUYER", "ST4SELLER");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INSUFFICIENT_BALANCE);
  });

  it("deactivates royalty successfully", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.setRoyalty(1, 500, 1000);
    const result = contract.deactivateRoyalty(0);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const royalty = contract.getRoyalty(0);
    expect(royalty?.status).toBe(false);
  });

  it("rejects deactivation by unauthorized", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.setRoyalty(1, 500, 1000);
    contract.caller = "ST3FAKE";
    const result = contract.deactivateRoyalty(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("returns correct royalty count", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.setRoyalty(1, 500, 1000);
    contract.setRoyalty(2, 600, 1200);
    const result = contract.getRoyaltyCount();
    expect(result.ok).toBe(true);
    expect(result.value).toBe(2);
  });

  it("checks royalty existence correctly", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.setRoyalty(1, 500, 1000);
    let result = contract.checkRoyaltyExistence(1);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    result = contract.checkRoyaltyExistence(2);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(false);
  });

  it("sets platform fee rate successfully", () => {
    contract.setAuthorityContract("ST2TEST");
    const result = contract.setPlatformFeeRate(300);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.platformFeeRate).toBe(300);
  });

  it("rejects platform fee rate without authority", () => {
    const result = contract.setPlatformFeeRate(300);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("rejects invalid platform fee rate", () => {
    contract.setAuthorityContract("ST2TEST");
    const result = contract.setPlatformFeeRate(10001);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });

  it("parses royalty parameters with Clarity types", () => {
    const rate = uintCV(500);
    const platformShare = uintCV(1000);
    expect(rate.value).toEqual(BigInt(500));
    expect(platformShare.value).toEqual(BigInt(1000));
  });

  it("rejects max royalties exceeded", () => {
    contract.setAuthorityContract("ST2TEST");
    contract.state.maxRoyalties = 1;
    contract.setRoyalty(1, 500, 1000);
    const result = contract.setRoyalty(2, 600, 1200);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_MAX_ROYALTIES_EXCEEDED);
  });

  it("sets authority contract successfully", () => {
    const result = contract.setAuthorityContract("ST2TEST");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.authorityContract).toBe("ST2TEST");
  });

  it("rejects invalid authority contract", () => {
    const result = contract.setAuthorityContract("SP000000000000000000002Q6VF78");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(false);
  });
});