#!/usr/bin/env python3
"""Generate the carrier-tariff task: implement quote() from a ~48 KB carrier tariff.

Run from the repository root:  python3 tools/suite/carrier_tariff.py
Writes suites/personal/fixtures/carrier-tariff/ and suites/personal/private/carrier-tariff.mjs.
Deterministic: a rerun rewrites the same bytes.

The tariff prints rate tables, a zone chart, ZIP lists and a fuel table, and its last part holds
dated notices and errata that amend the earlier chapters. One reference implementation, fed the
same data the tariff prints (with the errata applied), computes every hidden expected value here,
so the grader carries only numbers. A shipment's charges are graded per rule: each check compares
only the charge lines that rule decides, so partial credit names the rule a candidate missed.
"""
import datetime
import json
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "suites" / "personal" / "fixtures" / "carrier-tariff"
GRADER = ROOT / "suites" / "personal" / "private" / "carrier-tariff.mjs"
LIMIT = 29_500
rng = random.Random(1701)

SERVICES = ["ground", "express", "overnight"]
ZONES = list(range(2, 9))
MAX_LB = 150


def rate_table(scale, a, b):
    table = {}
    for w in range(1, MAX_LB + 1):
        for z in ZONES:
            cents = round(scale * (a[z] + b[z] * w ** 0.92) * 100 + rng.uniform(-4, 4))
            if w > 1:
                cents = max(cents, table[(w - 1, z)] + 5)
            if z > 2:
                cents = max(cents, table[(w, z - 1)] + 5)
            table[(w, z)] = cents
    return table


A = {2: 9.10, 3: 9.55, 4: 10.20, 5: 10.65, 6: 11.30, 7: 11.90, 8: 12.70}
B = {2: 0.42, 3: 0.47, 4: 0.55, 5: 0.63, 6: 0.74, 7: 0.86, 8: 0.97}
RATES = {"ground": rate_table(1.0, A, B), "express": rate_table(2.35, A, B), "overnight": rate_table(3.6, A, B)}


def misprint(cents):
    s = f"{cents:05d}"
    swapped = int(s[:-2] + s[-1] + s[-2])
    return swapped if swapped != cents else cents - 9


ERRATA = [("ground", 23, 5), ("express", 9, 7)]
PRINTED = {s: dict(t) for s, t in RATES.items()}
for s, w, z in ERRATA:
    PRINTED[s][(w, z)] = misprint(RATES[s][(w, z)])

ZONE_CHART = [[3 if o == d else min(8, 3 + abs(o - d)) for d in range(10)] for o in range(10)]
for o, d, v in [(0, 1, 3), (1, 0, 3), (9, 8, 4), (8, 9, 4), (4, 6, 4), (6, 4, 4), (2, 9, 8), (9, 2, 8)]:
    ZONE_CHART[o][d] = v
NONCONTIGUOUS = ["967", "968", "995", "996", "997", "998", "999"]

all_prefixes = [f"{p:03d}" for p in range(5, 994) if f"{p:03d}" not in NONCONTIGUOUS]
pool = [p for p in all_prefixes if p not in ("597", "598", "100", "941", "606", "303", "802", "553")]
rng.shuffle(pool)
DAS = sorted(pool[:110] + ["597", "598"])
EXTENDED = sorted(pool[110:160])
REMOTE = sorted(pool[160:180])
PLAIN = [p for p in pool[180:] if p not in DAS]

MONDAYS = [datetime.date(2026, 1, 5) + datetime.timedelta(weeks=i) for i in range(52)]
FUEL = []
g, a = 12.50, 15.25
for monday in MONDAYS:
    g = round(min(14.75, max(11.25, g + rng.choice([-0.25, 0, 0, 0.25, 0.5]))), 2)
    a = round(min(18.0, max(14.0, a + rng.choice([-0.25, 0, 0.25, 0.25, 0.5]))), 2)
    FUEL.append((monday.isoformat(), g, a))

DATA = {
    "rates": {s: {f"{w},{z}": c for (w, z), c in t.items()} for s, t in RATES.items()},
    "zone_chart": ZONE_CHART, "noncontiguous": NONCONTIGUOUS, "das": DAS, "extended": EXTENDED, "remote": REMOTE,
    "fuel": FUEL,
}

