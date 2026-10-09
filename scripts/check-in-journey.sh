#!/usr/bin/env bash
#
# SELF CHECK-IN, END TO END: a real customer and a real desk, on this Mac.
#
#   scripts/check-in-journey.sh
#
# Starts platform, booking-api (main), customer-api (main) and customer-api's
# ConsumerAuth gRPC, all local, flags on, then walks one customer through a
# check-in and the things that go wrong, printing one line per step: what
# happened, the HTTP code, and the one fact that matters. Stops everything it
# started when it ends, whatever happens.
#
# EVERY CALL GOES THROUGH A REAL DOOR. The customer's through customer-api's
# HTTP port, as the app; the desk's through booking-api, as the business web.
# The database is touched only to SEED (the booking, and the chair cards on
# platform) before the journey. The tidy-up at the end also goes through
# booking-api's own desk routes.
#
# TWO IDENTITIES, AND HOW EACH IS REAL:
#   the customer   registers through customer-api's own POST /auth/register
#                  (a fresh account each run) and uses the token it answers
#   the desk       Liam Johnson, an Iron Razor staff member with a real staff
#                  profile. Iron Razor's staff have NO login on the local
#                  platform (no email, no password), so the desk's token is
#                  signed with the platform key, exactly as platform's login
#                  signs one, with the same claims (checked against
#                  login.handler.ts and booking-api's token-verifier). Every desk
#                  CALL still goes through booking-api.
#
# WHAT IT LEAVES BEHIND, by design: one customer account per run (customer-
# api's local database), one scan row per real chair scan (platform's
# registry, as every real scan), and the run's bookings, finished or
# cancelled through the desk so none is left waiting or due. The chair cards
# are seeded once and reused.
#
# Settings (all optional):
#   JOURNEY_HOME     where the main checkouts, builds and logs live
#                    (default ~/.gostyle-journey)
#   PLATFORM_REPO    default ../gostyle-platform
#   CUSTOMER_REPO    default ../gostyle-customer-api
#   BOOKING_MAIN     default origin/main
#   CUSTOMER_MAIN    default imransid/main
#   PROOF_DB_NAME    booking-api's database, default gostyle_booking_gaps_proof

set -uo pipefail

# ------------------------------------------------------------ where things are

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OFFICE=$(dirname "$ROOT")
PLATFORM_REPO=${PLATFORM_REPO:-$OFFICE/gostyle-platform}
CUSTOMER_REPO=${CUSTOMER_REPO:-$OFFICE/gostyle-customer-api}
WORK=${JOURNEY_HOME:-$HOME/.gostyle-journey}
BOOKING_MAIN=${BOOKING_MAIN:-origin/main}
CUSTOMER_MAIN=${CUSTOMER_MAIN:-imransid/main}
PROOF_DB_NAME=${PROOF_DB_NAME:-gostyle_booking_gaps_proof}

RUN=$(date +%Y%m%d-%H%M%S)
LOGS=$WORK/logs/$RUN

# Ports of this run only, away from the docker containers' 3849/3851/50052.
P_PLATFORM_HTTP=3100
P_PLATFORM_GRPC=50152
P_BOOKING=3199
P_CUSTOMER=8100
P_CONSUMER_GRPC=50161

# The keys the services share with each other, for this run.
PLATFORM_KEY=journey-platform-key   # booking-api -> platform ChairDirectory
INTERNAL_KEY=journey-internal-key   # booking-api -> customer-api ConsumerDirectory

CUSTOMER_API=http://127.0.0.1:$P_CUSTOMER/api/v1
BOOKING_API=http://127.0.0.1:$P_BOOKING/v1

# The local platform's data: Iron Razor Jumeirah, and another salon.
TENANT=11111111-1111-1111-1111-111111111111
BRANCH=22222222-2222-2222-2222-222222222222
OTHER_TENANT=00000000-0000-0000-0000-000000000001   # Go Style
OTHER_BRANCH=0faa6a6e-694c-4518-a69a-5b4f0c234e67   # Go Style - Main
DESK_USER=88888888-8888-8888-8888-888888888880      # Liam Johnson

