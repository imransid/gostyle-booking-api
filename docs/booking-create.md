# Booking — Create

Base URL: `https://api.gostyle.uk/api/v1`
Auth: Bearer token on every request. The customer is taken from the token, never
from the payload.

Creates one booking at one salon: the services, the products sold with it, the
stylists, the time, and the money.

A booking is created with `payment_status: "DRAFT"` and becomes payable only
once the payment gateway answers, which is recorded with the PATCH in §11.

---

## 1. Endpoint

```
POST /booking
```

The salon is named in the payload, not the path. `:id` in the other two
endpoints is always a **booking** id:

| Method  | Path           | Purpose                  |
| ------- | -------------- | ------------------------ |
| `POST`  | `/booking`     | Create — §2              |
| `GET`   | `/booking/:id` | Read one booking — §10   |
| `PATCH` | `/booking/:id` | Record the payment — §11 |

---

## 2. Payload

```json
{
  "salon_id": "sal_01j8xk2e9",
  "services": [
    { "id": "svc_fade", "amount": 120 },
    { "id": "svc_beard", "amount": 60 }
  ],
  "products": [{ "id": "prd_pomade", "amount": 45 }],
  "stylists": ["sty_liam"],
  "date": "2026-09-20",
  "start_time": "2026-09-20T20:00:00+04:00",
  "end_time": "2026-09-20T20:45:00+04:00",
  "amount_without_tax": 225,
  "tax_amount": 11.25,
  "discount": 20,
  "promo_code": "GOSTYLE20",
  "total": 216.25,
  "advance_paid_amount": 0,
  "due_amount": 216.25,
  "payment_status": "DRAFT",
  "status": "BOOKED",
  "booking_type": "SINGLE"
}
```

### Fields

| Field                 | Type     | Required | Notes                                                                            |
| --------------------- | -------- | -------- | -------------------------------------------------------------------------------- |
| `salon_id`            | string   | yes      | Salon the visit is at. Every id below must belong to it.                         |
| `services`            | array    | yes      | At least one entry. Order is the order the customer picked them in; keep it.     |
| `↳ id`                | string   | yes      | Service id, must belong to `salon_id`.                                           |
| `↳ amount`            | number   | yes      | Unit price the client showed for this service. Verified — see §3.                |
| `products`            | array    | no       | Items sold alongside the visit. `[]` or omitted when none.                       |
| `↳ id`                | string   | yes      | Product id, must belong to `salon_id`.                                           |
| `↳ amount`            | number   | yes      | Unit price the client showed for this product. Verified — see §3.                |
| `stylists`            | string[] | yes      | Stylist ids performing the visit. `[]` means the salon assigns — see §5.         |
| `date`                | string   | yes      | Visit date, `YYYY-MM-DD`, salon-local. Must equal the date part of `start_time`. |
| `start_time`          | string   | yes      | ISO 8601 with offset. Must be one of the starts this salon actually offers.      |
| `end_time`            | string   | yes      | ISO 8601 with offset. Verified against the services' duration plus padding.      |
| `amount_without_tax`  | number   | yes      | Sum of service and product amounts, before tax and discount.                     |
| `tax_amount`          | number   | yes      | Tax on the taxable base.                                                         |
| `discount`            | number   | yes      | Total discount applied. `0` when none.                                           |
| `promo_code`          | string   | no       | The code that produced `discount`. Omit or `null` when none.                     |
| `total`               | number   | yes      | What the customer owes in the end.                                               |
| `advance_paid_amount` | number   | yes      | Always `0` on create — nothing is paid until the gateway answers.                |
| `due_amount`          | number   | yes      | `total - advance_paid_amount`, so equal to `total` on create.                    |
| `payment_status`      | enum     | yes      | Only `DRAFT` may be sent — see §4.                                               |
| `payment_method`      | enum     | no       | `WALLET`, `CARD`, `GOOGLE`, `APPLE`, `OTHERS`. Sent with the PATCH, not here.    |
| `status`              | enum     | yes      | Only `BOOKED` may be sent — see §4.                                              |
| `booking_type`        | enum     | yes      | `SINGLE` for one visit, `ROUTINE` for a recurring plan.                          |

All money is in the salon's currency, as decimal numbers with at most two
decimal places. `pass_qr_code` is **not** in the payload — the server issues it,
see §6.

---

## 3. Money is verified, never trusted

Every amount in the payload is what the client displayed. The server recomputes
all of it from its own prices, tax rules, and promo rules, and compares:

1. Look up each `services[].id` and `products[].id` at `salon_id` and take the
   current price.
2. Recompute `amount_without_tax`, `discount` (applying `promo_code` under its
   own rules), `tax_amount`, `total`, and `due_amount`.
3. Compare against the payload, allowing a rounding tolerance of one minor unit
   (0.01).
4. On any mismatch, reject with `422` / `amount_mismatch` and return the correct
   figures in the error, so the caller can show the customer what changed rather
   than silently charging a different number.

Never persist the client's figures. A stale price, an expired promo, or a
tampered payload must all fail the same way.

---

## 4. `status` and `payment_status` on create

