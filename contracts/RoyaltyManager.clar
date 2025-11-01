(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-INVALID-ROYALTY-RATE u101)
(define-constant ERR-NFT-NOT-FOUND u102)
(define-constant ERR-NO-ROYALTY-SET u103)
(define-constant ERR-INSUFFICIENT-BALANCE u104)
(define-constant ERR-ROYALTY-ALREADY-SET u105)
(define-constant ERR-INVALID-SALE-AMOUNT u106)
(define-constant ERR-MAX-ROYALTIES-EXCEEDED u107)
(define-constant ERR-AUTHORITY-NOT-VERIFIED u108)
(define-constant ERR-INVALID-SPLIT-PERCENT u109)
(define-constant ERR-UPDATE-NOT-ALLOWED u110)

(define-data-var next-royalty-id uint u0)
(define-data-var max-royalties uint u5000)
(define-data-var platform-fee-rate uint u200)
(define-data-var authority-contract (optional principal) none)

(define-map royalties
  uint
  {
    nft-id: uint,
    rate: uint,
    total-collected: uint,
    artist: principal,
    platform-share: uint,
    last-updated: uint,
    status: bool
  }
)

(define-map royalty-distributions
  uint
  (list 200 {
    amount: uint,
    timestamp: uint,
    buyer: principal,
    seller: principal,
    artist-received: uint,
    platform-received: uint
  })
)

(define-map royalties-by-nft
  uint
  uint
)

(define-read-only (get-royalty (id uint))
  (map-get? royalties id)
)

(define-read-only (get-royalty-by-nft (nft-id uint))
  (map-get? royalties-by-nft nft-id)
  (map-get? royalties (unwrap-panic (map-get? royalties-by-nft nft-id)))
)

(define-read-only (get-royalty-distributions (id uint))
  (map-get? royalty-distributions id)
)

(define-read-only (is-royalty-set (nft-id uint))
  (is-some (map-get? royalties-by-nft nft-id))
)

(define-read-only (get-total-collected (id uint))
  (let ((royalty (unwrap-panic (map-get? royalties id))))
    (get total-collected royalty)
  )
)

(define-private (validate-royalty-rate (rate uint))
  (if (and (> rate u0) (<= rate u10000))
      (ok true)
      (err ERR-INVALID-ROYALTY-RATE))
)

(define-private (validate-sale-amount (amount uint))
  (if (> amount u0)
      (ok true)
      (err ERR-INVALID-SALE-AMOUNT))
)

(define-private (validate-split-percent (percent uint))
  (if (and (> percent u0) (<= percent u10000))
      (ok true)
      (err ERR-INVALID-SPLIT-PERCENT))
)

