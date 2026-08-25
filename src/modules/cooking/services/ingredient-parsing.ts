import { moment } from "@/platform";

export const DEFAULT_LABEL = "tinned-jarred-dried";
export const SHOPPING_IGNORE_LIST = ["water", "salt", "pepper"];

export type ShoppingItem = {
  content: string;
  labels: string[];
  sources: string[];
};

export type ParsedIngredient = {
  displayName: string;
  quantity: number | null;
  unit: "g" | "ml" | "count" | null;
  countUnit: string | null;
};

type MachineRecipeIngredientRecord = {
  text?: unknown;
  resolved_display_name?: unknown;
  resolution_status?: unknown;
};

const UNIT_ALIASES: Record<string, string> = {
  g: "g",
  gram: "g",
  grams: "g",
  kg: "kg",
  kilogram: "kg",
  kilograms: "kg",
  ml: "ml",
  milliliter: "ml",
  milliliters: "ml",
  millilitre: "ml",
  millilitres: "ml",
  l: "l",
  liter: "l",
  liters: "l",
  litre: "l",
  litres: "l",
  tsp: "tsp",
  teaspoon: "tsp",
  teaspoons: "tsp",
  tbsp: "tbsp",
  tablespoon: "tbsp",
  tablespoons: "tbsp",
  cup: "cup",
  cups: "cup",
  oz: "oz",
  ounce: "oz",
  ounces: "oz",
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb"
};

const LABEL_RULES: Array<{ label: string; keywords: string[] }> = [
  {
    label: "fruit-and-veg",
    keywords: [
      "onion",
      "garlic",
      "tomato",
      "potato",
      "carrot",
      "pepper",
      "capsicum",
      "lemon",
      "lime",
      "apple",
      "banana",
      "lettuce",
      "spinach",
      "kale",
      "mushroom",
      "aubergine",
      "eggplant",
      "courgette",
      "zucchini",
      "cabbage",
      "brussels sprout",
      "brussels sprouts",
      "broccoli",
      "cauliflower",
      "herb",
      "parsley",
      "basil",
      "coriander",
      "cilantro",
      "mint",
      "dill",
      "sage",
      "thyme",
      "rosemary",
      "ginger",
      "chilli",
      "chili",
      "spring onion",
      "scallion",
      "shallot",
      "leek",
      "celery",
      "orange"
    ]
  },
  {
    label: "dairy",
    keywords: [
      "milk",
      "cheese",
      "yogurt",
      "yoghurt",
      "cream",
      "butter",
      "parmesan",
      "mozzarella",
      "cheddar",
      "feta",
      "egg",
      "eggs"
    ]
  },
  {
    label: "meat-and-fish",
    keywords: [
      "chicken",
      "beef",
      "pork",
      "lamb",
      "fish",
      "salmon",
      "tuna",
      "anchovy",
      "anchovies",
      "shrimp",
      "prawn",
      "prawns",
      "bacon",
      "ham"
    ]
  },
  {
    label: "bakery",
    keywords: [
      "bread",
      "bun",
      "bagel",
      "tortilla",
      "pita",
      "pastry",
      "roll",
      "croissant",
      "brioche"
    ]
  },
  {
    label: "baking",
    keywords: [
      "flour",
      "sugar",
      "baking powder",
      "baking soda",
      "yeast",
      "cocoa",
      "vanilla"
    ]
  },
  {
    label: "drinks",
    keywords: ["wine", "beer", "cider", "vodka", "gin", "rum"]
  },
  {
    label: "frozen",
    keywords: ["frozen", "ice cream"]
  },
  {
    label: "household",
    keywords: ["paper", "soap", "detergent", "bleach", "cleaner", "sponge"]
  },
  {
    label: "toiletries",
    keywords: ["shampoo", "toothpaste", "deodorant", "razor"]
  },
  {
    label: "tinned-jarred-dried",
    keywords: [
      "beans",
      "lentils",
      "chickpeas",
      "rice",
      "pasta",
      "oil",
      "vinegar",
      "salt",
      "pepper",
      "spice",
      "spices",
      "stock",
      "tomato paste",
      "tinned",
      "canned",
      "can"
    ]
  }
];

export const ALLOWED_LABELS = LABEL_RULES.map((rule) => rule.label);

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeScheduledDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = moment(trimmed);
  if (!parsed.isValid()) return null;
  return parsed.format("YYYY-MM-DD");
}