REFERENCE_CODE = '''"""Shipment pricing under the carrier tariff (reference implementation)."""
import datetime
import json
import math
from decimal import ROUND_HALF_UP, Decimal

DATA = json.loads(__DATA__)
RATES = {s: {tuple(map(int, k.split(","))): v for k, v in t.items()} for s, t in DATA["rates"].items()}
TIER = {"ground": {"standard": 0, "silver": 8, "gold": 15, "platinum": 22},
        "express": {"standard": 0, "silver": 5, "gold": 10, "platinum": 18},
        "overnight": {"standard": 0, "silver": 4, "gold": 8, "platinum": 12}}


def half_up(value):
    return int(Decimal(value).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def on_or_after(date, iso):
    return date >= datetime.date.fromisoformat(iso)


def zone(service, origin, dest):
    o, d = origin[:3], dest[:3]
    if d in DATA["noncontiguous"]:
        return None if service == "ground" else 8
    if o == d:
        return 2
    return DATA["zone_chart"][int(o[0])][int(d[0])]


def fuel_percent(service, date):
    week = [row for row in DATA["fuel"] if datetime.date.fromisoformat(row[0]) <= date][-1]
    if service != "ground":
        return Decimal(str(week[2]))
    if on_or_after(date, "2026-04-06"):
        return Decimal(str(week[2])) - Decimal("2.25")
    return Decimal(str(week[1]))


def quote(shipment):
    date = datetime.date.fromisoformat(shipment["ship_date"])
    service = shipment["service"]
    z = zone(service, shipment["origin_zip"], shipment["dest_zip"])
    if z is None:
        return {"error": "not-serviceable"}
    if shipment.get("saturday") and service == "ground":
        return {"error": "saturday-not-offered"}
    residential = bool(shipment.get("residential"))
    tier = shipment.get("account_tier", "standard")
    divisor = 135 if service == "ground" and on_or_after(date, "2026-09-01") else 139
    ahs_weight_limit = 55 if on_or_after(date, "2026-05-01") else 50
    peak = (datetime.date(2026, 3, 30) <= date <= datetime.date(2026, 4, 12)
            or datetime.date(2026, 10, 26) <= date <= datetime.date(2027, 1, 17))
    minimum = RATES[service][(1, 2)]
    charges = dict.fromkeys(["base", "discount", "residential", "delivery_area", "handling", "oversize",
                             "peak", "signature", "saturday", "fuel"], 0)
    for package in shipment["packages"]:
        # math.ceil, not -(-x // 1): Decimal's // truncates toward zero, so that idiom rounds 2.2 down to 2.
        actual = max(1, math.ceil(Decimal(str(package["weight"]))))
        sides = sorted((half_up(Decimal(str(package[k]))) for k in ("length", "width", "height")), reverse=True)
        girth = sides[0] + 2 * (sides[1] + sides[2])
        if actual > 150 or girth > 165:
            return {"error": "over-limits"}
        cubic = sides[0] * sides[1] * sides[2]
        billable = actual
        if service != "ground" or cubic > 1728:
            billable = max(billable, -(-cubic // divisor))
        oversize = girth > 130
        if oversize:
            billable = max(billable, 90)
        base = RATES[service][(min(billable, 150), z)]
        discount = half_up(Decimal(base) * TIER[service][tier] / 100)
        discount = min(discount, base - minimum)
        charges["base"] += base
        charges["discount"] -= discount
        handling = 0
        if oversize:
            charges["oversize"] += 21000
        else:
            if sides[0] > 48 or sides[1] > 30:
                handling = 2750
            if actual > ahs_weight_limit:
                handling = max(handling, 3125)
            charges["handling"] += handling
        if peak:
            if service != "ground":
                charges["peak"] += 110
            elif residential:
                charges["peak"] += 40
            if oversize or handling:
                charges["peak"] += 600
    if residential and not (service == "ground" and tier == "platinum" and on_or_after(date, "2026-07-01")):
        charges["residential"] = 595 if service == "ground" else 640
    prefix = shipment["dest_zip"][:3]
    extended = set(DATA["extended"]) | ({"597"} if on_or_after(date, "2026-06-01") else set())
    if prefix in DATA["remote"]:
        charges["delivery_area"] = 1550
    elif prefix in extended:
        charges["delivery_area"] = 810 if residential else 680
    elif prefix in DATA["das"]:
        charges["delivery_area"] = 585 if residential else 445
    signature = shipment.get("signature", "none")
    new_prices = on_or_after(date, "2027-01-01")
    if signature == "direct":
        charges["signature"] = 725 if new_prices else 675
    elif signature == "adult":
        charges["signature"] = 875 if new_prices else 800
    if shipment.get("saturday"):
        charges["saturday"] = 1600
    fuel_base = (charges["base"] + charges["discount"] + charges["residential"] + charges["delivery_area"]
                 + charges["handling"] + charges["oversize"] + charges["saturday"])
    charges["fuel"] = half_up(Decimal(fuel_base) * fuel_percent(service, date) / 100)
    return {"total": sum(charges.values()), "charges": charges}
'''


def reference_source(data):
    return REFERENCE_CODE.replace("__DATA__", repr(json.dumps(data, separators=(",", ":"))))


LOADER = r"""import re
from pathlib import Path

APPLY_ERRATA = True
NONCONTIGUOUS = ["967", "968", "995", "996", "997", "998", "999"]


def _section(text, heading):
    start = text.index(heading)
    end = text.find("\n#", start + len(heading))
    return text[start:] if end == -1 else text[start:end]


def _rows(block):
    return [[cell.strip() for cell in line.strip().strip("|").split("|")] for line in block.splitlines()
            if line.startswith("|") and not set(line.strip()) <= set("|-: ")]


def load_tariff():
    here = Path(__file__).resolve().parent
    text = "\n".join((here / f"TARIFF-{i}.md").read_text() for i in range(1, 3))
    rates = {}
    for n, service in enumerate(("ground", "express", "overnight"), 1):
        rows = _rows(_section(text, f"### Table 3-{n}:"))[1:]
        rates[service] = {f"{row[0]},{z}": int(cell.replace(".", "")) for row in rows
                          for z, cell in zip(range(2, 9), row[1:])}
    if APPLY_ERRATA:
        for n, service in ((1, "ground"), (2, "express")):
            m = re.search(rf"Table 3-{n} \(\w+\), the (\d+) lb row, zone (\d): the printed [\d.]+\s+is a misprint\.\s+"
                          r"The correct rate is ([\d.]+)\.", text)
            rates[service][f"{m.group(1)},{m.group(2)}"] = int(m.group(3).replace(".", ""))
    chart = [[int(x) for x in row[1:]] for row in _rows(_section(text, "### Table 2-1:"))[1:]]
    lists = {key: re.findall(r"\b\d{3}\b", _section(text, heading).split("\n", 1)[1])
             for key, heading in (("das", "### A-1"), ("extended", "### A-2"), ("remote", "### A-3"))}
    fuel = [(row[0], float(row[1]), float(row[2])) for row in _rows(_section(text, "## Appendix B"))[1:]]
    return {"rates": rates, "zone_chart": chart, "noncontiguous": NONCONTIGUOUS, "fuel": fuel, **lists}
"""


