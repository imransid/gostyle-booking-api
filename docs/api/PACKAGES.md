# Packages: selling one, at the desk and in the app

A package is a bundle of the services a salon already sells, at one price
("Groom and Go": a cut and a beard trim, AED 370). It comes from the platform
(`ServicesDirectory.ListPackages`, the published snapshot) and is booked as
the services it contains. Nothing about availability, stylists, chairs,
check-in, cancel or reschedule is different for a package: those all see its
parts.

## The one rule that matters: the package price is carried by its parts

When a package is booked, each part is charged a share of the package price,
in proportion to what it costs on its own, and the shares add up to the
package price exactly.

Colour and finish: full colour AED 480 + blow-dry AED 140 = AED 620 apart,
sold together at AED 560.

| Line         | On its own | Charged in the package |
|--------------|-----------:|-----------------------:|
| Full colour  |     480.00 |                 433.55 |
| Blow-dry     |     140.00 |                 126.45 |
| **Package**  | **620.00** |             **560.00** |

So:

- There is **no bundle-discount line**. The package's price *is* the price.
  `discount` is the customer's tier discount only, taken on the package
  price.
- VAT is 5% of (package price − tier discount). Here: AED 28, total AED 588.
- Every reader that adds a booking's lines up charges AED 560: the till, desk
  capture, the payment link, "paid in full", the agenda and the revenue
  figures. (Before 2026-10-18 they charged the parts, AED 620.)
- The deposit is worked out on the package price.
- "You save AED 60" is display only: `savings` / `savingMinor`, never
  subtracted.
- A package dearer than its parts (a branch price override does this) is
  sold at its own price, saving 0.

## Switches

| Where       | Switch                    | Default | Off means |
|-------------|---------------------------|---------|-----------|
| booking-api | `PACKAGES_FROM_PLATFORM`  | off     | a real branch sells no packages |

With it on, booking-api also needs `SERVICES_FROM_PLATFORM=true` (the parts
are platform services), `SKILLS_UNVERIFIED=true`, `PLATFORM_GRPC_ADDR` (prod:
`gostyle_api:50052`), and a tenant on the request (`X-Tenant-Id`, or the staff
token's). A slug branch such as `marina-walk` is the fixture's demo salon and
always sells the three demo packages; a real (uuid) branch never does.

A package is left out of every list, and refused if asked for, when it: is
not published, has online booking off, is not sold at that branch, has a part
the branch does not offer, is priced at 0, is priced in a different currency
from its parts (`BOOKING_CURRENCY_MIXED`), or **pins a service variant**
("Long hair") — booking books services, not their variants, yet.

Only a basket that actually holds an id the catalogue does not know as a
service asks the platform for packages, so a platform outage stops package
bookings and nothing else. Lists are cached per branch for a minute.

## The desk (web)

1. **List** — `GET /v1/packages` (desk only; branch from the usual
   `branchId` / `X-Branch-Id` / token chain):

   ```json
   { "branchId": "…", "count": 1, "packages": [{
       "packageId": "aaaaaaaa-…", "name": "Groom and Go",
       "priceMinor": 37000, "price": "AED 370.00",
       "partsTotalMinor": 40000, "savingMinor": 3000, "saving": "AED 30.00",
       "durationMin": 60,
       "parts": [{ "serviceId": "…", "name": "Haircut", "priceMinor": 18500, "durationMin": 30 }, …]
   }]}
   ```

2. **Sell** — put the `packageId` among `serviceIds` on availability, quote,
   hold, confirm or walk-in, exactly as a service id, alone or next to
   hand-picked services. Send the SAME ids to confirm as to hold.
3. **Quote** — `POST /v1/bookings/quote` answers `subtotalMinor` with the
   package at its price, and `packages[]` with `{ packageId, name,
   serviceIds, priceMinor, price, partsTotalMinor, savingMinor, saving }`.
   `bundleDiscountMinor` is always 0 now; it stays only so a client reading
   it does not break.
4. **Read** — `GET /v1/bookings/:id` gains `packages[]`: `{ packageId, name,
   priceMinor, price, serviceRefs }`, `[]` for hand-picked services. Its
   `items[].priceMinor` are the parts' shares.
5. **Walk-in** — the queue keeps the package as asked for. `POST
   /v1/walk-ins` still answers with the parts; `…/seat` answers with what was
   queued, so the desk's confirm sends the package and it is charged its
   price. Seating reserves a station per part.
6. **Parties** — a participant's `serviceIds` may hold a package on group
   availability, hold and confirm.

## The app (through customer-api)

1. **List** — the Packages tab and Package Details are customer-api's
   (`GET /api/v1/salon/{id}/packages`, `…/package/{id}`), with `can_book`
   behind its `PACKAGE_BOOKING_V1`. booking-api's own `GET
   /v1/mobile-packages?salon_id=<branch>` answers the same packages in the
   app's units (`amount_without_tax` = the package price).
2. **Price it first** — `POST /v1/mobile-booking/quote`:

   ```json
   { "salon_id": "…", "date": "2026-10-20",
     "start_time": "2026-10-20T10:00:00+06:00",
     "services": [{ "id": "<package id>" }] }
   ```

   answers the figures create will check, and what to send back:

   ```json
   { "services": [{ "id": "<package id>", "amount": 560 }],
     "end_time": "…", "duration_min": 170,
     "amount_without_tax": 560, "discount": 0, "tax_amount": 28,
     "total": 588, "advance_paid_amount": 0, "due_amount": 588,
     "deposit_amount": …,
     "parts": [{ "id": "full-colour", "name": "…", "amount": 433.55,
                 "duration_min": 125, "package_id": "<package id>" }, …],
     "packages": [{ "id": "<package id>", "name": "Colour and finish",
                    "amount": 560, "parts_total": 620, "savings": 60,
                    "service_ids": ["full-colour", "blow-dry"] }],
     "products": [] }
   ```

   Holds nothing, writes nothing, needs no stylist.
3. **Create** — `POST /v1/mobile-booking` with the package as a line:
   `"services": [{ "id": "<package id>", "amount": 560 }]` and the quote's
   `amount_without_tax`, `discount`, `tax_amount`, `total`, `due_amount` and
   `end_time`. There is no `package_id` field; one is refused (422).
4. **Read** — create's 201, `GET /v1/mobile-booking/{id}` and the payment
   PATCH carry `packages: [{ id, name, amount, service_ids }]`; each My
   Bookings row `packages: [{ id, name }]`. **The key is present only when the
   booking holds a package**, so every other booking reads exactly as before.
   `services[]` lists the parts at their shares.
5. **Parties** — a member's `services[]` may hold a package line. The money
   is worked out per line: a package is one line at its price, and a child
   pays half of it (rounded once). Parties take no tier or promo discount,
   as before. The party read names a member's packages, only when it has any.