# The chair cards (seeded once): the token is what the customer's phone reads.
CARD7=jrnyCard7LiveQ9xT2mPkRw
CARD8=jrnyCard8LiveB3vN7cHsLe
CARD9=jrnyCard9LiveK5dW1qZyTu
CARD3_DEAD=jrnyCard3DeadM8fJ4rXaPo
CARD3_LIVE=jrnyCard3LiveV2gS6tNbQi
CARD_OTHER=jrnyOtherSalonCard1HwYz

APP_UA="GoStyle/1.4 (journey; iPhone)"

# ------------------------------------------------------------ printing

say()  { printf '%s\n' "$*"; }
note() { printf '      %s\n' "$*"; }
head_line() { printf '\n== %s\n' "$*"; }
# step <n> <what happened> <http code> <the fact>
step() { printf '%-4s %s  [HTTP %s]  %s\n' "$1." "$2" "$3" "$4"; }

die() {
  printf '\nSTOPPED: %s\n' "$*" >&2
  exit 1
}

# A step that did not go as it must: what was expected, what came, the body.
failed() {
  printf '\nSTEP %s FAILED: %s\n' "$1" "$2" >&2
  printf '  HTTP %s\n' "$CODE" >&2
  jq . "$BODY" >&2 2>/dev/null || cat "$BODY" >&2
  exit 1
}

# ------------------------------------------------------------ calls

BODY=$(mktemp)
CODE=000

# call <method> <url> <token> [json body] [user agent]: sets CODE, BODY.
call() {
  local method=$1 url=$2 token=$3 data=${4:-} ua=${5:-}
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$ua" ] && args+=(-H "User-Agent: $ua")
  [ -n "$data" ] && args+=(-H 'Content-Type: application/json' -d "$data")
  CODE=$(curl "${args[@]}")
}

field() { jq -r "$1" "$BODY"; }

must_be() { # <step> <code...>: the call answered one of these codes
  local s=$1; shift
  for c in "$@"; do [ "$CODE" = "$c" ] && return 0; done
  failed "$s" "expected HTTP $*"
}

must_equal() { # <step> <jq path> <value>
  local got
  got=$(field "$2")
  [ "$got" = "$3" ] || failed "$1" "expected $2 = $3, got $got"
}

# ISO time -> the salon's clock (booking-api's BRANCH_TIMEZONE), HH:MM.
salon_time() {
  TZ=$SALON_TZ jq -rn --arg t "$1" '$t | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 | strflocaltime("%H:%M")'
}

# ------------------------------------------------------------ 0. preflight

head_line "Getting ready"

for tool in git node pnpm psql jq curl nc; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done

env_value() { grep -E "^$2=" "$1" | tail -1 | sed -E "s/^$2=//; s/^\"(.*)\"$/\1/"; }

BOOKING_BASE_URL=$(env_value "$ROOT/.env" DATABASE_URL)
[ -n "$BOOKING_BASE_URL" ] || die "no DATABASE_URL in $ROOT/.env"
PROOF_URL=$(sed -E "s#/[^/?]+(\?|$)#/$PROOF_DB_NAME\1#" <<<"$BOOKING_BASE_URL")
PROOF_PSQL=${PROOF_URL%%\?*}
PLATFORM_PSQL=$(env_value "$PLATFORM_REPO/apps/gostyle-api/.env" DATABASE_URL)
PLATFORM_PSQL=${PLATFORM_PSQL%%\?*}
[ -n "$PLATFORM_PSQL" ] || die "no DATABASE_URL in platform's apps/gostyle-api/.env"
DESK_SECRET=$(env_value "$ROOT/.env" JWT_ACCESS_SECRET)
[ -n "$DESK_SECRET" ] || die "no JWT_ACCESS_SECRET in $ROOT/.env"
SALON_TZ=$(env_value "$ROOT/.env" BRANCH_TIMEZONE)
SALON_TZ=${SALON_TZ:-Asia/Dubai}

for port in $P_PLATFORM_HTTP $P_PLATFORM_GRPC $P_BOOKING $P_CUSTOMER $P_CONSUMER_GRPC; do
  if nc -z -G 1 127.0.0.1 "$port" >/dev/null 2>&1; then
    die "port $port is in use. Stop whatever holds it and run again."
  fi
done

mkdir -p "$WORK" "$LOGS"