def control_source(errata=True):
    """The control reads every table from the tariff files, as a careful implementer would."""
    src = REFERENCE_CODE.replace("DATA = json.loads(__DATA__)\n", LOADER + "\n\nDATA = load_tariff()\n")
    return src if errata else src.replace("APPLY_ERRATA = True", "APPLY_ERRATA = False")


# A baseline that reads the chapters but not the notices: printed tables, old thresholds, no withdrawals.
BASELINE_EDITS = [
    ('    divisor = 135 if service == "ground" and on_or_after(date, "2026-09-01") else 139\n', '    divisor = 139\n'),
    ('    ahs_weight_limit = 55 if on_or_after(date, "2026-05-01") else 50\n', '    ahs_weight_limit = 50\n'),
    ('    if residential and not (service == "ground" and tier == "platinum" and on_or_after(date, "2026-07-01")):\n',
     '    if residential:\n'),
    ('    extended = set(DATA["extended"]) | ({"597"} if on_or_after(date, "2026-06-01") else set())\n',
     '    extended = set(DATA["extended"])\n'),
    ('    if on_or_after(date, "2026-04-06"):\n        return Decimal(str(week[2])) - Decimal("2.25")\n', ''),
]


def baseline_source():
    src = control_source(errata=False)
    for old, new in BASELINE_EDITS:
        assert src.count(old) == 1, old
        src = src.replace(old, new)
    return src

# ------------------------------------------------------------------ the tariff text

def money(cents):
    return f"{cents // 100}.{cents % 100:02d}"


def rates_text(service, printed):
    head = f"### Table 3-{SERVICES.index(service) + 1}: {service.capitalize()} rates (USD per package)\n\n"
    head += "| lb | " + " | ".join(f"Z{z}" for z in ZONES) + " |\n|---:|" + "---:|" * len(ZONES) + "\n"
    rows = [f"| {w} | " + " | ".join(money(printed[(w, z)]) for z in ZONES) + " |" for w in range(1, MAX_LB + 1)]
    return head + "\n".join(rows) + "\n"


def prefix_rows(prefixes, per_row=16):
    return "\n".join(", ".join(prefixes[i:i + per_row]) for i in range(0, len(prefixes), per_row))


PART1 = """# Carrier Tariff 2026 — Domestic Parcel Services

Part 1 of 2. Effective for shipments with a ship date from 2026-01-01. This tariff is in two files:
Part 1 (chapters 1, 2, 4, 5, 7, 8 and 10, then chapter 3's Ground and Express rate tables) and Part 2
(chapter 3's Overnight rate table, chapter 6, the appendices, and chapter 9: notices and errata).

**How to read this tariff.** Chapter 9 publishes notices and errata after the chapters went to print. An
erratum corrects the printed text everywhere. A notice changes the rule it names for every shipment whose
ship date is on or after the notice's effective date; shipments before that date keep the printed rule.
Where a notice and a chapter disagree, the notice governs from its effective date.

## Chapter 1. Measurement

**1.1 Units.** Rates and charges are printed in US dollars. Every charge is computed and reported in whole
cents (Chapter 8).

**1.2 Actual weight.** A package's actual weight is its scale weight rounded **up** to the next whole pound:
12.0 lb is 12 lb, 12.01 lb is 13 lb. A package is never less than 1 lb.

**1.3 Dimensions.** Each side is rounded to the nearest whole inch, halves rounding up (12.5 in is 13 in,
12.49 in is 12 in). Every later rule uses the rounded sides.

**1.4 Dimensional weight.** The rounded length × width × height (the package's cubic size, in cubic inches)
divided by the divisor, rounded **up** to the next whole pound. The divisor is 139.

**1.5 When dimensional weight applies.** For Ground, dimensional weight applies only to a package whose cubic
size is more than 1,728 cubic inches. For Express and Overnight it applies to every package.

**1.6 Billable weight.** The greater of the actual weight and, where it applies, the dimensional weight.
Chapter 4.4 sets a higher minimum for oversize packages. A billable weight over 150 lb is rated at the
150 lb row of Chapter 3.

**1.7 Length plus girth.** The longest rounded side plus twice the sum of the other two rounded sides.

**1.8 Limits.** A package whose actual weight is more than 150 lb, or whose length plus girth is more than
165 in, is not accepted, and the shipment is refused with the error `over-limits`.

**1.9 Several packages.** Each package is rated on its own: base charge, discount, additional handling,
oversize and the per-package peak charges. Residential, delivery area, signature and Saturday charges apply
once per shipment, however many packages it has.

## Chapter 2. Zones and service area

**2.1 Zones.** The zone is read from the zone chart below, by the first digit of the origin ZIP code (rows)
and the first digit of the destination ZIP code (columns). When the origin and destination share the same
first **three** digits, the zone is 2 instead.

### Table 2-1: Zone chart

__ZONE_CHART__

**2.2 Non-contiguous destinations.** Destination ZIP codes beginning __NONCONTIGUOUS__ are outside the
contiguous service area. Ground does not serve them: the shipment is refused with the error
`not-serviceable`. Express and Overnight serve them at zone 8, whatever 2.1 would give.

**2.3 Saturday delivery.** Saturday delivery is offered with Express and Overnight only. A Ground shipment
that asks for Saturday delivery is refused with the error `saturday-not-offered`.

**2.4 Order of refusals.** A shipment is checked in this order: service area (2.2), Saturday (2.3), then each
package's limits (1.8). The first failing check decides the error.

## Chapter 4. Surcharges

**4.1 Residential delivery.** A shipment to a residence pays $5.95 (Ground) or $6.40 (Express and Overnight),
once per shipment.

**4.2 Delivery area surcharge.** A shipment whose destination ZIP code begins with a prefix listed in
Appendix A pays, once per shipment: Delivery Area $4.45 to a business or $5.85 to a residence; Extended
Delivery Area $6.80 to a business or $8.10 to a residence; Remote Area $15.50 to either. A prefix appears on
one list at most.

**4.3 Additional handling.** Per package: $27.50 when the longest side is more than 48 in or the second-longest
side is more than 30 in; $31.25 when the actual weight is more than 50 lb. A package that meets both pays only
the higher amount. An oversize package (4.4) never pays additional handling.

**4.4 Oversize.** Per package: a package whose length plus girth is more than 130 in pays $210.00, and its
billable weight is at least 90 lb.

**4.5 Signature.** Once per shipment: direct signature $6.75, adult signature $8.00.

**4.6 Saturday delivery.** Once per shipment: $16.00.

**4.7 Peak charges.** During a peak period (Chapter 6), each package pays: Ground $0.40 if the shipment goes
to a residence (Ground to a business pays no peak charge); Express and Overnight $1.10. In addition, during a
peak period every package that pays additional handling or oversize pays $6.00, whatever the service.

## Chapter 5. Account discounts

**5.1 Tiers.** An account's tier discounts the base charge of each package:

| Service | Standard | Silver | Gold | Platinum |
|---|---:|---:|---:|---:|
| Ground | 0% | 8% | 15% | 22% |
| Express | 0% | 5% | 10% | 18% |
| Overnight | 0% | 4% | 8% | 12% |

**5.2 Computing a discount.** A package's discount is its base charge times the percentage, rounded to the
cent (Chapter 8).

**5.3 Minimum charge.** A package's base charge less its discount may not be less than the service's minimum
charge, which is its zone 2, 1 lb rate in Chapter 3. Where it would be, the discount is reduced so that the
net equals the minimum.

**5.4 Reporting.** Discounts are reported together as one negative amount.

## Chapter 7. Fuel surcharge

**7.1 Percentage.** The fuel percentage is read from Appendix B for the week (Monday to Sunday) that contains
the ship date. Ground uses the Ground column; Express and Overnight use the Air column.

**7.2 What fuel applies to.** The fuel surcharge is the percentage of the sum of: base charges less discounts,
residential, delivery area, additional handling, oversize and Saturday charges. Signature and peak charges
carry no fuel.

## Chapter 8. Rounding and the quote

**8.1 Rounding.** Amounts are kept in whole cents. A discount is rounded per package and the fuel surcharge
once per shipment, each to the nearest cent with halves rounding up. Nothing else is rounded.

**8.2 The quote.** A quote reports ten charges in cents: `base`, `discount` (zero or negative),
`residential`, `delivery_area`, `handling` (additional handling), `oversize`, `peak`, `signature`, `saturday`
and `fuel`, with zero for a charge that does not apply, and `total`, their sum.

## Chapter 10. Claims and liability (for information)

**10.1 Declared value.** Each package is covered up to $100.00 of declared value. Higher declared values cost
$1.35 per $100.00 or part of it above the first $100.00. Declared value is billed separately on the monthly
invoice and is not part of a shipment quote.

**10.2 Claims.** Claims for loss or damage must be filed within 60 days of the ship date with proof of value.
Claims for late delivery under the money-back guarantee must be filed within 15 days and are not available
during peak periods, for Saturday deliveries, or for shipments refused under Chapter 2.

**10.3 Exclusions.** The carrier is not liable for consequential loss, for perishable items not packed to the
packaging guide, or for delays caused by incorrect addresses. Address corrections are billed on the invoice
at $19.00 per package and are not part of a shipment quote.

**10.4 Billing disputes.** Invoice disputes must reach the carrier within 180 days of the invoice date. The
carrier may re-weigh and re-measure any package; billed charges follow the carrier's measurements.
"""

