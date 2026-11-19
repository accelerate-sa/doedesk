#!/usr/bin/env python3
"""Builds apps/server/src/telemetry/timeZoneCountries.ts from the system's time zone database.

The usage-data rule asks first where a computer's time zone belongs to a country on the consent
list, so the app needs to know which countries use each zone name. `zone.tab` gives each country's
zones. A name that is not in it (an older name such as Asia/Calcutta) takes the countries of every
listed zone whose data file is identical to its own.

Rerun when the tz database has a new release: python3 scripts/build-time-zone-countries.py
"""

import hashlib
import json
import os
import pathlib

ROOT = pathlib.Path(os.environ.get("TZDIR", "/usr/share/zoneinfo"))
OUTPUT = pathlib.Path(__file__).parent.parent / "apps/server/src/telemetry/timeZoneCountries.ts"
AREAS = {
    "Africa", "America", "Antarctica", "Arctic", "Asia",
    "Atlantic", "Australia", "Europe", "Indian", "Pacific",
}  # fmt: skip


def digest(path: pathlib.Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()


def main() -> None:
    countries_of: dict[str, set[str]] = {}
    for line in (ROOT / "zone.tab").read_text().splitlines():
        if line.startswith("#") or not line.strip():
            continue
        country, _coordinates, zone = line.split("\t")[:3]
        countries_of[zone] = {country}

    by_digest: dict[str, set[str]] = {}
    for zone, countries in countries_of.items():
        by_digest.setdefault(digest(ROOT / zone), set()).update(countries)

    for area in sorted(AREAS):
        for path in sorted((ROOT / area).rglob("*")):
            zone = path.relative_to(ROOT).as_posix()
            if path.is_dir() or zone in countries_of:
                continue
            same = by_digest.get(digest(path))
            if same is not None:
                countries_of[zone] = same

    zones_of: dict[str, list[str]] = {}
    for zone, countries in countries_of.items():
        zones_of.setdefault(" ".join(sorted(countries)), []).append(zone)

    version = (ROOT / "+VERSION").read_text().strip() if (ROOT / "+VERSION").exists() else "unknown"
    lines = [
        "/**",
        " * Which countries use each time zone name, for the usage-data rule. Generated from the IANA time",
        f" * zone database (release {version}) by scripts/build-time-zone-countries.py: do not edit by hand.",
        " * An older name for a zone takes the countries of every zone it is now the same as.",
        " */",
        "const ZONES_BY_COUNTRIES: Readonly<Record<string, string>> = {",
    ]
    for countries in sorted(zones_of):
        key = countries if countries.isalpha() else json.dumps(countries)
        value = json.dumps(" ".join(sorted(zones_of[countries])))
        lines.append(f"  {key}:")
        lines.append(f"    {value},")
    lines += [
        "};",
        "",
        "const COUNTRIES_BY_ZONE: ReadonlyMap<string, ReadonlyArray<string>> = new Map(",
        "  Object.entries(ZONES_BY_COUNTRIES).flatMap(([countries, zones]) =>",
        '    zones.split(" ").map((zone) => [zone, countries.split(" ")] as const),',
        "  ),",
        ");",
        "",
        "/** The countries a time zone name belongs to. Empty for `UTC`, `Etc/…` and names it does not know. */",
        "export const countriesOfTimeZone = (timeZone: string): ReadonlyArray<string> =>",
        "  COUNTRIES_BY_ZONE.get(timeZone) ?? [];",
        "",
    ]
    OUTPUT.write_text("\n".join(lines))
    print(f"{len(countries_of)} zone names, tz database {version}")


main()