function firstValidScheduledDate(values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeScheduledDate(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

export function resolveScheduledDateFromFrontmatter(frontmatter: Record<string, unknown>): string | null {
  const fromScheduledDates = firstValidScheduledDate(
    Array.isArray(frontmatter.scheduledDates)
      ? frontmatter.scheduledDates
      : [frontmatter.scheduledDates]
  );
  if (fromScheduledDates) {
    return fromScheduledDates;
  }

  const fromScheduled = firstValidScheduledDate(
    Array.isArray(frontmatter.scheduled) ? frontmatter.scheduled : [frontmatter.scheduled]
  );
  if (fromScheduled) {
    return fromScheduled;
  }

  return normalizeScheduledDate(frontmatter.date);
}

const PREP_PHRASES = [
  "good-quality",
  "good quality",
  "quality",
  "fresh",
  "freshly",
  "finely",
  "roughly",
  "thinly",
  "thickly",
  "chopped",
  "minced",
  "sliced",
  "diced",
  "grated",
  "peeled",
  "crushed",
  "ground",
  "shredded",
  "julienned",
  "halved",
  "quartered",
  "trimmed",
  "rinsed",
  "drained",
  "optional",
  "to taste"
];

const PREP_PHRASES_PATTERN = new RegExp(
  `\\b(?:${PREP_PHRASES.map((p) => p.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|")})\\b`,
  "gi"
);

const WATER_DESCRIPTORS = new Set([
  "cold",
  "warm",
  "hot",
  "boiling",
  "ice",
  "iced",
  "filtered",
  "tap",
  "still",
  "sparkling"
]);

const INGREDIENT_ALIASES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bvegetable\s+broth\b/i, replacement: "veg stock" },
  { pattern: /\bveg(?:etable)?\s+stock\b/i, replacement: "veg stock" },
  { pattern: /\bparmesan\s+cheese\b/i, replacement: "parmesan" },
  { pattern: /\bfeta\s+cheese\b/i, replacement: "feta" }
];

const COUNT_UNIT_ALIASES: Record<string, string> = {
  clove: "clove",
  cloves: "clove",
  sprig: "sprig",
  sprigs: "sprig",
  bunch: "bunch",
  bunches: "bunch",
  stalk: "stalk",
  stalks: "stalk",
  stick: "stick",
  sticks: "stick",
  can: "can",
  cans: "can",
  tin: "tin",
  tins: "tin",
  jar: "jar",
  jars: "jar",
  pack: "pack",
  packs: "pack",
  bag: "bag",
  bags: "bag",
  piece: "piece",
  pieces: "piece",
  slice: "slice",
  slices: "slice",
  leaf: "leaf",
  leaves: "leaf"
};

const LABEL_OVERRIDES: Record<string, string> = {
  "butter bean": "tinned-jarred-dried",
  "butter beans": "tinned-jarred-dried",
  "brussels sprout": "fruit-and-veg",
  "brussels sprouts": "fruit-and-veg"
};

export const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "with",
  "of",
  "to",
  "for",
  "in",
  "on",
  "at",
  "from",
  "by",
  "plus",
  "into",
  "over",
  "under",
  "between",
  "without",
  "as"
]);

export function parseIngredientsSection(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const items: string[] = [];
  let inSection = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      if (inSection) break;
      if (/^##\s+Ingredients\b/i.test(line)) {
        inSection = true;
      }
      continue;
    }
    if (!inSection) continue;
    if (!line) continue;

    const cleaned = line
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .trim();
    if (cleaned) items.push(cleaned);
  }

  return items;
}

function readMachineIngredientValue(
  ingredient: MachineRecipeIngredientRecord
): string | null {
  const resolved =
    typeof ingredient.resolved_display_name === "string"
      ? ingredient.resolved_display_name.trim()
      : "";
  const raw = typeof ingredient.text === "string" ? ingredient.text.trim() : "";
  if (raw) return raw;
  if (resolved) return resolved;
  return null;
}

export function parseMachineRecipeIngredients(rawJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return [];
  }

  const ingredientsRaw =
    (parsed as { recipe?: { ingredients?: unknown } })?.recipe?.ingredients;
  if (!Array.isArray(ingredientsRaw)) {
    return [];
  }

  const ingredients: string[] = [];
  for (const item of ingredientsRaw) {
    if (!item || typeof item !== "object") continue;
    const value = readMachineIngredientValue(item as MachineRecipeIngredientRecord);
    if (value) {
      ingredients.push(value);
    }
  }
  return ingredients;
}

