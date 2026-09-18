# Bookings — List, Read, Update

Base URL: `https://api.gostyle.uk/api/v1`
Auth: Bearer token on every request. Bookings are always the caller's own; the
customer comes from the token, never from a parameter.

| Method  | Path           | Purpose                                   |
| ------- | -------------- | ----------------------------------------- |
| `GET`   | `/bookings`    | Paginated list, filtered — §1             |
| `GET`   | `/booking/:id` | Read one booking — §6                     |
| `PATCH` | `/booking/:id` | Record the payment after the gateway — §7 |

`:id` is always the **booking** id, never a salon id. Creation is
`POST /booking`, specified in `booking-create.md`.

---

## 1. Endpoint

```
GET /bookings?filter=upcoming&page=1&pageSize=20
```

### Query parameters

| Param      | Type | Required | Default    | Notes                                           |
| ---------- | ---- | -------- | ---------- | ----------------------------------------------- |
| `filter`   | enum | no       | `upcoming` | `upcoming`, `recurring`, or `archive` — see §2. |
| `page`     | int  | no       | 1          | 1-based.                                        |
| `pageSize` | int  | no       | 20         | Capped server-side at 50.                       |

---

## 2. The three filters

| `filter`    | Contains                                                                                                   | Order                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `upcoming`  | Single visits whose `start_time` has not passed, still live: `BOOKED`, `CONFIRMED_BY_SALON`, `CHECKED_IN`. | `start_time` ascending — soonest first.      |
| `recurring` | Bookings with `booking_type: "ROUTINE"` that still have a session to come. Not built yet; returns `[]`.    | Next session first.                          |
| `archive`   | Everything finished or dead: past `start_time`, `COMPLETED`, `CANCELLED`, `NO_SHOW`, and expired routines. | `start_time` descending — most recent first. |

Rules:

1. **Every booking belongs to exactly one filter** at any moment, so the three
   lists never double-count.
2. **A routine appears under `recurring`, not `upcoming`**, even though its next
   session is in the future. One row per routine, not one per session.
3. **`DRAFT` payments are not bookings yet.** A checkout still inside its hold
   window (`booking-create.md` §4) appears in none of the three lists, and an
   expired one is simply gone — not archived.
4. **"Past" is measured against the salon's clock**, not the caller's, so a
   booking abroad does not jump to `archive` early.
5. **A cancelled booking moves to `archive` immediately**, whatever its
   `start_time`.

---

## 3. Response — `200 OK`

```json
{
  "count": 14,
  "next": "https://api.gostyle.uk/api/v1/bookings?filter=upcoming&page=2",
  "previous": null,
  "counts": { "upcoming": 3, "recurring": 1, "archive": 10 },
  "results": [
    {
      "id": "bkg_01j9m2k",
      "status": "CONFIRMED_BY_SALON",
      "payment_status": "FULLY_PAID",
      "booking_type": "SINGLE",
      "date": "2026-09-20",
      "start_time": "2026-09-20T20:00:00+04:00",
      "end_time": "2026-09-20T20:45:00+04:00",
      "salon": {
        "id": "sal_01j8xk2e9",
        "name": "The Iron Razor Barbershop",
        "logo_url": "https://cdn.gostyles.app/salons/sal_01j8xk2e9/logo.png",
        "city": "Dubai"
      },
      "services": [
        { "id": "svc_fade", "name": "Signature Fade" },
        { "id": "svc_beard", "name": "Beard Trim" }
      ],
      "stylists": [
        {
          "id": "sty_liam",
          "name": "Liam Johnson",
          "avatar_url": "https://cdn.gostyles.app/stylists/sty_liam.png"
        }
      ],
      "total": 216.25,
      "due_amount": 0,
      "can_cancel": true,
      "can_reschedule": true,
      "created_at": "2026-09-18T14:02:11+04:00"
    }
  ]
}
```

### Fields

