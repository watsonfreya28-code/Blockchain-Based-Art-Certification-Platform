;; ProvenanceTracker.clar

(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-INVALID-NFT-ID u101)
(define-constant ERR-HISTORY-FULL u102)
(define-constant ERR-INVALID-TRANSFER-TYPE u103)
(define-constant ERR-INVALID-PRICE u104)
(define-constant ERR-PROVENANCE-NOT-FOUND u105)
(define-constant ERR-CHAIN-BROKEN u106)
(define-constant ERR-MAX-HISTORY-EXCEEDED u107)
(define-constant ERR-INVALID-TIMESTAMP u108)
(define-constant ERR-TRANSFEROR-NOT-OWNER u109)

(define-data-var max-history-length uint u100)
(define-data-var admin principal tx-sender)
(define-data-var next-event-id uint u0)

(define-map provenance
  uint
  {
    current-owner: principal,
    history: (list 100 { 
      owner: principal, 
      timestamp: uint, 
      transfer-type: (string-ascii 20), 
      price: (optional uint),
      from-owner: principal 
    })
  }
)

(define-map events-log
  uint
  {
    event-type: (string-ascii 20),
    nft-id: uint,
    details: (tuple {owner: principal, price: (optional uint), from: (optional principal)}),
    timestamp: uint
  }
)

;; ----------------------
;; Read-only helpers
;; ----------------------

(define-read-only (get-provenance (nft-id uint))
  (map-get? provenance nft-id)
)

(define-read-only (get-event (event-id uint))
  (map-get? events-log event-id)
)

(define-read-only (get-current-owner (nft-id uint))
  (match (map-get? provenance nft-id)
    prov (some (get current-owner prov))
    none
  )
)

(define-read-only (get-history-length (nft-id uint))
  (len (default-to (list) (get history (map-get? provenance nft-id))))
)

;; ----------------------
;; Validation helpers
;; ----------------------

(define-private (validate-nft-id (id uint))
  (if (> id u0)
      (ok true)
      (err ERR-INVALID-NFT-ID))
)

(define-private (validate-transfer-type (typ (string-ascii 20)))
  (if (or (is-eq typ "sale") (is-eq typ "gift") (is-eq typ "auction"))
      (ok true)
      (err ERR-INVALID-TRANSFER-TYPE))
)

(define-private (validate-price (price (optional uint)))
  (match price p
    (if (> p u0) (ok true) (err ERR-INVALID-PRICE))
    (ok true))
)

(define-private (validate-timestamp (ts uint))
  (if (<= ts block-height)
      (ok true)
      (err ERR-INVALID-TIMESTAMP))
)

(define-private (is-admin)
  (is-eq tx-sender (var-get admin))
)

(define-private (can-transfer (nft-id uint) (transferor principal))
  (let ((prov (unwrap! (map-get? provenance nft-id) false)))
    (is-eq transferor (get current-owner prov)))
)

;; ----------------------
;; Admin setters
;; ----------------------

(define-public (set-max-history-length (new-length uint))
  (begin
    (asserts! (is-admin) (err ERR-NOT-AUTHORIZED))
    (asserts! (> new-length u0) (err ERR-INVALID-NFT-ID))
    (var-set max-history-length new-length)
    (ok true)
  )
)

(define-public (transfer-admin (new-admin principal))
  (begin
    (asserts! (is-admin) (err ERR-NOT-AUTHORIZED))
    (asserts! (is-standard new-admin) (err ERR-NOT-AUTHORIZED))
    (var-set admin new-admin)
    (ok true)
  )
)

;; ----------------------
;; Core actions
;; ----------------------

(define-public (initialize-provenance (nft-id uint) (initial-owner principal))
  (let (
        (validated-id (try! (validate-nft-id nft-id)))
      )
    (asserts! (is-none (map-get? provenance nft-id)) (err ERR-INVALID-NFT-ID))
    (map-set provenance nft-id
      {
        current-owner: initial-owner,
        history: (list 
          { 
            owner: initial-owner, 
            timestamp: block-height, 
            transfer-type: "mint", 
            price: none, 
            from-owner: initial-owner 
          }
        )
      }
    )
    (let ((event-id (var-get next-event-id)))
      (map-set events-log event-id
        {
          event-type: "provenance-init",
          nft-id: nft-id,
          details: {owner: initial-owner, price: none, from: none},
          timestamp: block-height
        }
      )
      (var-set next-event-id (+ event-id u1))
    )
    (print { event: "provenance-initialized", nft-id: nft-id })
    (ok nft-id)
  )
)