export function normalizeIgnoreValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function parseNumberToken(token: string): number | null {
  if (/^\d+\/\d+$/.test(token)) {
    const [num, den] = token.split("/");
    const n = Number(num);
    const d = Number(den);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
    return n / d;
  }
  if (/^\d+(\.\d+)?$/.test(token)) {
    const parsed = Number(token);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseQuantity(tokens: string[]): { quantity: number | null; consumed: number } {
  if (tokens.length === 0) return { quantity: null, consumed: 0 };
  const first = tokens[0];
  const attachedMatch = first.match(/^(\d+(?:\.\d+)?)([a-zA-Z]+)$/);
  if (attachedMatch) {
    const qty = parseNumberToken(attachedMatch[1]);
    if (qty !== null) {
      return { quantity: qty, consumed: 1 };
    }
  }

  const base = parseNumberToken(first);
  if (base === null) return { quantity: null, consumed: 0 };

  if (tokens.length > 1) {
    const fractional = parseNumberToken(tokens[1]);
    if (fractional !== null && Number.isInteger(base)) {
      return { quantity: base + fractional, consumed: 2 };
    }
  }
  return { quantity: base, consumed: 1 };
}

function normalizeUnitToken(token: string | undefined): string | null {
  if (!token) return null;
  const cleaned = token.toLowerCase().replace(/[.,]/g, "");
  return UNIT_ALIASES[cleaned] ?? null;
}

function normalizeCountUnitToken(token: string | undefined): string | null {
  if (!token) return null;
  const cleaned = token.toLowerCase().replace(/[.,]/g, "");
  return COUNT_UNIT_ALIASES[cleaned] ?? null;
}

function sanitizeIngredientName(value: string): string {
  let cleaned = value;

  cleaned = cleaned.replace(/\(.*\)/g, "");
  cleaned = cleaned.split(/[,;].*/)[0] ?? cleaned;

  cleaned = cleaned.replace(PREP_PHRASES_PATTERN, "");

  cleaned = cleaned.replace(/\b(of|and|with)\b\s*$/i, "");
  cleaned = normalizeSpaces(cleaned.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, " "));

  for (const alias of INGREDIENT_ALIASES) {
    if (alias.pattern.test(cleaned)) {
      cleaned = cleaned.replace(alias.pattern, alias.replacement);
      break;
    }
  }

  return normalizeSpaces(cleaned).toLowerCase();
}

export function abbreviateRecipeTitle(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/) // Split by one or more whitespace characters
    .filter(Boolean);
  const filtered = words.filter((word) => !STOP_WORDS.has(word));
  const selected = (filtered.length > 0 ? filtered : words).slice(0, 3);
  return selected.join(" ");
}

function convertToMetric(
  quantity: number,
  unit: string | null
): { quantity: number; unit: "g" | "ml" | "count" } {
  if (!unit) return { quantity, unit: "count" };
  switch (unit) {
    case "kg":
      return { quantity: quantity * 1000, unit: "g" };
    case "g":
      return { quantity, unit: "g" };
    case "l":
      return { quantity: quantity * 1000, unit: "ml" };
    case "ml":
      return { quantity, unit: "ml" };
    case "tsp":
      return { quantity: quantity * 5, unit: "ml" };
    case "tbsp":
      return { quantity: quantity * 15, unit: "ml" };
    case "cup":
      return { quantity: quantity * 240, unit: "ml" };
    case "oz":
      return { quantity: quantity * 28.3495, unit: "g" };
    case "lb":
      return { quantity: quantity * 453.592, unit: "g" };
    default:
      return { quantity, unit: "count" };
  }
}

export function normalizeNameForKey(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/\(.*\)/g, "")
    .replace(/\b(optional|to taste)\b/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.endsWith("s") && !cleaned.endsWith("ss")) {
    return cleaned.slice(0, -1);
  }
  return cleaned;
}

export function pluralize(name: string, quantity: number): string {
  if (quantity === 1) return name;
  const lower = name.toLowerCase();
  if (lower.endsWith("s")) return name;
  return `${name}s`;
}

export function formatMetricQuantity(
  quantity: number,
  unit: "g" | "ml" | "count" | null
): string {
  if (unit === "count") {
    const rounded = Number.isInteger(quantity) ? quantity : Number(quantity.toFixed(2));
    return `${rounded}`;
  }
  if (unit === "g" && quantity >= 1000) {
    const kg = quantity / 1000;
    const rounded = Number.isInteger(kg) ? kg : Number(kg.toFixed(2));
    return `${rounded}kg`;
  }
  if (unit === "ml" && quantity >= 1000) {
    const litres = quantity / 1000;
    const rounded = Number.isInteger(litres) ? litres : Number(litres.toFixed(2));
    return `${rounded}l`;
  }
  const rounded = Math.round(quantity);
  return `${rounded}${unit}`;
}

export function formatCountQuantity(quantity: number, unit: string | null): string {
  const rounded = Number.isInteger(quantity) ? quantity : Number(quantity.toFixed(2));
  if (!unit) return `${rounded}`;
  const resolvedUnit = rounded === 1 ? unit : `${unit}s`;
  return `${rounded} ${resolvedUnit}`;
}