PART4 = """## Chapter 9. Notices and errata

Notices and errata are listed in the order they were published. A notice applies to shipments whose ship
date is on or after its effective date.

**Erratum E-1** (published 2026-01-09). Table 3-1 (Ground), the 23 lb row, zone 5: the printed __E1_PRINTED__
is a misprint. The correct rate is __E1_CORRECT__.

**Notice N-2** (published 2026-03-02; effective 2026-04-06). Ground fuel. For Ground shipments, the fuel
percentage is the Air percentage of the same week less 2.25 percentage points. The Ground column of
Appendix B no longer applies from the effective date.

**Erratum E-2** (published 2026-03-20). Table 3-2 (Express), the 9 lb row, zone 7: the printed __E2_PRINTED__
is a misprint. The correct rate is __E2_CORRECT__.

**Notice N-3** (published 2026-04-01; effective 2026-05-01). Additional handling by weight (Chapter 4.3)
applies when the actual weight is more than 55 lb, instead of more than 50 lb. The dimension conditions do not
change.

**Notice N-4** (published 2026-05-04; effective 2026-06-01). Destination prefixes 597 and 598 move from the
Delivery Area list to the Extended Delivery Area list.

**Notice N-5** (published 2026-05-29). Notice N-4 is withdrawn for prefix 598, which stays on the Delivery
Area list. Notice N-4 stands for prefix 597.

**Notice N-6** (published 2026-06-15; effective 2026-07-01). Platinum accounts pay no residential surcharge
on Ground shipments. Express and Overnight are unchanged.

**Notice N-7** (published 2026-08-03; effective 2026-09-01). The dimensional weight divisor for Ground
becomes 135. Express and Overnight keep 139.

**Notice N-8** (published 2026-11-02; effective 2027-01-01). Signature charges become $7.25 (direct) and
$8.75 (adult).

## Revision history

| Revision | Date | Change |
|---|---|---|
| 2026.0 | 2025-12-01 | First issue of the 2026 tariff. |
| 2026.1 | 2026-03-02 | Erratum E-1; Notice N-2. |
| 2026.2 | 2026-05-29 | Erratum E-2; Notices N-3, N-4 and N-5. |
| 2026.3 | 2026-11-02 | Notices N-6, N-7 and N-8. |

## Contacts

Rate questions: the account team named on your agreement. Claims: the claims desk, within the periods in
Chapter 10. This tariff replaces the 2025 tariff for every shipment with a ship date in 2026.
"""