| Value                | Who sets it                                     |
| -------------------- | ----------------------------------------------- |
| `BOOKED`             | The client, on create. The only accepted value. |
| `CONFIRMED_BY_SALON` | The salon, later, through its own endpoint.     |
| `CHECKED_IN`         | The salon or the check-in flow, on the day.     |

Any other value on create is `422` / `invalid_status`. The field is accepted in
the payload only so the contract stays explicit; the server may equally ignore
it and always store `BOOKED`.

`payment_status` starts at `DRAFT` and moves on only through §11:

| Value                | Meaning                                                      |
| -------------------- | ------------------------------------------------------------ |
| `DRAFT`              | Created, nothing settled. The only value accepted on create. |
| `PARTIALLY`          | Deposit taken, the rest due at the salon.                    |
| `FULLY_PAID`         | Settled in full.                                             |
| `PAY_AFTER_CHECK_IN` | Nothing to pay now by arrangement; due at the salon.         |

Any other value on create is `422` / `invalid_payment_status`.

**A `DRAFT` booking holds its slot, so it must not hold it forever.** Give the
draft a hold window — 15 minutes is typical — after which an unpaid draft is
released and the slot returns to `booking-nearest-available.md`. Without that,
every abandoned checkout silently removes a slot from sale.

---

## 5. Stylists

- **One id** — that stylist performs the whole visit.
- **Several ids** — a split visit: one stylist per service, in the same order as
  `services`. The array must then be the same length as `services`.
- **Empty** — no named stylist; the salon assigns a qualified one at confirm.
  Only allowed when the salon permits it.

Every named stylist is re-validated: they work at `salon_id`, they hold every
skill their service requires (same match as `booking-expert-list.md`), and they
are free for `start_time`–`end_time`. A failure here is `422` /
`stylist_missing_skill` or `422` / `stylist_unavailable`, never a silent
reassignment.

---

## 6. `pass_qr_code`

The server generates it and returns it on the created booking. A client-supplied
value is ignored, because a code the client can choose is a code anyone can
forge — the pass is what proves the booking at the door.

---

## 7. Double submits

A booking is money. Retrying the same request must not create two.

Accept an `Idempotency-Key` header holding a value the client generates once per
attempt. The first request with a given key creates the booking; every later
request with the same key returns that same booking and does not create another.
Keys are scoped to the customer and expire after 24 hours.

Without this, a flaky connection during payment silently double-books.

---

## 8. Response — `201 Created`

The created booking, as the app will re-read it later.

```json
{
  "id": "bkg_01j9m2k",
  "salon_id": "sal_01j8xk2e9",
  "status": "BOOKED",
  "date": "2026-09-20",
  "start_time": "2026-09-20T20:00:00+04:00",
  "end_time": "2026-09-20T20:45:00+04:00",
  "services": [
    { "id": "svc_fade", "name": "Signature Fade", "amount": 120 },
    { "id": "svc_beard", "name": "Beard Trim", "amount": 60 }
  ],
  "products": [{ "id": "prd_pomade", "name": "Matte Pomade", "amount": 45 }],
  "stylists": [
    {
      "id": "sty_liam",
      "name": "Liam Johnson",
      "avatar_url": "https://cdn.gostyles.app/stylists/sty_liam.png"
    }
  ],
  "amount_without_tax": 225,
  "tax_amount": 11.25,
  "discount": 20,
  "promo_code": "GOSTYLE20",
  "total": 216.25,
  "advance_paid_amount": 0,
  "due_amount": 216.25,
  "payment_status": "DRAFT",
  "payment_method": null,
  "pass_qr_code": "GS-BKG-01J9M2K-8F3A",
  "created_at": "2026-09-18T14:02:11+04:00"
}
```

Stylists and services come back expanded with names and avatars, so the
confirmation screen needs no follow-up call.

---

## 9. Errors

Same envelope as `auth-error-response.md`.

| Case                                             | Status | `code`                   |
| ------------------------------------------------ | ------ | ------------------------ |
| `services` empty                                 | 422    | `no_services`            |
| Service or product not sold by this salon        | 422    | `unknown_service`        |
| Amounts do not match the server's calculation    | 422    | `amount_mismatch`        |
| Promo code unknown, expired, or not applicable   | 422    | `invalid_promo`          |
| `status` is not `BOOKED`                         | 422    | `invalid_status`         |
| `payment_status` is not `DRAFT` on create        | 422    | `invalid_payment_status` |
| `stylists` length does not match `services`      | 422    | `invalid_stylists`       |
| Stylist cannot perform their service             | 422    | `stylist_missing_skill`  |
| Stylist is not free at that time                 | 422    | `stylist_unavailable`    |
| `date` is not the date of `start_time`           | 422    | `date_mismatch`          |
| `end_time` disagrees with the services' duration | 422    | `invalid_window`         |
| The slot was taken between search and submit     | 409    | `slot_taken`             |
| Salon id does not exist                          | 404    | `not_found`              |

`slot_taken` is the one to get right: it is a race, not a mistake, and it needs
its own code so the caller can send the customer back to pick another start
instead of showing a validation error.