(define-private (validate-principal (p principal))
  (if (not (is-eq p 'SP000000000000000000002Q6VF78))
      (ok true)
      (err ERR-NOT-AUTHORIZED))
)

(define-private (calculate-artist-share (sale-amount uint) (rate uint) (platform-share uint))
  (let ((total-royalty (* sale-amount rate) / u10000)
        (platform-amount (* total-royalty platform-share) / u10000)
        (artist-amount (- total-royalty platform-amount)))
    { artist: artist-amount, platform: platform-amount }
  )
)

(define-public (set-authority-contract (contract-principal principal))
  (begin
    (try! (validate-principal contract-principal))
    (asserts! (is-none (var-get authority-contract)) (err ERR-AUTHORITY-NOT-VERIFIED))
    (var-set authority-contract (some contract-principal))
    (ok true)
  )
)

(define-public (set-platform-fee-rate (new-rate uint))
  (begin
    (try! (validate-royalty-rate new-rate))
    (asserts! (is-some (var-get authority-contract)) (err ERR-AUTHORITY-NOT-VERIFIED))
    (var-set platform-fee-rate new-rate)
    (ok true)
  )
)

(define-public (set-royalty (nft-id uint) (rate uint) (platform-share uint))
  (let (
        (next-id (var-get next-royalty-id))
        (current-max (var-get max-royalties))
        (authority (var-get authority-contract))
      )
    (asserts! (< next-id current-max) (err ERR-MAX-ROYALTIES-EXCEEDED))
    (try! (validate-royalty-rate rate))
    (try! (validate-split-percent platform-share))
    (asserts! (is-none (map-get? royalties-by-nft nft-id)) (err ERR-ROYALTY-ALREADY-SET))
    (asserts! (is-some authority) (err ERR-AUTHORITY-NOT-VERIFIED))
    (let ((authority-recipient (unwrap! authority (err ERR-AUTHORITY-NOT-VERIFIED))))
      (try! (stx-transfer? u100 tx-sender authority-recipient))
    )
    (map-set royalties next-id
      {
        nft-id: nft-id,
        rate: rate,
        total-collected: u0,
        artist: tx-sender,
        platform-share: platform-share,
        last-updated: block-height,
        status: true
      }
    )
    (map-set royalties-by-nft nft-id next-id)
    (var-set next-royalty-id (+ next-id u1))
    (print { event: "royalty-set", id: next-id, nft-id: nft-id })
    (ok next-id)
  )
)

(define-public (update-royalty (royalty-id uint) (new-rate (optional uint)) (new-platform-share (optional uint)))
  (let ((royalty (map-get? royalties royalty-id)))
    (match royalty
      r
        (begin
          (asserts! (or (is-eq tx-sender (get artist r)) (is-some (var-get authority-contract))) (err ERR-NOT-AUTHORIZED))
          (asserts! (get status r) (err ERR-UPDATE-NOT-ALLOWED))
          (match new-rate
            nr (try! (validate-royalty-rate nr))
            (ok true)
          )
          (match new-platform-share
            ns (try! (validate-split-percent ns))
            (ok true)
          )
          (map-set royalties royalty-id
            {
              nft-id: (get nft-id r),
              rate: (match new-rate nr nr (get rate r)),
              total-collected: (get total-collected r),
              artist: (get artist r),
              platform-share: (match new-platform-share ns ns (get platform-share r)),
              last-updated: block-height,
              status: (get status r)
            }
          )
          (print { event: "royalty-updated", id: royalty-id })
          (ok true)
        )
      (err ERR-NFT-NOT-FOUND)
    )
  )
)

(define-public (distribute-royalty (royalty-id uint) (sale-amount uint) (buyer principal) (seller principal))
  (let (
        (royalty (unwrap! (map-get? royalties royalty-id) (err ERR-NO-ROYALTY-SET)))
        (platform-rate (var-get platform-fee-rate))
        (shares (calculate-artist-share sale-amount (get rate royalty) (get platform-share royalty)))
        (artist-amount (get artist shares))
        (platform-amount (get platform shares))
        (total-royalty (+ artist-amount platform-amount))
        (dist-history (default-to (list) (map-get? royalty-distributions royalty-id)))
        (new-history (append dist-history
          {
            amount: sale-amount,
            timestamp: block-height,
            buyer: buyer,
            seller: seller,
            artist-received: artist-amount,
            platform-received: platform-amount
          }
        ))
      )
    (try! (validate-sale-amount sale-amount))
    (asserts! (>= (stx-get-balance tx-sender) total-royalty) (err ERR-INSUFFICIENT-BALANCE))
    (try! (stx-transfer? artist-amount tx-sender (get artist royalty)))
    (try! (stx-transfer? platform-amount tx-sender (unwrap! (var-get authority-contract) (err ERR-AUTHORITY-NOT-VERIFIED))))
    (map-set royalties royalty-id
      (merge royalty
        {
          total-collected: (+ (get total-collected royalty) total-royalty),
          last-updated: block-height
        }
      )
    )
    (map-set royalty-distributions royalty-id new-history)
    (print { event: "royalty-distributed", id: royalty-id, amount: total-royalty })
    (ok total-royalty)
  )
)

(define-public (deactivate-royalty (royalty-id uint))
  (let ((royalty (map-get? royalties royalty-id)))
    (match royalty
      r
        (begin
          (asserts! (or (is-eq tx-sender (get artist r)) (is-some (var-get authority-contract))) (err ERR-NOT-AUTHORIZED))
          (map-set royalties royalty-id
            (merge r { status: false, last-updated: block-height })
          )
          (print { event: "royalty-deactivated", id: royalty-id })
          (ok true)
        )
      (err ERR-NFT-NOT-FOUND)
    )
  )
)

(define-public (get-royalty-count)
  (ok (var-get next-royalty-id))
)

(define-public (check-royalty-existence (nft-id uint))
  (ok (is-royalty-set nft-id))
)