| Field               | Type           | Required | Notes                                                                                    |
| ------------------- | -------------- | -------- | ---------------------------------------------------------------------------------------- |
| `count`             | number         | yes      | Total rows matching `filter`, not the page size.                                         |
| `next` / `previous` | string \| null | yes      | Absolute page URLs, as in `/discover`.                                                   |
| `counts`            | object         | no       | Totals for all three filters in one call, so tab badges need no extra requests.          |
| `results`           | array          | yes      | The page. Empty array is valid.                                                          |
| `↳ id`              | string         | yes      | Booking id, as used by `GET /booking/:id`.                                               |
| `↳ status`          | enum           | yes      | `BOOKED`, `CONFIRMED_BY_SALON`, `CHECKED_IN`, `COMPLETED`, `CANCELLED`, `NO_SHOW`.       |
| `↳ payment_status`  | enum           | yes      | As in `booking-create.md` §4.                                                            |
| `↳ booking_type`    | enum           | yes      | `SINGLE` or `ROUTINE`.                                                                   |
| `↳ date`            | string         | yes      | `YYYY-MM-DD`, salon-local.                                                               |
| `↳ start_time`      | string         | yes      | ISO 8601 with the salon's offset. For a routine, its **next** session.                   |
| `↳ end_time`        | string         | yes      | ISO 8601 with the salon's offset.                                                        |
| `↳ salon`           | object         | yes      | `{ id, name, logo_url, city }` — enough to render a row without a second call.           |
| `↳ services`        | array          | yes      | `{ id, name }` per service, in booked order.                                             |
| `↳ stylists`        | array          | yes      | `{ id, name, avatar_url }`. Empty when the salon assigns on the day.                     |
| `↳ total`           | number         | yes      | What the visit costs in the salon's currency.                                            |
| `↳ due_amount`      | number         | yes      | Still to pay at the salon. `0` when settled.                                             |
| `↳ can_cancel`      | boolean        | yes      | Whether the salon's policy still allows cancelling — the server decides, not the caller. |
| `↳ can_reschedule`  | boolean        | yes      | Same, for moving the booking.                                                            |
| `↳ created_at`      | string         | yes      | ISO 8601.                                                                                |

Rows are summaries. The full booking — products, tax breakdown, promo, QR pass —
comes from `GET /booking/:id`.

---

## 5. Errors

Same envelope as `auth-error-response.md`. Only a malformed request fails; an
empty list is a `200` with `"results": []`.

| Case                             | Status | `code`           |
| -------------------------------- | ------ | ---------------- |
| `filter` is not one of the three | 422    | `invalid_filter` |
| `page` beyond the last page      | 200    | — (empty array)  |
| No bookings at all               | 200    | — (empty array)  |

---

## 6. Read one booking — `GET /booking/:id`

Returns the whole booking, whatever state it is in, so the confirmation screen,
the pass and the booking history all read one shape. Implemented as
`GET /v1/mobile-booking/:id`; the shape is `booking-create.md` §8.

Rules:

1. **Only the customer who owns it**, or staff of the salon it belongs to.
   Anyone else gets `404` / `not_found`, not `403` — an outsider should not be
   able to learn that a booking id exists.
2. **No query parameters.** Everything the booking has is always returned;
   services, products and stylists come expanded, never as bare ids.
3. **`DRAFT` bookings are readable**, so an interrupted checkout can be resumed.
   Include `expires_at` while the draft hold is still running, and drop it once
   the booking is paid.
4. **Money is echoed, never recomputed here.** This endpoint reports what was
   agreed at creation; `booking-create.md` §3 is where figures are decided.

| Case                                         | Status | `code`      |
| -------------------------------------------- | ------ | ----------- |
| Booking id does not exist                    | 404    | `not_found` |
| Booking belongs to nobody the caller may see | 404    | `not_found` |

---

## 7. Record the payment — `PATCH /booking/:id`

See `booking-create.md` §11, which is the live specification for this call.

> **OUT OF DATE HERE.** Two things in this section no longer describe the
> server, as of `ed718e2`:
>
> - Rule 1 says a booking is only patched from `DRAFT`. That is still true, but
>   it now also excludes `PAY_AFTER_CHECK_IN`, which is settable **on create**
>   (`booking-create.md` §4) and is not a draft. Patching one returns `409` /
>   `already_paid`.
> - Money for a `PAY_AFTER_CHECK_IN` booking is taken at the desk through
>   `POST /v1/bookings/:id/capture`, not through this endpoint. A card machine
>   at check-in has no gateway `payment_reference` to send.
>
> `booking-create.md` §11 carries the current rules and the reasoning.

---

## 8. Order of calls

```
POST  /booking        →  payment_status: DRAFT, slot held
  ↓ gateway authorises
PATCH /booking/:id    →  FULLY_PAID | PARTIALLY
  ↓
GET   /booking/:id    →  confirmation screen, pass, history
GET   /bookings       →  upcoming / recurring / archive
```

A booking that never reaches the PATCH stays `DRAFT` and is released when its
hold expires, so it appears in none of the three lists.

A `PAY_AFTER_CHECK_IN` booking skips the PATCH entirely: it is confirmed at
creation and pays at the desk.

---

## 9. What this server does not return yet

Two fields in §3 are specified and **not implemented**, each because the data
does not exist in any service this one can reach.

| Field                          | Why it is missing                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `salon`                        | A booking stores `branch_id` and nothing else. No proto exposes a branch's name, logo or city, so the object could only be faked. Needs a platform ask. |
| `can_cancel` / `can_reschedule` | Both are answers to the salon's cancellation policy, which lives in platform and is not exposed. A hardcoded `true` would be a promise this server cannot keep. |

`salon_id` is returned in `GET /booking/:id`, so the app can resolve the salon
itself in the meantime. See `api/PLATFORM-ASKS-BOOKING-CONTEXT.md`.