def part1():
    chart = "| from \\ to | " + " | ".join(str(d) for d in range(10)) + " |\n|---|" + "---:|" * 10 + "\n"
    chart += "\n".join(f"| {o} | " + " | ".join(str(ZONE_CHART[o][d]) for d in range(10)) + " |" for o in range(10))
    nonc = ", ".join(NONCONTIGUOUS[:-1]) + " or " + NONCONTIGUOUS[-1]
    return PART1.replace("__ZONE_CHART__", chart).replace("__NONCONTIGUOUS__", nonc)


def part2():
    text = ("## Chapter 3. Rates\n\n"
            "Base charge per package, by billable weight (rows, in whole pounds) and zone (columns). A package "
            "is rated at the row for its billable weight; a billable weight over 150 lb uses the 150 lb row.\n\n")
    return text + "\n".join(rates_text(s, PRINTED[s]) for s in SERVICES[:2])


def part3():
    fuel = "| Week from (Monday) | Ground % | Air % |\n|---|---:|---:|\n" + "\n".join(
        f"| {m} | {g:.2f} | {a:.2f} |" for m, g, a in FUEL)
    return f"""# Carrier Tariff 2026 — Domestic Parcel Services

Part 2 of 2.

## Chapter 3 (continued). Rates

{rates_text("overnight", PRINTED["overnight"])}
## Chapter 6. Peak periods

Peak periods run from the first date to the last date shown, both included:

| Peak period | From | To |
|---|---|---|
| Spring | 2026-03-30 | 2026-04-12 |
| Holiday | 2026-10-26 | 2027-01-17 |

## Appendix A. Delivery area lists

Three-digit destination ZIP prefixes.

### A-1 Delivery Area

{prefix_rows(DAS)}

### A-2 Extended Delivery Area

{prefix_rows(EXTENDED)}

### A-3 Remote Area

{prefix_rows(REMOTE)}

## Appendix B. Fuel surcharge percentages

{fuel}

## Appendix C. Packaging guide (for information)

Use a rigid box with at least 2 in of cushioning on every side. Packages over 50 lb need double-wall
corrugated boxes and a two-person lift label. Cylinders, tires and items not fully enclosed in a box are
treated as having a longest side of at least 49 in for handling purposes only when the shipper declares them
as non-standard packaging; this tariff's quote assumes standard boxes. Liquids need a leak-proof inner
container and absorbent material. Batteries follow the dangerous goods guide, which is not part of this tariff.

## Appendix D. Holidays (for information)

No pickups or deliveries on 2026-01-01, 2026-05-25, 2026-07-03, 2026-09-07, 2026-11-26 and 2026-12-25.
Holidays do not change any charge in this tariff; a shipment's charges follow its ship date.

## Appendix E. International services (not covered)

International shipments are priced under the separate international tariff. Nothing in this tariff applies
to them, and a destination outside the 50 states is not a domestic destination.
"""


def part4():
    t = PART4
    for tag, (s, w, z) in (("E1", ERRATA[0]), ("E2", ERRATA[1])):
        t = t.replace(f"__{tag}_PRINTED__", money(PRINTED[s][(w, z)])).replace(f"__{tag}_CORRECT__", money(RATES[s][(w, z)]))
    return t


STUB = '''"""Shipment pricing. The tariff in TARIFF-1.md and TARIFF-2.md is the specification."""


def quote(shipment):
    """Price one shipment under the tariff.

    shipment: {"ship_date": "YYYY-MM-DD", "service": "ground" | "express" | "overnight",
               "origin_zip": "94107", "dest_zip": "10001", "residential": bool,
               "account_tier": "standard" | "silver" | "gold" | "platinum",
               "signature": "none" | "direct" | "adult", "saturday": bool,
               "packages": [{"weight": lb, "length": in, "width": in, "height": in}, ...]}

    Returns {"total": cents, "charges": {"base": cents, "discount": cents, "residential": cents,
    "delivery_area": cents, "handling": cents, "oversize": cents, "peak": cents, "signature": cents,
    "saturday": cents, "fuel": cents}}, all ten charges present, or {"error": "<code>"} for a shipment
    the tariff refuses.
    """
    raise NotImplementedError("see TARIFF-1.md and TARIFF-2.md")
'''

OBSERVE = '''"""Public batch-call protocol. No expected answers or verdicts live here.

Input: module, function, calls (a list of argument lists).
Output: one raw output/args/error snapshot per call, frozen immediately.
"""
import importlib
import json
import sys


def observe(payload):
    request = json.loads(payload)
    encode = json.JSONEncoder(allow_nan=False).encode
    write = sys.stdout.write
    load = importlib.import_module
    error_type = type
    exception = Exception
    function = getattr(load(request["module"]), request["function"])
    records = []
    for args in request["calls"]:
        output, error = None, None
        try:
            output = function(*args)
        except exception as exc:
            error = error_type(exc).__name__
        records.append(encode({"output": output, "args": args, "error": error}))
    write("[" + ",".join(records) + "]")
'''

# ------------------------------------------------------------------ hidden shipments, by rule

def ship(date, service="ground", origin="94107", dest="10001", residential=False, tier="standard",
         signature="none", saturday=False, packages=((5, 10, 8, 6),)):
    return {"ship_date": date, "service": service, "origin_zip": origin, "dest_zip": dest,
            "residential": residential, "account_tier": tier, "signature": signature, "saturday": saturday,
            "packages": [{"weight": w, "length": l, "width": wd, "height": h} for w, l, wd, h in packages]}


P = PLAIN  # destination prefixes on no list
Z = lambda p: p + "11"  # a ZIP in a prefix


