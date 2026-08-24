# System Design — Ticketron

## The core idea

The brief's own framing is the real design brief: sold-out events strand
customers while cancellations go to waste. Most implementations treat
"seat hold expiry" and "waitlist offer expiry" as two separate features
with two timers. Ticketron treats them as one mechanism with two flavors
of the same row: a `holds` table where a waitlist offer is just a hold
with `is_waitlist_offer=1` and a longer TTL. One scheduler sweep, one
expiry path, one release function, so a fix to one is a fix to the other.
It also means an abandoned checkout, not just a cancellation, routes
through the waitlist before returning to the open market, closing a gap
the brief describes but doesn't explicitly ask for.

## Seat hold and TTL mechanism

Each seat's live state is a row in `show_seats` (`available` / `held` /
`booked`), not a computed value, so "is this seat free" is always a
single indexed read. That matters once a seat map has hundreds of seats
being polled by hundreds of browsers. A hold is a separate `holds` row
carrying `expires_at`, linked to the seat by `hold_id`.

TTL enforcement is server-authoritative, not trust-the-client. A
`setInterval` scheduler (5s by default) sweeps expired holds and
releases their seats back to `available`, whether or not the customer's
tab is open, crashed, or dead. The client-side countdown timer is purely
UX; it has zero authority over whether the seat is actually still
theirs. That avoids the common bug class where a slow or disconnected
client silently keeps a seat past its real deadline.

Tradeoff: a fixed sweep interval means a released seat can sit
"phantom-held" for up to 5s before the DB reflects it — a deliberate
balance against write pressure; at larger scale I'd move to
expiry-triggered background jobs instead.

Worth naming: the first version of the sweep compared `expires_at`
(ISO 8601, `...T18:20:00.000Z`) against SQLite's `datetime('now')`, a
different string shape (space instead of `T`, no `Z`). SQLite compares
TEXT lexicographically, and `' '` sorts below `'T'`, so the check was
false for same-day holds regardless of actual time — holds never
expired. Fixed by binding a JS-generated ISO timestamp as the query
parameter instead, so both sides compare in the same format. It passed
casual testing and only surfaced once seats sat held long enough to
matter — a reminder to test TTL logic at real time scale, not just short
debug intervals.

## Concurrency protection

`seatEngine.holdSeatsTx` wraps the full check-then-set operation (read
every requested seat's status, verify all are `available`, flip them to
`held`, insert the `holds` row) inside one `better-sqlite3` transaction.
Those transactions are synchronous, and SQLite in WAL mode holds an
exclusive write lock for the duration of a write transaction. Two
"simultaneous" hold requests for the same seat are never actually
concurrent at the storage layer: the second transaction's read of seat
status executes after the first has committed, so it sees `held`, not
`available`, and is correctly rejected. There's no gap between "check"
and "set" for another writer to slip into, because both happen inside
one atomic unit. This is the same class of guarantee `SELECT ... FOR
UPDATE` gives in Postgres, enforced by the engine's locking rather than
an explicit row lock, and it's a real guarantee, not a probabilistic one.

Where this stops being enough: at multi-instance scale (several Node
processes sharing one DB), SQLite's single-writer model becomes the
bottleneck. The schema is plain SQL, so the direct port is Postgres with
the same transaction under `SELECT ... FOR UPDATE`, or a short-lived
Redis lock as a pre-check. Skipped here — no correctness benefit at this
brief's scale — but the seam is one function.

## Waitlist auto-assignment and the reliability twist

A plain FIFO waitlist optimizes for fairness but not for actually
filling the seat: it will happily burn a 15-minute offer window on a
customer who reliably ignores them, while someone eager to book waits
behind them. `waitlistEngine.offerToNext` ranks candidates by
reliability score first, join time second. FIFO is still the tiebreaker
and the default for every new customer (score starts at 1.0), but a
customer who lets holds or offers expire drifts down slightly, and one
who converts climbs back. It's a nudge, not a ban, and it targets the
wasted-seat problem the brief opens with, rather than just satisfying
"a waitlist exists."

## Time-limited offer handling

An offer is a hold, so it inherits every guarantee above for free: the
same transaction-safe seat flip, scheduler-enforced TTL, and
all-or-nothing confirm. On expiry, the scheduler adjusts the score and
immediately calls the same `offerToNext` used for the original
assignment, not a separate "expired offer" branch, until someone claims
it or the queue empties and the seat returns to the open market.
