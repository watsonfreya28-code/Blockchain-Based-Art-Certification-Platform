// ProvenanceTracker.test.ts

import { describe, it, expect, beforeEach } from "vitest";
import { stringAsciiCV, uintCV, optionalCV, principalCV, listCV, someCV, noneCV } from "@stacks/transactions";

const ERR_NOT_AUTHORIZED = 100;
const ERR_INVALID_NFT_ID = 101;
const ERR_HISTORY_FULL = 102;
const ERR_INVALID_TRANSFER_TYPE = 103;
const ERR_INVALID_PRICE = 104;
const ERR_PROVENANCE_NOT_FOUND = 105;
const ERR_CHAIN_BROKEN = 106;
const ERR_MAX_HISTORY_EXCEEDED = 107;
const ERR_INVALID_TIMESTAMP = 108;
const ERR_TRANSFEROR_NOT_OWNER = 109;

interface ProvenanceEntry {
  owner: string;
  timestamp: bigint;
  transferType: string;
  price?: bigint;
  fromOwner: string;
}

interface Provenance {
  currentOwner: string;
  history: ProvenanceEntry[];
}

interface EventLog {
  eventType: string;
  nftId: number;
  data: string;
  timestamp: number;
}

interface VerifyResult {
  isValid: boolean;
  length: number;
}

interface Summary {
  currentOwner: string;
  totalTransfers: number;
  firstMint?: ProvenanceEntry;
  lastTransfer?: ProvenanceEntry;
}

interface PruneResult {
  pruned: boolean;
  removed: number;
}

interface Result<T> {
  ok: boolean;
  value: T | number;
}