def cases():
    d0, d1 = "2026-02-17", "2026-08-12"  # outside peak, before and after most notices
    c = {}
    c["rates"] = ([ship(d0, s, "94107", Z(P[i]), packages=((w, 9, 7, 5),)) for i, (s, w) in enumerate(
        [("ground", 1), ("ground", 2.2), ("ground", 17), ("express", 4), ("overnight", 30.5), ("ground", 64),
         ("express", 120), ("overnight", 1), ("ground", 149.2), ("express", 33.0)])]
        + [ship(d0, "ground", "100" + "21", "10044"), ship(d0, "express", "606" + "01", "60699", packages=((3, 6, 6, 6),)),
           ship(d0, "overnight", "303" + "12", Z(P[11]), packages=((12, 8, 8, 8),)),
           ship(d0, "ground", "553" + "01", Z(P[12])), ship(d0, "ground", "802" + "15", Z(P[13]))])
    c["billable-weight"] = [
        ship(d0, "ground", dest=Z(P[20]), packages=((4, 13, 12.5, 11.4),)),     # 13*13*11 = 1859 > 1728
        ship(d0, "ground", dest=Z(P[20]), packages=((4, 12, 12, 12),)),         # exactly 1728: no dim
        ship(d0, "ground", dest=Z(P[20]), packages=((4, 12.5, 12, 12),)),       # 13*12*12 = 1872
        ship(d0, "express", dest=Z(P[21]), packages=((1, 10, 10, 10),)),        # express: dim always
        ship(d0, "overnight", dest=Z(P[21]), packages=((2.5, 14.49, 9.5, 7),)),
        ship(d1, "ground", dest=Z(P[22]), packages=((4, 20, 16, 14),)),         # divisor 139 (before Sept)
        ship("2026-09-01", "ground", dest=Z(P[22]), packages=((4, 20, 16, 14),)),  # divisor 135
        ship("2026-09-14", "ground", dest=Z(P[22]), packages=((10, 24, 18, 18),)),
        ship("2026-09-14", "express", dest=Z(P[22]), packages=((10, 24, 18, 18),)),  # express keeps 139
        ship(d0, "ground", dest=Z(P[23]), packages=((0.2, 4, 4, 4),)),           # minimum 1 lb
        ship(d0, "express", dest=Z(P[23]), packages=((7.01, 11, 9, 9),)),
    ]
    c["errata"] = [ship(d0, "ground", "4" + "0" + "0" + "11", Z(p), packages=((23, 8, 8, 8),)) for p in
                   [x for x in P if ZONE_CHART[4][int(x[0])] == 5][:2]] + \
                  [ship(d0, "express", "1" + "0" + "0" + "11", Z(p), packages=((9, 6, 6, 6),)) for p in
                   [x for x in P if ZONE_CHART[1][int(x[0])] == 7][:2]] + \
                  [ship(d0, "ground", "4" + "0" + "0" + "11", Z([x for x in P if ZONE_CHART[4][int(x[0])] == 5][0]),
                        packages=((22, 8, 8, 8),))]
    c["discounts"] = [ship(d0, s, dest=Z(P[30 + i]), tier=t, packages=((w, 9, 7, 5),)) for i, (s, t, w) in enumerate(
        [("ground", "silver", 40), ("ground", "gold", 7), ("ground", "platinum", 90), ("express", "silver", 12),
         ("express", "platinum", 60), ("overnight", "gold", 25), ("overnight", "platinum", 3),
         ("ground", "platinum", 1), ("express", "platinum", 1), ("ground", "standard", 30)])] + \
        [ship(d0, "ground", "941" + "07", "94133", tier="platinum", packages=((2, 6, 6, 6), (1, 5, 5, 5)))]
    das, ext, rem = DAS[5], EXTENDED[3], REMOTE[2]
    c["residential-area"] = [
        ship(d0, "ground", dest=Z(P[40]), residential=True), ship(d0, "express", dest=Z(P[40]), residential=True),
        ship(d0, "ground", dest=Z(das)), ship(d0, "ground", dest=Z(das), residential=True),
        ship(d0, "overnight", dest=Z(ext)), ship(d0, "express", dest=Z(ext), residential=True),
        ship(d0, "ground", dest=Z(rem), residential=True), ship(d0, "express", dest=Z(rem)),
        ship("2026-05-31", "ground", dest="59701", residential=True), ship("2026-06-01", "ground", dest="59701", residential=True),
        ship("2026-06-20", "ground", dest="59802"), ship("2026-06-20", "ground", dest="59802", residential=True),
        ship("2026-06-30", "ground", dest=Z(P[41]), residential=True, tier="platinum"),
        ship("2026-07-01", "ground", dest=Z(P[41]), residential=True, tier="platinum"),
        ship("2026-07-01", "express", dest=Z(P[41]), residential=True, tier="platinum"),
        ship("2026-07-15", "ground", dest=Z(das), residential=True, tier="gold"),
    ]
    c["handling"] = [
        ship(d0, "ground", dest=Z(P[50]), packages=((10, 49, 10, 10),)),         # longest > 48
        ship(d0, "ground", dest=Z(P[50]), packages=((10, 48.4, 10, 10),)),       # rounds to 48: none
        ship(d0, "ground", dest=Z(P[50]), packages=((10, 32, 31, 6),)),          # second-longest > 30
        ship(d0, "ground", dest=Z(P[50]), packages=((52, 20, 12, 10),)),         # weight > 50 before N-3
        ship("2026-05-01", "ground", dest=Z(P[50]), packages=((52, 20, 12, 10),)),   # > 55 needed after
        ship("2026-05-20", "ground", dest=Z(P[50]), packages=((55.2, 20, 12, 10),)), # 56 lb: weight AHS
        ship(d0, "express", dest=Z(P[51]), packages=((60, 50, 12, 10),)),        # both: higher (31.25)
        ship(d0, "ground", dest=Z(P[51]), packages=((30, 60, 24, 20),)),         # 60+88=148 > 130: oversize
        ship(d0, "ground", dest=Z(P[51]), packages=((95, 60, 24, 20),)),         # oversize, actual > 90
        ship(d0, "overnight", dest=Z(P[51]), packages=((20, 50, 20, 15),)),      # 50+70 = 120: AHS, not oversize
        ship(d0, "ground", dest=Z(P[52]), packages=((151, 10, 10, 10),)),        # over limits (weight)
        ship(d0, "ground", dest=Z(P[52]), packages=((10, 70, 25, 24),)),         # 70+98 = 168 > 165
        ship(d0, "ground", dest=Z(P[52]), packages=((150, 10, 10, 10),)),        # exactly 150: accepted
    ]
    c["peak"] = [
        ship("2026-03-29", "express", dest=Z(P[60])), ship("2026-03-30", "express", dest=Z(P[60])),
        ship("2026-04-12", "ground", dest=Z(P[60]), residential=True), ship("2026-04-13", "ground", dest=Z(P[60]), residential=True),
        ship("2026-04-01", "ground", dest=Z(P[61])),
        ship("2026-10-26", "overnight", dest=Z(P[61]), packages=((5, 10, 8, 6), (6, 10, 8, 6))),
        ship("2026-11-10", "ground", dest=Z(P[61]), residential=True, packages=((10, 50, 10, 10), (4, 9, 9, 9))),
        ship("2026-12-01", "ground", dest=Z(P[62]), packages=((40, 60, 24, 20),)),
        ship("2027-01-02", "express", dest=Z(P[62]), packages=((12, 12, 10, 8),)),
    ]
    c["fuel"] = [
        ship("2026-01-05", "ground", dest=Z(P[70])), ship("2026-01-11", "ground", dest=Z(P[70])),
        ship("2026-01-12", "express", dest=Z(P[70])), ship("2026-04-05", "ground", dest=Z(P[70])),
        ship("2026-04-06", "ground", dest=Z(P[70])), ship("2026-06-17", "ground", dest=Z(P[71]), residential=True),
        ship("2026-06-17", "overnight", dest=Z(P[71]), signature="adult"),
        ship("2026-08-26", "express", dest=Z(DAS[9]), saturday=True, signature="direct", residential=True),
        ship("2026-11-18", "ground", dest=Z(P[71]), residential=True, packages=((60, 20, 12, 10),)),
        ship("2026-12-31", "overnight", dest=Z(P[72])),
    ]
    c["options"] = [
        ship(d0, "express", dest=Z(P[80]), signature="direct"), ship(d0, "overnight", dest=Z(P[80]), signature="adult"),
        ship(d0, "express", dest=Z(P[80]), saturday=True), ship(d0, "ground", dest=Z(P[80]), saturday=True),
        ship("2026-12-31", "ground", dest=Z(P[81]), signature="adult"),
        ship("2027-01-01", "ground", dest=Z(P[81]), signature="adult"),
        ship("2027-01-02", "overnight", dest=Z(P[81]), signature="direct", saturday=True),
    ]
    c["service-area"] = [
        ship(d0, "ground", dest="99501"), ship(d0, "express", dest="99501"), ship(d0, "overnight", dest="96813"),
        ship(d0, "ground", dest="96813", saturday=True), ship(d0, "ground", dest=Z(P[90]), saturday=True, packages=((160, 10, 10, 10),)),
        ship(d0, "express", dest="99501", packages=((151, 10, 10, 10),)),
        ship(d0, "express", "995" + "01", "99577"),
    ]
    c["totals"] = [
        ship("2026-04-08", "ground", "94107", Z(DAS[12]), residential=True, tier="gold", signature="direct",
             packages=((12.3, 18, 14, 12), (51, 40, 20, 18), (3, 8, 6, 4))),
        ship("2026-06-03", "express", "10001", "59744", residential=True, tier="platinum", saturday=True,
             packages=((8, 49, 12, 10), (70, 30, 20, 20))),
        ship("2026-07-09", "ground", "60601", Z(REMOTE[5]), residential=True, tier="platinum",
             packages=((140, 60, 25, 20),)),
        ship("2026-09-21", "ground", "30312", Z(EXTENDED[8]), tier="silver", signature="adult",
             packages=((6, 22, 18, 16), (6, 22, 18, 16))),
        ship("2026-11-27", "overnight", "80215", Z(P[95]), residential=True, tier="gold", signature="adult", saturday=True,
             packages=((23, 13, 12.5, 11.4), (2, 6, 6, 6))),
        ship("2026-12-14", "ground", "55301", "59812", residential=True, packages=((56, 33, 31, 10),)),
        ship("2027-01-03", "express", "94107", Z(DAS[20]), tier="silver", signature="direct",
             packages=((1, 4, 4, 4), (1, 4, 4, 4), (1, 4, 4, 4))),
    ]
    return c


