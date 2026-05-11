#!/usr/bin/env python3
# analyze.py — read `<unix_ts> <revision>` lines from stdin, bucket by 10-second
# windows, and print the green/blue ratio with a sanity-check against the
# expected LINEAR step pattern.
#
# Usage:
#   ./external-load.sh "$URL" 25 | tee external.log | python3 analyze.py --step 20 --bake 2
#
# The `--green` flag pins which revision is "green" (the new build under deployment).
# Without it, the script picks the second revision it sees as green; if you have
# only ever deployed one revision the script just reports counts.
import argparse
import collections
import datetime as dt
import sys

ap = argparse.ArgumentParser()
ap.add_argument("--green", help="explicit green (new) revision id; omit to auto-detect")
ap.add_argument("--bucket", type=int, default=10, help="aggregation window in seconds")
ap.add_argument("--step", type=float, default=20, help="LINEAR step percent — for the expected column")
ap.add_argument("--bake", type=float, default=2, help="LINEAR step bake minutes — for the expected column")
args = ap.parse_args()

revs_seen_order = []         # preserves first-seen order of revision ids
buckets = collections.OrderedDict()
deploy_start_ts = None

def expected_pct(elapsed_min: float) -> float:
    # Crude approximation: each step (step_bake minutes) bumps green by step%, capped at 100%.
    if elapsed_min < 0:
        return 0.0
    step_no = int(elapsed_min // args.bake)
    return min(100.0, args.step * step_no)

def flush(bucket_ts):
    counts = buckets[bucket_ts]
    total = sum(counts.values())
    if total == 0:
        return
    green = args.green
    if green is None and len(revs_seen_order) >= 2:
        green = revs_seen_order[1]
    green_count = counts.get(green, 0) if green else 0
    blue_count = total - green_count
    pct = 100.0 * green_count / total
    elapsed = (bucket_ts - deploy_start_ts) / 60.0 if deploy_start_ts else 0.0
    expect = expected_pct(elapsed)
    bar = "#" * int(pct / 5)
    iso = dt.datetime.utcfromtimestamp(bucket_ts).strftime("%H:%M:%S")
    delta = pct - expect
    flag = "✓" if abs(delta) <= 5 else "!" if abs(delta) <= 10 else "✗"
    print(
        f"[{iso}] green={pct:5.1f}% ({green_count:3d}/{total:3d})  "
        f"expected≈{expect:5.1f}%  Δ={delta:+5.1f}%  {flag}  {bar}",
        flush=True,
    )

for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    parts = line.split()
    if len(parts) < 2:
        continue
    try:
        ts = int(parts[0])
    except ValueError:
        continue
    rev = parts[1]
    if rev not in revs_seen_order:
        revs_seen_order.append(rev)
        # When a second revision appears we mark deploy start.
        if len(revs_seen_order) == 2 and deploy_start_ts is None:
            deploy_start_ts = ts
    bucket_ts = ts - (ts % args.bucket)
    if bucket_ts not in buckets:
        # Print every previous bucket once a new one starts (line-by-line streaming).
        for prev_ts in list(buckets.keys()):
            if prev_ts < bucket_ts:
                flush(prev_ts)
                del buckets[prev_ts]
        buckets[bucket_ts] = collections.Counter()
    buckets[bucket_ts][rev] += 1

# Flush remaining buckets at EOF.
for ts in list(buckets.keys()):
    flush(ts)

print("\n--- Summary ---", file=sys.stderr)
print(f"revisions seen: {revs_seen_order}", file=sys.stderr)
if deploy_start_ts:
    print(f"deploy start (first green sighting): {dt.datetime.utcfromtimestamp(deploy_start_ts).isoformat()}Z",
          file=sys.stderr)
