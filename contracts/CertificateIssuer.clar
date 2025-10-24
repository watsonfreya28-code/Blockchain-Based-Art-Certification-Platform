(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-INVALID-ARTIST u101)
(define-constant ERR-INVALID-METADATA u102)
(define-constant ERR-INVALID-HASH u103)
(define-constant ERR-CERT-NOT-FOUND u104)
(define-constant ERR-CERT-ALREADY-ISSUED u105)
(define-constant ERR-INVALID-STATUS u106)
(define-constant ERR-INVALID-TIMESTAMP u107)
(define-constant ERR-INVALID-FEE u108)
(define-constant ERR-INVALID-AUTHORITY u109)
(define-constant ERR-MAX-CERTS-EXCEEDED u110)

(define-data-var cert-counter uint u0)
(define-data-var max-certs uint u100000)
(define-data-var issuance-fee uint u500)
(define-data-var authority-contract (optional principal) none)
(define-data-var platform-fee-rate uint u250)

(define-map certificates 
  uint 
  { 
    artist: principal,
    artwork-hash: (buff 32),
    metadata: (string-utf8 512),
    issued-at: uint,
    status: (string-ascii 20),
    revoked-at: (optional uint),
    cert-uri: (string-ascii 256)
  }
)

(define-map certs-by-hash 
  (buff 32) 
  uint
)

(define-map cert-transfers 
  uint 
  (list 50 { 
    from: principal, 
    to: principal, 
    timestamp: uint 
  })
)

(define-read-only (get-certificate (cert-id uint))
  (map-get? certificates cert-id)
)

(define-read-only (get-cert-by-hash (hash (buff 32)))
  (map-get? certs-by-hash hash)
)

(define-read-only (get-cert-transfers (cert-id uint))
  (map-get? cert-transfers cert-id)
)

(define-read-only (get-cert-count)
  (ok (var-get cert-counter))
)

(define-private (validate-artist (artist principal))
  (if (is-eq artist tx-sender)
      (ok true)
      (err ERR-INVALID-ARTIST))
)

(define-private (validate-metadata (metadata (string-utf8 512)))
  (if (and (> (len metadata) u0) (<= (len metadata) u512))
      (ok true)
      (err ERR-INVALID-METADATA))
)

(define-private (validate-hash (hash (buff 32)))
  (if (is-eq (len hash) u32)
      (ok true)
      (err ERR-INVALID-HASH))
)

(define-private (validate-status (status (string-ascii 20)))
  (if (or (is-eq status "active") (is-eq status "revoked"))
      (ok true)
      (err ERR-INVALID-STATUS))
)

(define-private (validate-timestamp (ts uint))
  (if (>= ts block-height)
      (ok true)
      (err ERR-INVALID-TIMESTAMP))
)

(define-private (validate-principal (p principal))
  (if (not (is-eq p 'SP000000000000000000002Q6VF78))
      (ok true)
      (err ERR-INVALID-AUTHORITY))
)

(define-public (set-authority-contract (contract-principal principal))
  (begin
    (try! (validate-principal contract-principal))
    (asserts! (is-none (var-get authority-contract)) (err ERR-INVALID-AUTHORITY))
    (var-set authority-contract (some contract-principal))
    (ok true)
  )
)

(define-public (set-issuance-fee (new-fee uint))
  (begin
    (asserts! (>= new-fee u0) (err ERR-INVALID-FEE))
    (asserts! (is-some (var-get authority-contract)) (err ERR-INVALID-AUTHORITY))
    (var-set issuance-fee new-fee)
    (ok true)
  )
)

(define-public (set-platform-fee-rate (new-rate uint))
  (begin
    (asserts! (<= new-rate u1000) (err ERR-INVALID-FEE))
    (asserts! (is-some (var-get authority-contract)) (err ERR-INVALID-AUTHORITY))
    (var-set platform-fee-rate new-rate)
    (ok true)
  )
)

(define-public (issue-certificate 
  (artwork-hash (buff 32)) 
  (metadata (string-utf8 512))
  (cert-uri (string-ascii 256))
)
  (let (
      (cert-id (var-get cert-counter))
      (authority (var-get authority-contract))
    )
    (asserts! (< cert-id (var-get max-certs)) (err ERR-MAX-CERTS-EXCEEDED))
    (try! (validate-artist tx-sender))
    (try! (validate-hash artwork-hash))
    (try! (validate-metadata metadata))
    (asserts! (is-none (map-get? certs-by-hash artwork-hash)) (err ERR-CERT-ALREADY-ISSUED))
    (asserts! (is-some authority) (err ERR-INVALID-AUTHORITY))
    (try! (stx-transfer? (var-get issuance-fee) tx-sender (unwrap! authority (err ERR-INVALID-AUTHORITY))))
    (map-set certificates cert-id 
      { 
        artist: tx-sender,
        artwork-hash: artwork-hash,
        metadata: metadata,
        issued-at: block-height,
        status: "active",
        revoked-at: none,
        cert-uri: cert-uri
      }
    )
    (map-set certs-by-hash artwork-hash cert-id)
    (map-set cert-transfers cert-id (list))
    (var-set cert-counter (+ cert-id u1))
    (print { event: "certificate-issued", id: cert-id, artist: tx-sender })
    (ok cert-id)
  )
)

(define-public (revoke-certificate (cert-id uint))
  (let ((cert (unwrap! (map-get? certificates cert-id) (err ERR-CERT-NOT-FOUND))))
    (asserts! (is-eq (get artist cert) tx-sender) (err ERR-NOT-AUTHORIZED))
    (asserts! (is-eq (get status cert) "active") (err ERR-INVALID-STATUS))
    (map-set certificates cert-id 
      (merge cert { 
        status: "revoked",
        revoked-at: (some block-height)
      })
    )
    (print { event: "certificate-revoked", id: cert-id })
    (ok true)
  )
)

(define-public (transfer-certificate (cert-id uint) (recipient principal))
  (let ((cert (unwrap! (map-get? certificates cert-id) (err ERR-CERT-NOT-FOUND))))
    (asserts! (is-eq (get status cert) "active") (err ERR-INVALID-STATUS))
    (asserts! (not (is-eq recipient tx-sender)) (err ERR-NOT-AUTHORIZED))
    (let ((transfers (default-to (list) (map-get? cert-transfers cert-id))))
      (map-set cert-transfers cert-id 
        (unwrap! (as-max-len? 
          (append transfers { from: tx-sender, to: recipient, timestamp: block-height }) 
          u50
        ) (err ERR-MAX-CERTS-EXCEEDED))
      )
      (print { event: "certificate-transferred", id: cert-id, to: recipient })
      (ok true)
    )
  )
)

(define-public (verify-certificate (cert-id uint))
  (let ((cert (map-get? certificates cert-id)))
    (match cert
      c (ok (is-eq (get status c) "active"))
      (err ERR-CERT-NOT-FOUND)
    )
  )
)

(define-public (set-max-certs (new-max uint))
  (begin
    (asserts! (> new-max u0) (err ERR-MAX-CERTS-EXCEEDED))
    (asserts! (is-some (var-get authority-contract)) (err ERR-INVALID-AUTHORITY))
    (var-set max-certs new-max)
    (ok true)
  )
)