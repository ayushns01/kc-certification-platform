# API Walkthrough — Kalachain Certification Platform

All requests below assume the server is running locally (`npm run dev` from `backend/`).  
Admin endpoints require the header `x-api-key: demo-key`.

---

## Phase 1 — Participation Certificate

### 1. Register a participant

```bash
curl -s -X POST http://localhost:3000/api/registrations \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice Kumar","email":"alice@example.com","workshopId":"ws-101"}'
```

**Response**

```json
{"id":"reg_<id>","state":"REGISTERED"}
```

Save the `id` — you'll use it in every subsequent step.

---

### 2. Mark payment verified (admin)

```bash
curl -s -X POST http://localhost:3000/api/admin/registrations/<regId>/payment \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: demo-key' \
  -d '{"paymentRef":"UPI-123","verifiedBy":"admin"}'
```

**Response**

```json
{"state":"PAYMENT_VERIFIED"}
```

---

### 3. Approve → auto-mint certificate (admin)

This submits a transaction to the Amoy testnet. Expect 10–30 s.

```bash
curl -s -X POST http://localhost:3000/api/admin/registrations/<regId>/approve \
  -H 'x-api-key: demo-key'
```

**Response**

```json
{
  "state": "CERT_MINTED",
  "certificate": {
    "certId": "cert_<certId>",
    "tokenId": 3,
    "txHash": "0x...",
    "verificationUrl": "/verify/cert_<certId>",
    "emailStatus": "PENDING"
  }
}
```

Save the `certId` for verification.

---

### 4. Dispatch certificate email (admin, manual trigger)

```bash
curl -s -X POST http://localhost:3000/api/admin/emails/dispatch \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: demo-key' \
  -d '{"registrationId":"<regId>"}'
```

**Response**

```json
{"sent":1,"skipped":0,"failed":0}
```

---

### 5. Verify certificate on-chain

```bash
curl -s http://localhost:3000/verify/<certId>
```

**Response (valid)**

```json
{
  "verdict": "VALID",
  "certId": "cert_<certId>",
  "certType": "PARTICIPATION",
  "participantName": "Alice Kumar",
  "eventName": "Bharatanatyam Foundations Workshop",
  "tokenId": 3,
  "txHash": "0x...",
  "onChainHash": "0x...",
  "storedHash": "0x...",
  "hashMatch": true
}
```

---

## Phase 2 — Evaluation Certificate

### 1. Register for a Phase 2 workshop

```bash
curl -s -X POST http://localhost:3000/api/registrations \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ravi Shankar","email":"ravi@example.com","workshopId":"ws-201"}'
```

Save the returned `id`.

---

### 2. Submit performance recording

```bash
curl -s -X POST http://localhost:3000/api/submissions \
  -H 'Content-Type: application/json' \
  -d '{
    "registrationId": "<regId>",
    "recordingUrl": "https://cdn.example.com/recordings/ravi.mp4"
  }'
```

**Response**

```json
{"id":"sub_<subId>","state":"SUBMITTED"}
```

Save the `id` as `<subId>`.

---

### 3. Evaluate the submission (admin)

Marks must sum to ≤ 100. Grade is derived automatically: A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, F below 40.

```bash
curl -s -X POST http://localhost:3000/api/admin/submissions/<subId>/evaluate \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: demo-key' \
  -d '{
    "evaluatorName": "Guru Meenakshi",
    "marks": 87,
    "parameters": {
      "rhythm": 9,
      "expression": 8,
      "technique": 9,
      "repertoire": 8
    },
    "comments": "Strong laya control; abhinaya can deepen.",
    "audioFeedbackUrl": "https://cdn.example.com/feedback/ravi.mp3"
  }'
```

**Response**

```json
{"state":"EVALUATED","grade":"A"}
```

---

### 4. Finalize → mint evaluation certificate (admin)

```bash
curl -s -X POST http://localhost:3000/api/admin/submissions/<subId>/finalize \
  -H 'x-api-key: demo-key'
```

**Response**

```json
{
  "state": "FINALIZED",
  "certificate": {
    "certId": "cert_<certId>",
    "tokenId": 4,
    "txHash": "0x...",
    "verificationUrl": "/verify/cert_<certId>"
  }
}
```

---

### 5. Verify evaluation certificate on-chain

```bash
curl -s http://localhost:3000/verify/<certId>
```

**Response (valid)**

```json
{
  "verdict": "VALID",
  "certId": "cert_<certId>",
  "certType": "EVALUATION",
  "participantName": "Ravi Shankar",
  "eventName": "Carnatic Vocal Evaluation Intensive",
  "evaluatorName": "Guru Meenakshi",
  "marks": 87,
  "grade": "A",
  "parameters": {"rhythm":9,"expression":8,"technique":9,"repertoire":8},
  "comments": "Strong laya control; abhinaya can deepen.",
  "audioFeedbackUrl": "https://cdn.example.com/feedback/ravi.mp3",
  "tokenId": 4,
  "txHash": "0x...",
  "hashMatch": true
}
```

---

## Already-minted certificates (live on Amoy)

| Participant | Type | certId | Token |
|---|---|---|---|
| Meera Iyer | Evaluation | `cert_24d1a7be10d4257d05a5e9de` | 2 |
| John Doe | Participation | `cert_bcc97c1f9e6614a889f8a9d0` | 1 |
| ayush | Participation | `cert_870958b748f1dda29f7a2ef2` | 2 |

```bash
curl -s http://localhost:3000/verify/cert_24d1a7be10d4257d05a5e9de
curl -s http://localhost:3000/verify/cert_bcc97c1f9e6614a889f8a9d0
curl -s http://localhost:3000/verify/cert_870958b748f1dda29f7a2ef2
```

---

## Negative / edge-case paths

**Tamper detection** — edit the stored metadata hash then verify:

```bash
curl -s http://localhost:3000/verify/<certId>
# verdict: "TAMPERED"
```

**Duplicate registration** returns 409:

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/registrations \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice Kumar","email":"alice@example.com","workshopId":"ws-101"}'
# 409
```

**Wrong API key** returns 401:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:3000/api/admin/registrations/<regId>/approve \
  -H 'x-api-key: wrong-key'
# 401
```

**Approve before payment** returns 409 with `currentState: "REGISTERED"`.

---

## Workshop IDs (seeded)

| ID | Name | Phase |
|---|---|---|
| `ws-101` | Bharatanatyam Foundations Workshop | 1 |
| `ws-201` | Carnatic Vocal Evaluation Intensive | 2 |
