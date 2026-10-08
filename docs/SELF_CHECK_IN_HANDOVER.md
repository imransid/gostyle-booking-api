# Self check-in: handover

Branch `feat/self-check-in`, ten commits on top of `c79799a`. booking-api only.
State on 2026-10-08: built and tested, not pushed, not deployed.

The idea: a customer says "I am here" for their own booking. The desk approves
or rejects. Approving is the ordinary desk check-in, so the state machine, the
history and the events are unchanged. A customer who said they arrived is never
marked a no-show automatically. Whether the customer scans a QR on their pass or
on the chair is not decided, so nothing here knows about QR or chairs.

## The ten commits

1. `bf54802` The scope rule, lookup and helper: who may act on which booking. Copied unchanged from the parked staff scope branch. Not wired to any older route.
2. `32783d2` The request rules: five states (waiting, approved, rejected, expired, closed), when a customer may raise one, how an unanswered one ends.
3. `430abf8` The `check_in_request` table, one additive migration. The database itself refuses bad rows, and a proof script makes each check fail on purpose.
4. `daeb580` Formatting only, on commit 2.
5. `c7aa333` Raising a request (inside the booking's row lock), and a job that ends unanswered requests every minute.
6. `1547102` The auto no-show sweeper leaves a booking alone when the customer said they arrived: filtered in its query, and checked again inside the row lock.
7. `b192066` A read-only SQL file comparing the sweeper's query plan before and after. Run on production 2026-10-08: passed.
8. `89d9b25` The customer's two routes: raise a request, and read the latest one.
9. `f58f0c7` An "always on" option for the scope helper. Every self check-in route uses it.
10. `b394df4` The desk's approve and reject, and the reception list.

## Turning it on in production

Do these in order.

1. **Make sure bookings carry their tenant.** The backfill ran on 2026-10-08. But the nightly desk series job still writes bookings with no tenant. Its fix (`fix/series-job-tenant`, flag `SERIES_JOB_TENANT`) is not deployed. The desk cannot see or approve a request on a booking with no tenant: it is hidden from the list, and approve answers 404. So deploy that fix with `SERIES_JOB_TENANT=true` first. At the least, re-run the staff scope step 0 SQL the day before and backfill what it finds.
2. **Deploy this branch with `SELF_CHECK_IN_V1` unset**, and apply the migration as usual. Nothing changes for anyone. All five routes answer 404. The new sweeper filter and the lapse job run, but have nothing to act on.
3. **Check the boot log** for both lines listed under "What to watch in the log".
4. **Ship the pieces that are not built yet:** the customer-api route (PR 4) and the business web screens. Until then nobody can raise a request, so the flag would change nothing visible.
5. **Set `SELF_CHECK_IN_V1=true`** on booking-api and restart it. Anything other than `true` is off. Then turn on customer-api's own flag (PR 4).

**`STAFF_SCOPE_V1`:** leave it as it is now (unset). Nothing on this branch depends on it. The self check-in routes check scope always, whatever it says. The older routes are not wired to the helper on this branch; that is the parked staff scope work.

## The first morning

**The customer** (once PR 4 and the app screen exist)
- From 30 minutes before the start until the end time, they can tap "I am here". They then see that the desk has their check-in.
- Too early, they are told when check-in opens.
- They see the answer: approved, rejected, expired or closed.
- After a rejection they are told to speak to the desk, and cannot try again for that booking.
- They never see the desk's reason.

**The desk**
- The reception list has two parts.
  - "Waiting": who said they are here, oldest first.
  - "Needs a decision": see "Nobody answers" below.
- Approve is the same as pressing check-in. The calendar shows the booking checked in, and the 5 minute undo still works.
- Reject needs a reason. The booking itself is not touched.
- **Careful with reject.** After a rejection the booking follows the ordinary rules again. If it is already past start plus 30 minutes, the auto no-show marks it within a minute and keeps the deposit. Reject only when it means "this person is not here".
- If the desk uses the normal check-in button instead, the request closes by itself within a minute.

**Nobody answers**
- The booking is never marked a no-show automatically.
- At the booking's end time the request expires. The booking stays CONFIRMED and appears under "needs a decision".
- The desk closes it by hand: check in, mark no-show, or cancel.

## What to watch in the log

- At boot: "Check-in request lapse job armed, every 60s", next to "Auto no-show sweeper armed".
- `CheckInRequestSweeper ... expired`: a customer nobody answered. Many of these means the desk is not watching the list.
- `CheckInRequestSweeper ... closed`: fine. The desk used the normal button, or the booking was cancelled or moved.
- `StaffScope REFUSED (always on)` or `HID n row(s) (always on)` for a real salon's own desk: one of its bookings has no tenant or a wrong one. Run step 0. QA tokens on marina-walk rows are refused by design: those rows have no tenant.
- "Lapse sweep failed" or a no-show "Sweep failed": should never appear.
- The usual "auto no-show at start plus 30" lines should keep coming for everyone else.

## Turning it off

- **Quick off:** set `SELF_CHECK_IN_V1` back to false (or remove it) and restart booking-api. Also turn off customer-api's flag once it exists. All five routes answer 404 at once.
- **What stays on:**
  - The lapse job keeps ending waiting requests.
  - The sweeper keeps leaving alone any booking whose customer said they arrived. Those stay CONFIRMED, and the desk closes them from the calendar, because the reception list is off with the flag.
  - There is nothing to clean up. The table can stay.
- **Full rollback:** deploy the previous image by its sha. The table stays, unused. The old sweeper does not know about requests: it will mark claimed bookings no-show and keep the deposit. Close those by hand first, or accept that.

## What is not built

- **QR, of either kind:** no scanning, no chair column. Either choice later adds one column and the scan screen.
- **The customer-api route (PR 4) and the app guide:** until they exist, the app cannot raise a request.
- **The business web:**
  - No reception list screen, approve and reject buttons, reason picker, or "needs a decision" handling.
  - No live alert when a request is raised: the desk has to refresh the list.
  - The list shows booking codes and customer ids, not names.
- **Notifications:** no push to the customer on approve or reject; the app reads the state. No events of its own for raise, approve or reject. Approve writes the normal `booking.checked_in` event.
- **Parties:** one request per lane. There is no party-wide request, and a guest's lane cannot raise.
- **Staff scope on the older routes:** still parked on `fix/staff-scope`. When it is rebased, it takes this branch's version of the scope helper.
- **Tests and docs:**
  - CI does not run the live tests, because they need a database. How to run them is at the top of `self-check-in.live.spec.ts`.
  - The API docs in `docs/api` are not updated. Swagger lists the new routes.

## Where a reviewer should look first

- `approveWith` in `check-in-request.repository.ts`: the lock held around the check-in. If the lock is removed, three live tests fail.
- The candidate query in `no-show-sweeper.service.ts`: the filter is in the query, not the loop. If it is removed, the 51-booking live test fails with 49.
- `arrivalClaimed` in `check-in-request.repository.ts`: the one copy of "the customer said they arrived", shared by the sweeper and the reception list.