(define-public (record-transfer (nft-id uint) (new-owner principal) (transfer-type (string-ascii 20)) (price (optional uint)))
  (let (
        (validated-id (try! (validate-nft-id nft-id)))
        (validated-type (try! (validate-transfer-type transfer-type)))
        (validated-price (try! (validate-price price)))
        (prov (unwrap! (map-get? provenance nft-id) (err ERR-PROVENANCE-NOT-FOUND)))
        (current-history (get history prov))
        (current-length (len current-history))
        (max-len (var-get max-history-length))
        (transferor tx-sender)
      )
    (asserts! (can-transfer nft-id transferor) (err ERR-TRANSFEROR-NOT-OWNER))
    (asserts! (< current-length max-len) (err ERR-HISTORY-FULL))
    (let (
          (new-history (append current-history 
            { 
              owner: new-owner, 
              timestamp: block-height, 
              transfer-type: transfer-type, 
              price: price, 
              from-owner: transferor 
            }
          ))
        )
      (map-set provenance nft-id
        {
          current-owner: new-owner,
          history: new-history
        }
      )
      (let ((event-id (var-get next-event-id)))
        (map-set events-log event-id
          {
            event-type: "transfer-recorded",
            nft-id: nft-id,
            details: {owner: new-owner, price: price, from: (some transferor)},
            timestamp: block-height
          }
        )
        (var-set next-event-id (+ event-id u1))
      )
      (print { event: "transfer-recorded", nft-id: nft-id, new-owner: new-owner })
      (ok true)
    )
  )
)

(define-public (verify-chain (nft-id uint))
  (let (
        (prov (unwrap! (map-get? provenance nft-id) (err ERR-PROVENANCE-NOT-FOUND)))
        (history (get history prov))
        (verified (fold verify-step history true))
      )
    (if verified
        (ok { is-valid: true, length: (len history) })
        (err ERR-CHAIN-BROKEN))
  )
)

(define-private (verify-step (entry { owner: principal, timestamp: uint, transfer-type: (string-ascii 20), price: (optional uint), from-owner: principal }) (acc bool))
  (if (not acc)
      false
      (and 
        (<= (get timestamp entry) block-height)
        (or (is-eq (get transfer-type entry) "mint") (is-eq (get transfer-type entry) "sale") (is-eq (get transfer-type entry) "gift") (is-eq (get transfer-type entry) "auction"))
        (match (get price entry) p (> p u0) true)
      ))
)

(define-public (get-provenance-summary (nft-id uint))
  (let (
        (prov (unwrap! (map-get? provenance nft-id) none))
        (history (get history prov))
        (current-owner (get current-owner prov))
        (total-transfers (- (len history) u1))
      )
    (ok { 
      current-owner: current-owner, 
      total-transfers: total-transfers, 
      first-mint: (unwrap! (element-at? history u0) none), 
      last-transfer: (unwrap! (element-at? history (- (len history) u1)) none) 
    })
  )
)

(define-public (prune-old-history (nft-id uint) (keep-last uint))
  (begin
    (asserts! (is-admin) (err ERR-NOT-AUTHORIZED))
    (asserts! (<= keep-last (var-get max-history-length)) (err ERR-INVALID-NFT-ID))
    (let (
          (prov (unwrap! (map-get? provenance nft-id) (err ERR-PROVENANCE-NOT-FOUND)))
          (full-history (get history prov))
          (current-length (len full-history))
        )
      (if (> current-length keep-last)
          (let (
                (start-index (- current-length keep-last))
                (pruned-history (unwrap-panic (slice? full-history start-index current-length)))
              )
            (map-set provenance nft-id { current-owner: (get current-owner prov), history: pruned-history })
            (ok { pruned: true, removed: start-index })
          )
          (ok { pruned: false, removed: u0 })
      )
    )
  )
)

(define-read-only (get-events-count)
  (ok (var-get next-event-id))
)