```json
{
  "detail": "Please correct the highlighted fields.",
  "code": "validation_error",
  "errors": [
    {
      "field": "total",
      "code": "amount_mismatch",
      "message": "Prices changed since this booking was started.",
      "expected": 236.25
    }
  ]
}
```

---

## 10. Reading a booking — `GET /booking/:id`

```
GET /booking/:id
```

`:id` is the booking id. Returns exactly the object of §8, whatever state the
booking is in, so the confirmation screen, the pass, and the booking history all
read the same shape.

Rules:

1. **Only the customer who owns it**, or staff of the salon it belongs to.
   Anyone else gets `404` / `not_found`, not `403` — an outsider should not be
   able to learn that a booking id exists.
2. **No query parameters.** Everything the booking has is always returned;
   services, products and stylists come expanded as in §8.
3. **`DRAFT` bookings are readable too**, so an interrupted checkout can be
   resumed. Include `expires_at` while the draft hold is still running, and drop
   it once the booking is paid.

| Case                                         | Status | `code`      |
| -------------------------------------------- | ------ | ----------- |
| Booking id does not exist                    | 404    | `not_found` |
| Booking belongs to nobody the caller may see | 404    | `not_found` |

---

## 11. Recording the payment — `PATCH /booking/:id`

Called once the gateway answers. Nothing else about the booking changes here.
`:id` is the booking id.

```
PATCH /booking/:id
```

```json
{
  "payment_status": "PARTIALLY",
  "payment_method": "CARD",
  "advance_paid_amount": 54.07,
  "due_amount": 162.18,
  "payment_reference": "pi_3Qk2xLJ8n"
}
```

| Field                 | Type   | Required | Notes                                                                                |
| --------------------- | ------ | -------- | ------------------------------------------------------------------------------------ |
| `payment_status`      | enum   | yes      | `PARTIALLY`, `FULLY_PAID`, or `PAY_AFTER_CHECK_IN`. Never back to `DRAFT`.           |
| `payment_method`      | enum   | cond.    | `WALLET`, `CARD`, `GOOGLE`, `APPLE`, `OTHERS`. Required unless `PAY_AFTER_CHECK_IN`. |
| `advance_paid_amount` | number | yes      | What the gateway actually took. `0` for `PAY_AFTER_CHECK_IN`.                        |
| `due_amount`          | number | no       | Derived as `total - advance_paid_amount`; verified when sent.                        |
| `payment_reference`   | string | cond.    | The gateway's own id for the charge. Required whenever money moved.                  |

Rules:

1. **Only from `DRAFT`.** A booking already `PARTIALLY` or `FULLY_PAID` is not
   patched again — `409` / `already_paid`. Refunds and top-ups are their own
   endpoints, not this one.
2. **The amount is checked against the booking**, not accepted on trust:
   `advance_paid_amount` must be at most `total`, and must equal `total` when
   `payment_status` is `FULLY_PAID`. A deposit must satisfy the salon's deposit
   rule.
3. **`payment_reference` is unique.** The same reference patched twice returns
   the same booking rather than recording a second payment — the same
   idempotency this flow needs in §7.
4. **Clearing the hold.** A successful patch takes the booking out of the draft
   hold window; the slot is now firmly booked.
5. **A failed payment is not a patch.** Leave the booking in `DRAFT` and let the
   hold expire, or delete it outright. Do not invent a `FAILED` payment status
   that the rest of the app then has to handle.
6. **Totals are immutable here.** `total`, `tax_amount`, `discount`, services
   and products cannot change on this call. A different price means a new
   booking.

Responds `200 OK` with the full booking, in the same shape as §8.

Errors, on top of the shared envelope:

| Case                                         | Status | `code`                      |
| -------------------------------------------- | ------ | --------------------------- |
| Booking is not in `DRAFT`                    | 409    | `already_paid`              |
| `payment_status` sent as `DRAFT`             | 422    | `invalid_payment_status`    |
| `advance_paid_amount` disagrees with `total` | 422    | `amount_mismatch`           |
| Deposit below the salon's minimum            | 422    | `deposit_too_low`           |
| `payment_reference` missing when money moved | 422    | `missing_payment_reference` |
| Booking id does not exist                    | 404    | `not_found`                 |
| The draft hold already expired               | 409    | `booking_expired`           |

---

## 12. Open points

1. **`date` duplicates `start_time`.** Both are sent, so both must always
   agree; the server rejects a payload where they disagree rather than guessing
   which one is right. Dropping `date` later would remove a whole class of bug,
   but nothing breaks while both are validated.
2. **`stylists` as a flat array only works positionally.** For a split visit it
   relies on the array lining up with `services` index by index, which is easy
   to get wrong on either side. A `stylist_id` inside each `services` entry says
   the same thing unambiguously, and `stylists` then disappears.
3. **`PARTIALLY` reads as an adverb.** `PARTIALLY_PAID` matches `FULLY_PAID`.
   Worth fixing before anything depends on the string.
4. **`due_amount` is derivable** from `total - advance_paid_amount` and is
   verified anyway, so it could be dropped from the payload.
