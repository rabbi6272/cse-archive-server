import type { Section } from "./Student";

export interface SeriesConfig {
  id: string;
  admissionYear: number;
  label: string;
  rollPattern: RegExp;
  sections: readonly Section[];
  sectionFromRoll: (roll: string) => Section | null;
  status: "open" | "archived";
  hasLegacyClaims: boolean;
}

function sectionFromSerial(serial: number): Section | null {
  if (!Number.isInteger(serial) || serial < 1) return null;
  if (serial <= 60) return "a";
  if (serial <= 120) return "b";
  if (serial <= 180) return "c";
  return null;
}

function sectionsFor(prefix: string): (roll: string) => Section | null {
  return (roll) => {
    const trimmed = roll.trim();
    if (!trimmed.startsWith(prefix)) return null;
    return sectionFromSerial(Number(trimmed.slice(prefix.length)));
  };
}

const SECTION_ROLL_RANGES: Array<{ sec: Section; min: number; max: number }> = [
  { sec: "a", min: 2403001, max: 2403060 },
  { sec: "b", min: 2403061, max: 2403120 },
  { sec: "c", min: 2403121, max: 2403180 },
];

function sectionFromRoll24(roll: string): Section | null {
  const rollNumber = Number(roll.trim());
  if (!Number.isInteger(rollNumber)) return null;
  return SECTION_ROLL_RANGES.find(({ min, max }) => rollNumber >= min && rollNumber <= max)?.sec ?? null;
}

export const SERIES: readonly SeriesConfig[] = [
  {
    id: "25",
    admissionYear: 2025,
    label: "2025 series",
    rollPattern: /^2503\d{3}$/,
    sections: ["a", "b", "c"],
    sectionFromRoll: sectionsFor("2503"),
    status: "open",
    hasLegacyClaims: false,
  },
  {
    id: "24",
    admissionYear: 2024,
    label: "2024 series",
    rollPattern: /^2403\d{3}$/,
    sections: ["a", "b", "c"],
    sectionFromRoll: sectionFromRoll24,
    status: "open",
    hasLegacyClaims: true,
  },
  {
    id: "23",
    admissionYear: 2023,
    label: "2023 series",
    rollPattern: /^2303\d{3}$/,
    sections: ["a", "b", "c"],
    sectionFromRoll: sectionsFor("2303"),
    status: "open",
    hasLegacyClaims: false,
  },
  {
    id: "22",
    admissionYear: 2022,
    label: "2022 series",
    rollPattern: /^2203\d{3}$/,
    sections: ["a", "b", "c"],
    sectionFromRoll: sectionsFor("2203"),
    status: "open",
    hasLegacyClaims: false,
  },
  {
    id: "21",
    admissionYear: 2021,
    label: "2021 series",
    rollPattern: /^2103\d{3}$/,
    sections: ["a", "b", "c"],
    sectionFromRoll: sectionsFor("2103"),
    status: "open",
    hasLegacyClaims: false,
  },
  {
    id: "20",
    admissionYear: 2020,
    label: "2020 series",
    rollPattern: /^2003\d{3}$/,
    sections: ["a", "b", "c"],
    sectionFromRoll: sectionsFor("2003"),
    status: "open",
    hasLegacyClaims: false,
  },
];

export function getSeries(id: string): SeriesConfig | null {
  return SERIES.find((entry) => entry.id === id) ?? null;
}

export function seriesFromRoll(roll: string): SeriesConfig | null {
  const trimmed = roll.trim();
  if (!trimmed) return null;
  return SERIES.find((entry) => entry.rollPattern.test(trimmed)) ?? null;
}

export function getSectionFromRoll(roll: string): Section | null {
  return seriesFromRoll(roll)?.sectionFromRoll(roll) ?? null;
}

export function allSections(): readonly Section[] {
  const union = new Set<Section>();
  for (const entry of SERIES) for (const sec of entry.sections) union.add(sec);
  return [...union].sort();
}
