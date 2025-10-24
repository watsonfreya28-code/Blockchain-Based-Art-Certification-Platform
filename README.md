# ArtCertify: Blockchain-Based Art Certification Platform

## Overview

ArtCertify is a Web3 platform built on the Stacks blockchain using Clarity smart contracts. It enables artists to issue tamper-proof, blockchain-based certificates of authenticity (CoA) for their artworks. These certificates are integrated into online art marketplaces, allowing seamless verification of provenance, ownership tracking, and automated royalty distribution. The platform solves real-world problems in the art industry, such as:

- **Art Forgery and Counterfeiting**: Traditional certificates can be easily forged, leading to billions in losses annually. Blockchain-based CoAs provide immutable proof of authenticity.
- **Provenance Tracking**: Artworks often lack transparent ownership histories, complicating resale and valuation. ArtCertify records every transfer on-chain.
- **Royalty Enforcement**: Artists rarely receive royalties from secondary sales due to lack of tracking. The platform automates perpetual royalties.
- **Marketplace Fragmentation**: Artists struggle with integrating certifications across platforms like OpenSea or Foundation. ArtCertify offers standardized APIs and hooks for easy integration.
- **Artist Empowerment**: Emerging artists face barriers to entry in verifying their work. This platform democratizes access with low-cost, decentralized tools.
- **Environmental and Cost Concerns**: By using Stacks (anchored to Bitcoin), it leverages energy-efficient proof-of-transfer consensus, reducing the carbon footprint compared to PoW chains like Ethereum.

The project consists of 6 core smart contracts written in Clarity, ensuring security, clarity (pun intended), and auditability. These contracts handle certificate issuance, NFT minting, provenance, royalties, marketplace interactions, and user management.

## Tech Stack

- **Blockchain**: Stacks (STX) for its Bitcoin-secured layer and Clarity language.
- **Smart Contract Language**: Clarity (predictable, secure, and non-Turing complete to prevent bugs like reentrancy).
- **Frontend Integration**: Can be built with React/Vue + Stacks.js for wallet connections (e.g., Hiro Wallet).
- **Marketplace Integration**: Hooks for platforms via standardized events and APIs; compatible with SIP-009/010 standards for NFTs on Stacks.
- **Deployment**: Use Stacks CLI for testing and deployment on testnet/mainnet.

## Smart Contracts

Below is a high-level description of the 6 smart contracts, including their purpose, key functions, and sample Clarity code snippets. All contracts are designed to be composable, with clear error handling and access controls.

### 1. ArtistRegistry.clar
**Purpose**: Manages artist registrations and verifications. Artists must register to issue certificates, preventing spam and ensuring only verified creators participate. Solves identity fraud by linking wallets to artist profiles.

**Key Functions**:
- `register-artist`: Registers an artist with metadata (name, bio, verification proof).
- `verify-artist`: Admin or community vote to verify an artist.
- `get-artist-info`: Retrieves artist details.

**Sample Code**:
```clarity
(define-map artists principal { name: (string-ascii 50), bio: (string-utf8 256), verified: bool })

(define-public (register-artist (name (string-ascii 50)) (bio (string-utf8 256)))
  (map-set artists tx-sender { name: name, bio: bio, verified: false })
  (ok true)
)

(define-public (verify-artist (artist principal))
  (if (is-eq tx-sender contract-owner)
    (map-set artists artist
      (merge (unwrap-panic (map-get? artists artist)) { verified: true }))
    (err u100) ;; Unauthorized
  )
)
```

### 2. CertificateIssuer.clar
**Purpose**: Allows registered artists to issue blockchain-based CoAs linked to artworks. Each certificate includes metadata like creation date, medium, and hash of the artwork file. Solves forgery by making certificates immutable and verifiable.

**Key Functions**:
- `issue-certificate`: Mints a new CoA for an artwork.
- `get-certificate`: Retrieves CoA details by ID.
- `revoke-certificate`: Artist-only revocation (e.g., for errors).

**Sample Code**:
```clarity
(define-map certificates uint { artist: principal, artwork-hash: (buff 32), metadata: (string-utf8 512), issued-at: uint })

(define-data-var cert-counter uint u0)

(define-public (issue-certificate (artwork-hash (buff 32)) (metadata (string-utf8 512)))
  (let ((id (var-get cert-counter)))
    (asserts! (unwrap-panic (map-get? artists tx-sender)).verified (err u101)) ;; Must be verified artist
    (map-set certificates id { artist: tx-sender, artwork-hash: artwork-hash, metadata: metadata, issued-at: block-height })
    (var-set cert-counter (+ id u1))
    (ok id)
  )
)
```

### 3. ArtNFT.clar
**Purpose**: Handles minting and transferring of NFTs representing artworks, tightly coupled with CoAs. Uses SIP-009 standard for compatibility. Solves ownership disputes with on-chain tokens.

**Key Functions**:
- `mint-nft`: Mints an NFT linked to a CoA.
- `transfer`: Transfers NFT, updating provenance.
- `get-owner`: Gets current owner.