export function labelForIngredient(name: string): string {
  const normalized = normalizeNameForKey(name);
  const override = LABEL_OVERRIDES[normalized];
  if (override) return override;
  for (const rule of LABEL_RULES) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword))) {
      return rule.label;
    }
  }
  return DEFAULT_LABEL;
}

function isWaterIngredient(name: string): boolean {
  const normalized = normalizeNameForKey(name);
  if (!normalized.includes("water")) return false;
  if (normalized === "water") return true;
  const words = normalized.split(" ").filter(Boolean);
  const filtered = words.filter((word) => word !== "water" && !WATER_DESCRIPTORS.has(word));
  return filtered.length === 0;
}

export function parseIngredientLine(line: string): ParsedIngredient | null {
  const cleaned = normalizeSpaces(line.replace(/^[-*+]\s+/, ""));
  if (!cleaned) return null;

  // Detect and handle mep-cli 3-pipe format: "- quantity | ingredient | label"
  if (cleaned.includes("|")) {
    const parts = cleaned.split("|").map((p) => p.trim());
    if (parts.length === 3) {
    const quantityRaw = parts[0] ?? "";
    const ingredientRaw = (parts[1] ?? "").toLowerCase();
    const labelRaw = parts[2] ?? "";

    const sanitizedName = sanitizeIngredientName(ingredientRaw);
    if (!sanitizedName || isWaterIngredient(sanitizedName)) {
      return null;
    }

    // We still use our local quantity parser to get metric values for aggregation
    const tokens = quantityRaw.split(" ").filter(Boolean);
    const { quantity, consumed } = parseQuantity(tokens);

    if (quantity === null) {
      return {
        displayName: sanitizedName,
        quantity: null,
        unit: null,
        countUnit: null
      };
    }
      let unitToken: string | null = null;
      let countUnit: string | null = null;
      let consumedUnit = false;

      if (consumed === 1) {
        const attachedMatch = tokens[0].match(/^(\d+(?:\.\d+)?)([a-zA-Z]+)$/);
        if (attachedMatch) {
          unitToken = normalizeUnitToken(attachedMatch[2]);
          if (!unitToken) {
            countUnit = normalizeCountUnitToken(attachedMatch[2]);
          }
          consumedUnit = Boolean(unitToken || countUnit);
        }
      }

      if (!consumedUnit) {
        unitToken = normalizeUnitToken(tokens[consumed]);
        if (!unitToken) {
          countUnit = normalizeCountUnitToken(tokens[consumed]);
        }
      }

      const metric = convertToMetric(quantity, unitToken);
      return {
        displayName: sanitizedName,
        quantity: metric.quantity,
        unit: unitToken ? metric.unit : "count",
        countUnit
      };
    }
  }

  const tokens = cleaned.split(" ");
  const { quantity, consumed } = parseQuantity(tokens);
  if (quantity === null) {
    const sanitizedName = sanitizeIngredientName(cleaned);
    if (!sanitizedName) return null;
    if (isWaterIngredient(sanitizedName)) return null;
    return {
      displayName: sanitizedName,
      quantity: null,
      unit: null,
      countUnit: null
    };
  }

  let unitToken: string | null = null;
  let countUnit: string | null = null;
  let nameStart = consumed;
  let consumedUnit = false;

  if (consumed === 1) {
    const attachedMatch = tokens[0].match(/^(\d+(?:\.\d+)?)([a-zA-Z]+)$/);
    if (attachedMatch) {
      unitToken = normalizeUnitToken(attachedMatch[2]);
      if (!unitToken) {
        countUnit = normalizeCountUnitToken(attachedMatch[2]);
      }
      nameStart = 1;
      consumedUnit = Boolean(unitToken || countUnit);
    }
  }

  if (!consumedUnit) {
    unitToken = normalizeUnitToken(tokens[consumed]);
    if (unitToken) {
      nameStart = consumed + 1;
    } else {
      countUnit = normalizeCountUnitToken(tokens[consumed]);
      if (countUnit) {
        nameStart = consumed + 1;
      }
    }
  }

  if (tokens[nameStart]?.toLowerCase() === "of") {
    nameStart += 1;
  }

  const name = normalizeSpaces(tokens.slice(nameStart).join(" "));
  const sanitizedName = sanitizeIngredientName(name);
  if (!sanitizedName) return null;
  if (isWaterIngredient(sanitizedName)) return null;

  const metric = convertToMetric(quantity, unitToken);
  return {
    displayName: sanitizedName,
    quantity: metric.quantity,
    unit: unitToken ? metric.unit : "count",
    countUnit
  };
}