# PLATFORM: its own checkout, which must hold main's code (not a worktree:
# a fresh install and build of that monorepo is many minutes). Built here
# whenever its code changed, and stamped with the code's git trees.
# NOT A TIMESTAMP: platform's build is incremental, and an up-to-date build
# rewrites nothing, so a file's time says nothing about which code it holds.
git -C "$PLATFORM_REPO" fetch -q origin 2>/dev/null
if ! git -C "$PLATFORM_REPO" diff --quiet origin/main -- apps packages; then
  die "platform's checkout is not origin/main's code (apps, packages). In $PLATFORM_REPO: git switch main && git pull"
fi
platform_code=$(git -C "$PLATFORM_REPO" rev-parse origin/main:apps origin/main:packages | tr '\n' ' ')
PLATFORM_STAMP=$PLATFORM_REPO/apps/gostyle-api/dist/.journey-built
if [ "$(cat "$PLATFORM_STAMP" 2>/dev/null)" != "$platform_code" ]; then
  say "platform:     building main's code (it changed since the last build here) ..."
  ( cd "$PLATFORM_REPO" \
    && pnpm build:packages >"$LOGS/platform-build.log" 2>&1 \
    && pnpm --filter gostyle-api build >>"$LOGS/platform-build.log" 2>&1 ) \
    || die "platform did not build: $LOGS/platform-build.log"
  echo "$platform_code" >"$PLATFORM_STAMP"
fi
say "platform:     $(git -C "$PLATFORM_REPO" log -1 --format='%h %s' origin/main | cut -c1-70) (its own checkout, built)"

# BOOKING-API: main, in its own worktree, built when main moves.
git -C "$ROOT" fetch -q origin || die "could not fetch booking-api"
BOOKING_DIR=$WORK/booking-api
if [ ! -d "$BOOKING_DIR" ]; then
  git -C "$ROOT" worktree add -q --detach "$BOOKING_DIR" "$BOOKING_MAIN" || die "could not make booking-api's worktree"
else
  git -C "$BOOKING_DIR" checkout -q --detach "$BOOKING_MAIN" || die "could not move booking-api's worktree to $BOOKING_MAIN"
fi
cp "$ROOT/.env" "$BOOKING_DIR/.env"
booking_sha=$(git -C "$BOOKING_DIR" rev-parse --short HEAD)
if [ "$(cat "$BOOKING_DIR/.journey-built" 2>/dev/null)" != "$booking_sha" ]; then
  say "booking-api:  building $booking_sha (main moved) ..."
  ( cd "$BOOKING_DIR" \
    && pnpm install --frozen-lockfile --prefer-offline >"$LOGS/booking-build.log" 2>&1 \
    && pnpm exec prisma generate >>"$LOGS/booking-build.log" 2>&1 \
    && pnpm build >>"$LOGS/booking-build.log" 2>&1 ) || die "booking-api did not build: $LOGS/booking-build.log"
  echo "$booking_sha" >"$BOOKING_DIR/.journey-built"
fi
say "booking-api:  $(git -C "$BOOKING_DIR" log -1 --format='%h %s' | cut -c1-70)"

# CUSTOMER-API: main, in its own worktree, on the repo's own virtualenv.
git -C "$CUSTOMER_REPO" fetch -q imransid || die "could not fetch customer-api"
CUSTOMER_DIR=$WORK/customer-api
if [ ! -d "$CUSTOMER_DIR" ]; then
  git -C "$CUSTOMER_REPO" worktree add -q --detach "$CUSTOMER_DIR" "$CUSTOMER_MAIN" || die "could not make customer-api's worktree"
else
  git -C "$CUSTOMER_DIR" checkout -q --detach "$CUSTOMER_MAIN" || die "could not move customer-api's worktree to $CUSTOMER_MAIN"
fi
cp "$CUSTOMER_REPO/.env" "$CUSTOMER_DIR/.env"
PY=$CUSTOMER_REPO/.venv/bin/python
[ -x "$PY" ] || die "customer-api has no .venv at $CUSTOMER_REPO/.venv"
say "customer-api: $(git -C "$CUSTOMER_DIR" log -1 --format='%h %s' | cut -c1-70)"