class ProvenanceTrackerMock {
  state: {
    maxHistoryLength: number;
    admin: string;
    nextEventId: number;
    provenance: Map<number, Provenance>;
    eventsLog: Map<number, EventLog>;
  } = {
    maxHistoryLength: 100,
    admin: "ST1ADMIN",
    nextEventId: 0,
    provenance: new Map(),
    eventsLog: new Map(),
  };
  blockHeight: number = 0;
  caller: string = "ST1TEST";

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      maxHistoryLength: 100,
      admin: "ST1ADMIN",
      nextEventId: 0,
      provenance: new Map(),
      eventsLog: new Map(),
    };
    this.blockHeight = 0;
    this.caller = "ST1TEST";
  }

  isAdmin(): boolean {
    return this.caller === this.state.admin;
  }

  setMaxHistoryLength(newLength: number): Result<boolean> {
    if (!this.isAdmin()) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (newLength <= 0) return { ok: false, value: ERR_INVALID_NFT_ID };
    this.state.maxHistoryLength = newLength;
    return { ok: true, value: true };
  }

  transferAdmin(newAdmin: string): Result<boolean> {
    if (!this.isAdmin()) return { ok: false, value: ERR_NOT_AUTHORIZED };
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  initializeProvenance(nftId: number, initialOwner: string): Result<number> {
    if (nftId <= 0) return { ok: false, value: ERR_INVALID_NFT_ID };
    if (this.state.provenance.has(nftId)) return { ok: false, value: ERR_INVALID_NFT_ID };

    const entry: ProvenanceEntry = {
      owner: initialOwner,
      timestamp: BigInt(this.blockHeight),
      transferType: "mint",
      fromOwner: initialOwner,
    };
    const prov: Provenance = {
      currentOwner: initialOwner,
      history: [entry],
    };
    this.state.provenance.set(nftId, prov);

    const eventId = this.state.nextEventId;
    this.state.eventsLog.set(eventId, {
      eventType: "provenance-init",
      nftId,
      data: `Initialized for owner ${initialOwner}`,
      timestamp: this.blockHeight,
    });
    this.state.nextEventId++;

    return { ok: true, value: nftId };
  }

  recordTransfer(nftId: number, newOwner: string, transferType: string, price?: bigint): Result<boolean> {
    if (nftId <= 0) return { ok: false, value: ERR_INVALID_NFT_ID };
    if (!["sale", "gift", "auction"].includes(transferType)) return { ok: false, value: ERR_INVALID_TRANSFER_TYPE };
    if (price && price <= 0n) return { ok: false, value: ERR_INVALID_PRICE };

    const prov = this.state.provenance.get(nftId);
    if (!prov) return { ok: false, value: ERR_PROVENANCE_NOT_FOUND };

    const transferor = this.caller;
    if (prov.currentOwner !== transferor) return { ok: false, value: ERR_TRANSFEROR_NOT_OWNER };

    const currentLength = prov.history.length;
    if (currentLength >= this.state.maxHistoryLength) return { ok: false, value: ERR_HISTORY_FULL };

    const entry: ProvenanceEntry = {
      owner: newOwner,
      timestamp: BigInt(this.blockHeight),
      transferType,
      price,
      fromOwner: transferor,
    };
    prov.history.push(entry);
    prov.currentOwner = newOwner;

    const eventId = this.state.nextEventId;
    const priceStr = price ? price.toString() : "N/A";
    this.state.eventsLog.set(eventId, {
      eventType: "transfer-recorded",
      nftId,
      data: `Transfer to ${newOwner} at price ${priceStr}`,
      timestamp: this.blockHeight,
    });
    this.state.nextEventId++;

    return { ok: true, value: true };
  }

  verifyChain(nftId: number): Result<VerifyResult> {
    const prov = this.state.provenance.get(nftId);
    if (!prov) return { ok: false, value: ERR_PROVENANCE_NOT_FOUND };

    let isValid = true;
    for (const entry of prov.history) {
      if (entry.timestamp > BigInt(this.blockHeight)) {
        isValid = false;
        break;
      }
      if (entry.transferType !== "mint" && !["sale", "gift", "auction"].includes(entry.transferType)) {
        isValid = false;
        break;
      }
      if (entry.price && entry.price <= 0n) {
        isValid = false;
        break;
      }
    }

    if (!isValid) return { ok: false, value: ERR_CHAIN_BROKEN };
    return { ok: true, value: { isValid: true, length: prov.history.length } };
  }

  getProvenanceSummary(nftId: number): Result<Summary> {
    const prov = this.state.provenance.get(nftId);
    if (!prov) throw new Error("Provenance not found");

    const totalTransfers = prov.history.length - 1;
    const firstMint = prov.history[0];
    const lastTransfer = prov.history[prov.history.length - 1];

    return {
      ok: true,
      value: {
        currentOwner: prov.currentOwner,
        totalTransfers,
        firstMint,
        lastTransfer,
      },
    };
  }

  pruneOldHistory(nftId: number, keepLast: number): Result<PruneResult> {
    if (!this.isAdmin()) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (keepLast > this.state.maxHistoryLength) return { ok: false, value: ERR_INVALID_NFT_ID };

    const prov = this.state.provenance.get(nftId);
    if (!prov) return { ok: false, value: ERR_PROVENANCE_NOT_FOUND };

    const currentLength = prov.history.length;
    if (currentLength <= keepLast) return { ok: true, value: { pruned: false, removed: 0 } };

    const startIndex = currentLength - keepLast;
    prov.history = prov.history.slice(startIndex);
    return { ok: true, value: { pruned: true, removed: startIndex } };
  }

  getEventsCount(): Result<number> {
    return { ok: true, value: this.state.nextEventId };
  }

  getProvenance(nftId: number): Provenance | null {
    return this.state.provenance.get(nftId) || null;
  }

  getEvent(eventId: number): EventLog | null {
    return this.state.eventsLog.get(eventId) || null;
  }

  getCurrentOwner(nftId: number): string | null {
    const prov = this.state.provenance.get(nftId);
    return prov ? prov.currentOwner : null;
  }

  getHistoryLength(nftId: number): number {
    const prov = this.state.provenance.get(nftId);
    return prov ? prov.history.length : 0;
  }
}