FIELDS = {"rates": ["base"], "billable-weight": ["base"], "errata": ["base"], "discounts": ["base", "discount"],
          "residential-area": ["residential", "delivery_area"], "handling": ["handling", "oversize", "base", "error"],
          "peak": ["peak"], "fuel": ["fuel"], "options": ["signature", "saturday", "error"],
          "service-area": ["error", "base"], "totals": ["total", "charges", "error"]}


def expected_outputs(c):
    files = {"tariff.py": reference_source(DATA), "observe.py": OBSERVE}
    out = {}
    with tempfile.TemporaryDirectory() as tmp:
        for name, text in files.items():
            Path(tmp, name).write_text(text)
        for group, shipments in c.items():
            payload = json.dumps({"module": "tariff", "function": "quote", "calls": [[s] for s in shipments]})
            src = f"import runpy; runpy.run_path('observe.py')['observe']({json.dumps(payload)})"
            r = subprocess.run([sys.executable, "-B", "-E", "-c", src], cwd=tmp, capture_output=True, text=True, check=True)
            rows = json.loads(r.stdout)
            assert all(x["error"] is None for x in rows), (group, rows)
            out[group] = [x["output"] for x in rows]
    return out


def view(result, fields):
    """What a check compares: the named charges, the total or the refusal."""
    if "error" in result:
        return {"error": result["error"]}
    v = {}
    for f in fields:
        if f == "total":
            v["total"] = result["total"]
        elif f == "charges":
            v["charges"] = result["charges"]
        elif f != "error":
            v[f] = result["charges"][f]
    return v