# booking-api's database: there, and at main's migrations.
if ! psql "$PROOF_PSQL" -X -q -c 'SELECT 1' >/dev/null 2>&1; then
  createdb "$(sed -E 's#.*/##' <<<"$PROOF_PSQL")" -h "$(sed -E 's#.*@([^:/]+).*#\1#' <<<"$PROOF_PSQL")" \
    -U "$(sed -E 's#^[a-z]+://([^:@]+).*#\1#' <<<"$PROOF_PSQL")" || die "could not create $PROOF_DB_NAME"
fi
( cd "$BOOKING_DIR" && DATABASE_URL=$PROOF_URL pnpm exec prisma migrate deploy >"$LOGS/migrate.log" 2>&1 ) \
  || die "booking-api's migrations did not apply: $LOGS/migrate.log"
say "database:     $PROOF_DB_NAME, at main's migrations"

# ------------------------------------------------------------ seed: chair cards

# Platform's floor for Iron Razor Jumeirah: a zone, chairs 7, 8, 9 and 3,
# each with a live card; chair 3 also has an old card that was replaced.
# And chair 1 at another salon. Seeded once: fixed ids, ON CONFLICT DO NOTHING.
psql "$PLATFORM_PSQL" -X -q -v ON_ERROR_STOP=1 >"$LOGS/seed-chairs.log" 2>&1 <<SQL || die "chair cards did not seed: $LOGS/seed-chairs.log"
INSERT INTO floor (id, tenant_id, branch_id, name, updated_at)
VALUES ('1a000000-0000-4000-8000-00000000f100', '$TENANT', '$BRANCH', 'Journey floor', now())
ON CONFLICT DO NOTHING;
INSERT INTO floor_zone (id, tenant_id, floor_id, name, resource_type, updated_at)
VALUES ('1a000000-0000-4000-8000-00000000f200', '$TENANT', '1a000000-0000-4000-8000-00000000f100',
        'Window section', 'CHAIR', now())
ON CONFLICT DO NOTHING;
INSERT INTO station (id, tenant_id, branch_id, zone_id, number, resource_type, state, updated_at) VALUES
  ('1a000000-0000-4000-8000-000000000007', '$TENANT', '$BRANCH', '1a000000-0000-4000-8000-00000000f200', '7', 'CHAIR', 'ACTIVE', now()),
  ('1a000000-0000-4000-8000-000000000008', '$TENANT', '$BRANCH', '1a000000-0000-4000-8000-00000000f200', '8', 'CHAIR', 'ACTIVE', now()),
  ('1a000000-0000-4000-8000-000000000009', '$TENANT', '$BRANCH', '1a000000-0000-4000-8000-00000000f200', '9', 'CHAIR', 'ACTIVE', now()),
  ('1a000000-0000-4000-8000-000000000003', '$TENANT', '$BRANCH', '1a000000-0000-4000-8000-00000000f200', '3', 'CHAIR', 'ACTIVE', now()),
  ('1a000000-0000-4000-8000-0000000000a1', '$OTHER_TENANT', '$OTHER_BRANCH', NULL, '1', 'CHAIR', 'ACTIVE', now())