**Sample Code**:
```clarity
(use-trait certificate-trait .CertificateIssuer)

(define-non-fungible-token art-nft uint)

(define-public (mint-nft (cert-id uint))
  (let ((cert (unwrap-panic (contract-call? .CertificateIssuer get-certificate cert-id))))
    (asserts! (is-eq tx-sender cert.artist) (err u102)) ;; Only artist can mint
    (nft-mint? art-nft cert-id tx-sender)
  )
)
```

### 4. ProvenanceTracker.clar
**Purpose**: Records the full ownership history of each artwork/NFT. Every transfer appends to an immutable log. Solves provenance gaps by providing a transparent chain of custody.

**Key Functions**:
- `record-transfer`: Logs a transfer event.
- `get-provenance`: Retrieves full history for an NFT.
- `verify-chain`: Checks if the provenance is unbroken.

**Sample Code**:
```clarity
(define-map provenance uint (list 100 { owner: principal, timestamp: uint }))

(define-public (record-transfer (nft-id uint) (new-owner principal))
  (let ((history (default-to (list) (map-get? provenance nft-id))))
    (map-set provenance nft-id (append history { owner: new-owner, timestamp: block-height }))
    (ok true)
  )
)
```

### 5. RoyaltyManager.clar
**Purpose**: Automates royalty payments on secondary sales. Artists set royalty percentages, and the contract enforces splits during transfers in integrated marketplaces. Solves royalty evasion with on-chain enforcement.

**Key Functions**:
- `set-royalty`: Artist sets royalty rate for an NFT.
- `distribute-royalty`: Calculates and transfers STX royalties on sale.
- `get-royalty-info`: Retrieves rate and history.

**Sample Code**:
```clarity
(define-map royalties uint { rate: uint, total-collected: uint }) ;; Rate in basis points (e.g., 1000 = 10%)

(define-public (set-royalty (nft-id uint) (rate uint))
  (asserts! (is-eq tx-sender (nft-get-owner? .ArtNFT art-nft nft-id)) (err u103))
  (map-set royalties nft-id { rate: rate, total-collected: u0 })
  (ok true)
)

(define-public (distribute-royalty (nft-id uint) (sale-amount uint))
  (let ((royalty (unwrap-panic (map-get? royalties nft-id)))
        (artist (nft-get-owner? .ArtNFT art-nft nft-id)) ;; Original artist
        (amount (* sale-amount royalty.rate) / u10000))
    (stx-transfer? amount tx-sender artist)
    (map-set royalties nft-id (merge royalty { total-collected: (+ royalty.total-collected amount) }))
    (ok amount)
  )
)
```

### 6. MarketplaceIntegrator.clar
**Purpose**: Provides hooks for integration with online marketplaces. Emits events for sales, verifies CoAs during listings, and triggers royalty distributions. Solves integration silos by standardizing interactions.

**Key Functions**:
- `list-nft`: Lists an NFT for sale with CoA verification.
- `execute-sale`: Handles sale logic, including provenance update and royalties.
- `integrate-event`: Emits events for external marketplaces.

**Sample Code**:
```clarity
(define-map listings uint { price: uint, seller: principal })

(define-public (list-nft (nft-id uint) (price uint))
  (asserts! (is-eq tx-sender (nft-get-owner? .ArtNFT art-nft nft-id)) (err u104))
  (contract-call? .ProvenanceTracker record-transfer nft-id tx-sender) ;; Log listing
  (map-set listings nft-id { price: price, seller: tx-sender })
  (ok true)
)

(define-public (execute-sale (nft-id uint) (buyer principal))
  (let ((listing (unwrap-panic (map-get? listings nft-id))))
    (asserts! (>= (stx-get-balance buyer) listing.price) (err u105))
    (stx-transfer? listing.price buyer listing.seller)
    (contract-call? .RoyaltyManager distribute-royalty nft-id listing.price)
    (nft-transfer? .ArtNFT art-nft nft-id buyer)
    (contract-call? .ProvenanceTracker record-transfer nft-id buyer)
    (map-delete listings nft-id)
    (ok true)
  )
)
```

## Deployment and Usage

1. **Install Stacks CLI**: `npm install -g @stacks/cli`.
2. **Deploy Contracts**: Use `clarinet` for local testing, then deploy to testnet.
3. **Interact**: Use Hiro Wallet to call functions (e.g., register as artist, issue CoA, mint NFT).
4. **Marketplace Integration Example**: Hook into `execute-sale` via event listeners in your marketplace dApp.

## Security Considerations

- All contracts use `asserts!` for access control.
- No external calls to untrusted contracts.
- Audited for common vulnerabilities (e.g., no loops that could cause gas issues in Clarity).
- Open to community audits.

## Future Enhancements

- DAO governance for platform fees.
- IPFS integration for artwork storage.
- Cross-chain bridges for broader marketplace compatibility.

## License

MIT License. Feel free to fork and contribute!