CHECK_PUBLIC = '''from tariff import quote

shipment = {"ship_date": "2026-02-17", "service": "ground", "origin_zip": "94107", "dest_zip": "__DEST__",
            "residential": False, "account_tier": "standard", "signature": "none", "saturday": False,
            "packages": [{"weight": 5, "length": 10, "width": 8, "height": 6}]}
result = quote(shipment)
assert set(result) == {"total", "charges"}, result
assert result["charges"]["base"] == __BASE__, result
assert result["charges"]["residential"] == 0 and result["charges"]["peak"] == 0, result
assert result["total"] == sum(result["charges"].values()), result
assert quote({**shipment, "saturday": True}) == {"error": "saturday-not-offered"}
print("public check passed")
'''


def grader(c, expected):
    j = json.dumps
    views = {g: [view(r, FIELDS[g]) for r in expected[g]] for g in c}
    return f"""// Generated by tools/suite/carrier_tariff.py. Edit the generator and rerun it, not this file.
import {{bounded, check, fixture, observeCases, preserved, pythonHygiene, toolChecks}} from './helpers.mjs';
import {{isDeepStrictEqual}} from 'node:util';
const original = fixture('carrier-tariff');

/**
 * A ~48 KB carrier tariff in two files: measurement, zones, three rate tables, surcharges, discounts,
 * a calendar, ZIP lists and a fuel table, then dated notices and errata that amend all of it. Each
 * check prices hidden shipments built to isolate one rule and compares only the charge lines that rule
 * decides, so partial credit names the rule a candidate missed; `totals` compares whole quotes on
 * shipments where the rules interact. The traps are the notices: an erratum that changes a printed rate,
 * a fuel rule replaced mid-year, a threshold raised, a list move partly withdrawn, a waiver by tier and a
 * divisor change, each from its own date, and one notice that is not in force for any 2026 ship date.
 */
const CASES = {j(c)};
const FIELDS = {j(FIELDS)};
const EXPECTED = {j(views)};

function view(result, fields) {{
  if (result === null || typeof result !== 'object') return {{invalid: result}};
  if ('error' in result) return {{error: result.error}};
  const v = {{}};
  for (const f of fields) {{
    if (f === 'total') v.total = result.total;
    else if (f === 'charges') v.charges = result.charges;
    else if (f !== 'error') v[f] = result.charges?.[f];
  }}
  return v;
}}

export const reference = {{files: {{...original, 'tariff.py': {j(control_source())}}}, answer: 'Implemented quote() to the tariff.'}};
export const baseline = {{files: {{...original, 'tariff.py': {j(baseline_source())}}}, answer: 'Implemented quote() to the tariff.'}};

export async function grade({{files, python, trace, lane, control, agent}}) {{
  const checks = [];
  for (const [group, shipments] of Object.entries(CASES)) {{
    const r = await observeCases(python, {{module: 'tariff', function: 'quote', calls: shipments.map(s => [s])}});
    const got = r.ok && Array.isArray(r.value) ? r.value.map(x => x.error ? {{raised: x.error}} : view(x.output, FIELDS[group])) : null;
    const wrong = got ? shipments.map((s, i) => [s, got[i], EXPECTED[group][i]]).filter(([, g, e]) => !isDeepStrictEqual(g, e)) : [];
    checks.push(check(group, 'correctness', got !== null && !wrong.length,
      got === null ? `observation failed: ${{r.diagnostic}}` : `${{wrong.length}} of ${{shipments.length}} wrong; first=${{bounded(wrong.slice(0, 2).map(([s, g, e]) => ({{shipment: s, got: g, expected: e}})), 900)}}`));
  }}
  checks.push(...await pythonHygiene(python, files, 'tariff.py'));
  return [...checks, preserved(files, original, ['tariff.py']),
    ...toolChecks(trace, ['TARIFF-1.md', 'TARIFF-2.md', 'tariff.py'], 'check_public.py', false, {{lane, control, agent}})];
}}
"""


def main():
    c = cases()
    expected = expected_outputs(c)
    public_dest = Z(P[3])
    public = expected_outputs({"p": [ship("2026-02-17", dest=public_dest)]})["p"][0]
    files = {"TARIFF-1.md": part1() + "\n" + part2(), "TARIFF-2.md": part3() + "\n" + part4(),
             "tariff.py": STUB, "observe.py": OBSERVE,
             "check_public.py": CHECK_PUBLIC.replace("__DEST__", public_dest).replace("__BASE__", str(public["charges"]["base"]))}
    for name, text in files.items():
        if name.endswith(".py"):
            compile(text, name, "exec")
        assert len(text) <= LIMIT, (name, len(text))
    if FIXTURE.exists():
        shutil.rmtree(FIXTURE)
    FIXTURE.mkdir(parents=True)
    for name, text in sorted(files.items()):
        (FIXTURE / name).write_text(text)
    GRADER.write_text(grader(c, expected))
    sizes = {n: len(t) for n, t in files.items()}
    print(f"files={len(files)} chars={sum(sizes.values())} largest={max(sizes.values())} "
          f"cases={sum(len(v) for v in c.values())} sizes={sizes}")


if __name__ == "__main__":
    main()