ON CONFLICT DO NOTHING;
INSERT INTO station_qr_code (id, tenant_id, station_id, token, url, serial, state,
                             dead_at, dead_reason, issued_by_id, generated_at) VALUES
  ('1a000000-0000-4000-8000-0000000c0007', '$TENANT', '1a000000-0000-4000-8000-000000000007', '$CARD7',
   'http://localhost:$P_PLATFORM_HTTP/v1/public/chairs/$CARD7', 'JRN-0007', 'ACTIVE', NULL, NULL, '$DESK_USER', now()),
  ('1a000000-0000-4000-8000-0000000c0008', '$TENANT', '1a000000-0000-4000-8000-000000000008', '$CARD8',
   'http://localhost:$P_PLATFORM_HTTP/v1/public/chairs/$CARD8', 'JRN-0008', 'ACTIVE', NULL, NULL, '$DESK_USER', now()),
  ('1a000000-0000-4000-8000-0000000c0009', '$TENANT', '1a000000-0000-4000-8000-000000000009', '$CARD9',
   'http://localhost:$P_PLATFORM_HTTP/v1/public/chairs/$CARD9', 'JRN-0009', 'ACTIVE', NULL, NULL, '$DESK_USER', now()),
  ('1a000000-0000-4000-8000-0000000c0d03', '$TENANT', '1a000000-0000-4000-8000-000000000003', '$CARD3_DEAD',
   'http://localhost:$P_PLATFORM_HTTP/v1/public/chairs/$CARD3_DEAD', 'JRN-0003-OLD', 'DEAD',
   now() - interval '1 day', 'Replaced by a new card', '$DESK_USER', now() - interval '30 days'),
  ('1a000000-0000-4000-8000-0000000c0003', '$TENANT', '1a000000-0000-4000-8000-000000000003', '$CARD3_LIVE',
   'http://localhost:$P_PLATFORM_HTTP/v1/public/chairs/$CARD3_LIVE', 'JRN-0003', 'ACTIVE', NULL, NULL, '$DESK_USER', now()),
  ('1a000000-0000-4000-8000-0000000c00a1', '$OTHER_TENANT', '1a000000-0000-4000-8000-0000000000a1', '$CARD_OTHER',
   'http://localhost:$P_PLATFORM_HTTP/v1/public/chairs/$CARD_OTHER', 'JRN-OTHER-1', 'ACTIVE', NULL, NULL, '$DESK_USER', now())
ON CONFLICT DO NOTHING;
SQL
cards=$(psql "$PLATFORM_PSQL" -X -A -t -c "SELECT count(*) FROM station_qr_code WHERE token IN ('$CARD7','$CARD8','$CARD9','$CARD3_DEAD','$CARD3_LIVE','$CARD_OTHER')")
[ "$cards" = 6 ] || die "expected the 6 journey chair cards on platform, found $cards: $LOGS/seed-chairs.log"
say "chair cards:  chairs 7, 8, 9 and 3 at Iron Razor Jumeirah (Window section), chair 1 at Go Style - Main"

# ------------------------------------------------------------ start everything

PIDS=()
stop_all() {
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
  wait 2>/dev/null
  rm -f "$BODY"
}
trap stop_all EXIT INT TERM

start() { # <name> <dir> <log> <command...>
  local name=$1 dir=$2 log=$3; shift 3
  ( cd "$dir" && exec "$@" ) >"$log" 2>&1 &
  PIDS+=($!)
}

wait_for() { # <name> <port>
  for _ in $(seq 1 90); do
    nc -z -G 1 127.0.0.1 "$2" >/dev/null 2>&1 && return 0
    sleep 1
  done
  die "$1 did not come up on :$2 (logs in $LOGS)"
}

start platform "$PLATFORM_REPO" "$LOGS/platform.log" \
  env PORT=$P_PLATFORM_HTTP GRPC_PORT=$P_PLATFORM_GRPC PLATFORM_INTERNAL_KEY=$PLATFORM_KEY \
  node apps/gostyle-api/dist/main.js
start consumer-grpc "$CUSTOMER_DIR" "$LOGS/consumer-grpc.log" \
  env INTERNAL_GRPC_KEY=$INTERNAL_KEY "$PY" manage.py grpcserver --port $P_CONSUMER_GRPC
wait_for "platform (gRPC)" $P_PLATFORM_GRPC
wait_for "customer-api's ConsumerAuth gRPC" $P_CONSUMER_GRPC
start booking-api "$BOOKING_DIR" "$LOGS/booking-api.log" \
  env DATABASE_URL="$PROOF_URL" PORT=$P_BOOKING SELF_CHECK_IN_V1=true \
      CONSUMER_GRPC_ADDR=localhost:$P_CONSUMER_GRPC PLATFORM_GRPC_ADDR=localhost:$P_PLATFORM_GRPC \
      PLATFORM_INTERNAL_KEY=$PLATFORM_KEY INTERNAL_GRPC_KEY=$INTERNAL_KEY \
  node dist/main.js
start customer-api "$CUSTOMER_DIR" "$LOGS/customer-api.log" \
  env BOOKING_API_URL=http://localhost:$P_BOOKING SELF_CHECK_IN_V1=true \
      EMAIL_HOST=127.0.0.1 EMAIL_PORT=1025 EMAIL_USE_TLS=False \
  "$PY" manage.py runserver 127.0.0.1:$P_CUSTOMER --noreload