describe("ProvenanceTracker", () => {
  let contract: ProvenanceTrackerMock;

  beforeEach(() => {
    contract = new ProvenanceTrackerMock();
    contract.reset();
    contract.caller = "ST1TEST";
  });

  it("initializes provenance successfully", () => {
    const result = contract.initializeProvenance(1, "ST1OWNER");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(1);

    const prov = contract.getProvenance(1);
    expect(prov?.currentOwner).toBe("ST1OWNER");
    expect(prov?.history.length).toBe(1);
    expect(prov?.history[0].transferType).toBe("mint");
    expect(contract.getEventsCount().value).toBe(1);
  });

  it("rejects initializing existing provenance", () => {
    contract.initializeProvenance(1, "ST1OWNER");
    const result = contract.initializeProvenance(1, "ST2OWNER");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_NFT_ID);
  });

  it("rejects invalid NFT ID for initialization", () => {
    const result = contract.initializeProvenance(0, "ST1OWNER");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_NFT_ID);
  });

  it("records transfer successfully", () => {
    contract.initializeProvenance(1, "ST1OWNER");
    contract.caller = "ST1OWNER";
    const result = contract.recordTransfer(1, "ST2OWNER", "sale", 1000n);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);

    const prov = contract.getProvenance(1);
    expect(prov?.currentOwner).toBe("ST2OWNER");
    expect(prov?.history.length).toBe(2);
    expect(prov?.history[1].transferType).toBe("sale");
    expect(prov?.history[1].price).toBe(1000n);
    expect(contract.getEventsCount().value).toBe(2);
  });

  it("records gift transfer without price", () => {
    contract.initializeProvenance(1, "ST1OWNER");
    contract.caller = "ST1OWNER";
    const result = contract.recordTransfer(1, "ST2OWNER", "gift");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);

    const prov = contract.getProvenance(1);
    expect(prov?.history[1].price).toBeUndefined();
  });

  it("rejects invalid transfer type", () => {
    contract.initializeProvenance(1, "ST1OWNER");
    contract.caller = "ST1OWNER";
    const result = contract.recordTransfer(1, "ST2OWNER", "invalid");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_TRANSFER_TYPE);
  });

  it("rejects transfer by non-owner", () => {
    contract.initializeProvenance(1, "ST1OWNER");
    contract.caller = "ST3FAKE";
    const result = contract.recordTransfer(1, "ST2OWNER", "sale", 1000n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_TRANSFEROR_NOT_OWNER);
  });

  it("rejects transfer when history is full", () => {
    contract.state.maxHistoryLength = 1;
    contract.initializeProvenance(1, "ST1OWNER");
    contract.caller = "ST1OWNER";
    const result = contract.recordTransfer(1, "ST2OWNER", "sale", 1000n);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_HISTORY_FULL);
  });

  it("verifies chain successfully", () => {
    contract.initializeProvenance(1, "ST1OWNER");
    contract.caller = "ST1OWNER";
    contract.recordTransfer(1, "ST2OWNER", "sale", 1000n);
    const result = contract.verifyChain(1);
    expect(result.ok).toBe(true);
    expect((result.value as VerifyResult).isValid).toBe(true);
    expect((result.value as VerifyResult).length).toBe(2);
  });

  it("rejects verification for broken chain", () => {
    contract.blockHeight = 10;
    contract.initializeProvenance(1, "ST1OWNER");
    contract.blockHeight = 5;
    contract.caller = "ST1OWNER";
    contract.recordTransfer(1, "ST2OWNER", "invalid", 1000n);
    const result = contract.verifyChain(1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_CHAIN_BROKEN);
  });

  it("rejects verification for non-existent provenance", () => {
    const result = contract.verifyChain(999);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_PROVENANCE_NOT_FOUND);
  });

  it("gets provenance summary correctly", () => {
    contract.initializeProvenance(1, "ST1OWNER");
    contract.caller = "ST1OWNER";
    contract.recordTransfer(1, "ST2OWNER", "sale", 1000n);
    const result = contract.getProvenanceSummary(1);
    expect(result.ok).toBe(true);
    const summary = result.value as Summary;
    expect(summary.currentOwner).toBe("ST2OWNER");
    expect(summary.totalTransfers).toBe(1);
    expect(summary.firstMint?.transferType).toBe("mint");
    expect(summary.lastTransfer?.transferType).toBe("sale");
  });

  it("rejects prune by non-admin", () => {
    contract.caller = "ST1TEST";
    const result = contract.pruneOldHistory(1, 2);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("sets max history length as admin", () => {
    contract.caller = "ST1ADMIN";
    const result = contract.setMaxHistoryLength(50);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.maxHistoryLength).toBe(50);
  });

  it("rejects setting max history length by non-admin", () => {
    contract.caller = "ST1TEST";
    const result = contract.setMaxHistoryLength(50);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("transfers admin successfully", () => {
    contract.caller = "ST1ADMIN";
    const result = contract.transferAdmin("ST2ADMIN");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.state.admin).toBe("ST2ADMIN");
  });

  it("rejects admin transfer by non-admin", () => {
    contract.caller = "ST1TEST";
    const result = contract.transferAdmin("ST2ADMIN");
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_AUTHORIZED);
  });

  it("returns correct current owner", () => {
    contract.initializeProvenance(1, "ST1OWNER");
    expect(contract.getCurrentOwner(1)).toBe("ST1OWNER");

    contract.caller = "ST1OWNER";
    contract.recordTransfer(1, "ST2OWNER", "sale");
    expect(contract.getCurrentOwner(1)).toBe("ST2OWNER");
  });

  it("returns correct history length", () => {
    contract.initializeProvenance(1, "ST1OWNER");
    expect(contract.getHistoryLength(1)).toBe(1);

    contract.caller = "ST1OWNER";
    contract.recordTransfer(1, "ST2OWNER", "sale");
    expect(contract.getHistoryLength(1)).toBe(2);
  });

  it("returns correct events count", () => {
    expect(contract.getEventsCount().value).toBe(0);

    contract.initializeProvenance(1, "ST1OWNER");
    expect(contract.getEventsCount().value).toBe(1);

    contract.caller = "ST1OWNER";
    contract.recordTransfer(1, "ST2OWNER", "sale");
    expect(contract.getEventsCount().value).toBe(2);
  });
});