wait_for "booking-api" $P_BOOKING
wait_for "customer-api" $P_CUSTOMER
wait_for "platform (HTTP)" $P_PLATFORM_HTTP
say "running:      platform :$P_PLATFORM_HTTP/:$P_PLATFORM_GRPC, booking-api :$P_BOOKING, customer-api :$P_CUSTOMER, ConsumerAuth :$P_CONSUMER_GRPC (logs: $LOGS)"

# A FRESH PLATFORM IS SLOW ONCE. Its first staff-directory call has taken
# longer than booking-api's 900 ms cap for a name, and then the welcome goes
# out with no name and booking-api skips names for 30 s: correct, and not
# what a long-running platform does. So one call is made here first, timed
# and printed (the cold start stays visible every run), and it also reads
# the desk member's name as platform holds it: what step 6 must show.
read -r COLD_MS DESK_NAME < <(cd "$BOOKING_DIR" && node -e '
  const [addr, tenant, user] = process.argv.slice(1);
  const grpc = require("@grpc/grpc-js");
  const loader = require("@grpc/proto-loader");
  const def = loader.loadSync("proto/staff.proto", { keepCase: true });
  const client = new (grpc.loadPackageDefinition(def).gostyle.staff.v1.StaffDirectory)(
    addr, grpc.credentials.createInsecure());
  const t0 = Date.now();
  client.listStylists({ tenant_id: tenant, branch_id: "" }, { deadline: Date.now() + 15000 }, (err, res) => {
    const ms = Date.now() - t0;
    const me = (res?.stylists ?? []).find((s) => s.user_id === user);
    const name = me ? `${me.first_name} ${(me.last_name || "").slice(0, 1).toUpperCase()}.` : "";
    console.log(err ? `${ms} ERROR:${err.code}` : `${ms} ${name}`);
    client.close();
  });
' "localhost:$P_PLATFORM_GRPC" "$TENANT" "$DESK_USER")
[ -n "${DESK_NAME:-}" ] && [[ "$DESK_NAME" != ERROR:* ]] \
  || die "platform's staff directory did not name the desk member ($DESK_NAME)"
say "warm-up:      platform's staff directory answered its first call in ${COLD_MS} ms; the desk member is \"$DESK_NAME\""

# ------------------------------------------------------------ the two people

# The desk: Liam Johnson's token, with exactly what platform's login signs
# (nest-auth login.handler.ts + BranchClaimsEnricher): sub, sid, tenantId,
# roles (his role codes in that tenant: none, locally), branchId (his staff
# profile's branch), iss gostyle-api, 15 minutes. booking-api reads sub,
# roles, tenantId, branchId and checks iss; sid it does not read.
DESK=$(cd "$BOOKING_DIR" && node -e '
  const [secret, sub, tenantId, branchId] = process.argv.slice(1);
  const sid = require("node:crypto").randomUUID();
  console.log(require("jsonwebtoken").sign(
    { sub, sid, tenantId, roles: [], branchId },
    secret, { issuer: "gostyle-api", expiresIn: "15m" }));
' "$DESK_SECRET" "$DESK_USER" "$TENANT" "$BRANCH")

# A booking, straight into booking-api's database: the one shortcut allowed.
seed_booking() { # <id> <code> <minutes from now> -> prints the start, ISO
  psql "$PROOF_PSQL" -X -A -t -q -v ON_ERROR_STOP=1 <<SQL
INSERT INTO booking (id, tenant_id, code, branch_id, customer_id, status,
                     payment_status, trading_day, start_at, end_at,
                     start_minute, duration_min, price_fils, deposit_fils,
                     channel, updated_at)
SELECT '$1', '$TENANT', '$2', '$BRANCH', '$CUSTOMER_ID', 'confirmed',
       'none_required', (s AT TIME ZONE '$SALON_TZ')::date, s,
       s + interval '60 minutes',
       extract(hour from s AT TIME ZONE '$SALON_TZ')::int * 60
         + extract(minute from s AT TIME ZONE '$SALON_TZ')::int,
       60, 0, 0, 'mobile', now()
  FROM (SELECT date_trunc('minute', now()) + interval '$3 minutes' AS s) t
RETURNING to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
SQL
}
new_id() { node -e 'console.log(require("node:crypto").randomUUID())'; }

# ------------------------------------------------------------ the journey

head_line "The journey"

# 1. A real customer, a real booking.
EMAIL="journey-$RUN@example.test"
call POST "$CUSTOMER_API/auth/register" "" "$(jq -nc --arg e "$EMAIL" '{
  destination_type: "email", destination: $e, full_name: "Sara Ahmed",
  password: "Journey-pass-2026", confirm_password: "Journey-pass-2026", gender: "female" }')"
must_be 1 201
TOKEN=$(field .access)
CUSTOMER_ID=$(node -e 'console.log(JSON.parse(Buffer.from(process.argv[1].split(".")[1], "base64url")).consumer_id)' "$TOKEN")
A=$(new_id); A_CODE="GS-J-$RUN-A"
A_START=$(seed_booking "$A" "$A_CODE" 10) || die "booking A did not seed"
step 1 "Sara Ahmed signs up through customer-api; her booking $A_CODE is at $(salon_time "$A_START")" \
  "$CODE" "a real customer, a booking 10 minutes from now at Iron Razor Jumeirah"

# 2. The customer reads her bookings: is "I am here" on?
call GET "$CUSTOMER_API/bookings?filter=upcoming&page=1&pageSize=50" "$TOKEN"
must_be 2 200
on=$(jq -r --arg id "$A" '.results[] | select(.id == $id) | .can_check_in' "$BODY")
[ "$on" = true ] || failed 2 "expected the row of $A_CODE with can_check_in true, got '$on'"
step 2 "She opens My Bookings" "$CODE" "the \"I am here\" button is ON (can_check_in: true)"

# 3. She scans the card on chair 7 and says "I am here".
call POST "$CUSTOMER_API/booking/$A/check-in" "$TOKEN" "{\"chair_token\":\"$CARD7\"}" "$APP_UA"
must_be 3 201
must_equal 3 .request.state WAITING
must_equal 3 .request.chair.number 7
step 3 "She scans the card on chair 7 and taps \"I am here\"" "$CODE" \
  "WAITING for the desk, chair $(field .request.chair.number) ($(field .request.chair.zoneName))"

# 4. The desk opens its list.
call GET "$BOOKING_API/check-in-requests?branchId=$BRANCH" "$DESK"
must_be 4 200
line=$(jq -c --arg id "$A" '.waiting[] | select(.booking.bookingId == $id)' "$BODY")
[ -n "$line" ] || failed 4 "expected $A_CODE in the desk's waiting list"
who=$(jq -r '.booking.customerName // "(no name)"' <<<"$line")
chair=$(jq -r '.request.chair.number' <<<"$line")
step 4 "The desk opens its check-in list" "$CODE" \
  "$who is waiting, booking $(jq -r .booking.code <<<"$line"), chair $chair"

# 5. The desk approves.
call POST "$BOOKING_API/bookings/$A/check-in-request/approve" "$DESK"
must_be 5 200
must_equal 5 .request.state APPROVED
must_equal 5 .checkIn.to CHECKED_IN
step 5 "The desk approves" "$CODE" "the request is APPROVED and the booking CHECKED_IN"

# 6. She reads again: checked in, when, by whom.
call GET "$CUSTOMER_API/booking/$A/check-in" "$TOKEN"
must_be 6 200
must_equal 6 .checkIn.via SELF
must_equal 6 .checkIn.byName "$DESK_NAME"
at=$(field .checkIn.at); by=$(field .checkIn.byName)
read_code=$CODE
call GET "$CUSTOMER_API/booking/$A" "$TOKEN"
must_be 6 200
must_equal 6 .status CHECKED_IN
must_equal 6 .check_in.via SELF
must_equal 6 .check_in.by_name "$DESK_NAME"
step 6 "She looks at her booking again" "$read_code/$CODE" \
  "checked in at $(salon_time "$at") by $by; she asked first (SELF); the booking says CHECKED_IN"

head_line "When things go wrong"

D=$(new_id); D_CODE="GS-J-$RUN-D"
seed_booking "$D" "$D_CODE" 10 >/dev/null || die "booking D did not seed"
note "(another booking for Sara, $D_CODE, 10 minutes from now)"

# 7. A chair from another salon.
call POST "$CUSTOMER_API/booking/$D/check-in" "$TOKEN" "{\"chair_token\":\"$CARD_OTHER\"}" "$APP_UA"
must_be 7 409
must_equal 7 .details.reason OTHER_SALON
step 7 "She scans a chair card from another salon" "$CODE" "refused, OTHER_SALON: \"$(field .message)\""

# 8. A dead chair card.
call POST "$CUSTOMER_API/booking/$D/check-in" "$TOKEN" "{\"chair_token\":\"$CARD3_DEAD\"}" "$APP_UA"
must_be 8 409
must_equal 8 .details.reason CARD_OUT_OF_DATE
step 8 "She scans chair 3's old, replaced card" "$CODE" "refused, CARD_OUT_OF_DATE: \"$(field .message)\""

# 9. Too early.
B=$(new_id); B_CODE="GS-J-$RUN-B"
seed_booking "$B" "$B_CODE" 40 >/dev/null || die "booking B did not seed"
call POST "$CUSTOMER_API/booking/$B/check-in" "$TOKEN"
must_be 9 409
must_equal 9 .code BOOKING_CHECKIN_WINDOW
step 9 "She taps \"I am here\" 40 minutes before booking $B_CODE" "$CODE" \
  "too early: check-in opens at $(salon_time "$(field .details.windowOpensAt)")"

# 10. She cancels the request, then raises it again at a different chair.
call POST "$CUSTOMER_API/booking/$D/check-in" "$TOKEN" "{\"chair_token\":\"$CARD8\"}" "$APP_UA"
must_be 10 201
must_equal 10 .request.chair.number 8
first=$(field .request.requestId)
step 10a "She scans chair 8 and taps \"I am here\"" "$CODE" "WAITING, chair 8"
call POST "$CUSTOMER_API/booking/$D/check-in/withdraw" "$TOKEN"
must_be 10 200
must_equal 10 .request.state WITHDRAWN
step 10b "She taps Cancel Request" "$CODE" "WITHDRAWN: the request is taken back"
call POST "$CUSTOMER_API/booking/$D/check-in" "$TOKEN" "{\"chair_token\":\"$CARD9\"}" "$APP_UA"
must_be 10 201
must_equal 10 .request.chair.number 9
[ "$(field .request.requestId)" != "$first" ] || failed 10 "expected a new request, got the same one"
step 10c "She moves to chair 9, scans it and taps \"I am here\" again" "$CODE" "a new request, WAITING, chair 9"

# 11. The desk rejects.
call POST "$BOOKING_API/bookings/$D/check-in-request/reject" "$DESK" '{"reason":"Not at the salon"}'
must_be 11 200
must_equal 11 .request.state REJECTED
step 11a "The desk rejects her request" "$CODE" "REJECTED (the desk's reason stays with the desk)"
call GET "$CUSTOMER_API/booking/$D/check-in" "$TOKEN"
must_be 11 200
must_equal 11 .request.state REJECTED
step 11b "She reads the answer" "$CODE" "REJECTED: the app tells her to speak to the desk"
call POST "$CUSTOMER_API/booking/$D/check-in" "$TOKEN" "{\"chair_token\":\"$CARD8\"}" "$APP_UA"
must_be 11 409
must_equal 11 .code BOOKING_CHECKIN_REJECTED
step 11c "She tries \"I am here\" again" "$CODE" "refused: \"$(field .message)\""

# ------------------------------------------------------------ tidy, through the desk

head_line "Tidying up, through the desk's own routes"
call POST "$BOOKING_API/bookings/$A/start" "$DESK" '{}'
must_be tidy 200 201
call POST "$BOOKING_API/bookings/$A/complete" "$DESK" '{}'
must_be tidy 200 201
note "$A_CODE: started and completed, so chair 7 is free for the next run"
for id in "$B" "$D"; do
  call POST "$BOOKING_API/bookings/$id/cancel" "$DESK" '{"reason":"Journey script tidy-up"}'
  must_be tidy 200 201
done
note "$B_CODE and $D_CODE: cancelled, so neither is left waiting or due"

say ""
say "All steps went as they must. Logs: $LOGS"
