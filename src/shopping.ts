import { parseRecipeIngredient, type RecipeAmount } from "./recipemd.js";

export type ShoppingItem = {
  id: string;
  content: string;
  labels: string[];
  aisle?: string;
  sources?: string[];
  checked: boolean;
};

export type ShoppingRow = ShoppingItem & {
  memberIds: string[];
  partial?: boolean;
  checkedCount?: number;
};

const PLURALS_TO_SINGULAR = new Map([
  ["leaves", "leaf"],
  ["halves", "half"],
  ["loaves", "loaf"],
  ["tomatoes", "tomato"],
  ["potatoes", "potato"],
  ["cherries", "cherry"],
  ["berries", "berry"],
  ["raspberries", "raspberry"],
  ["strawberries", "strawberry"],
  ["blueberries", "blueberry"],
  ["blackberries", "blackberry"],
  ["olives", "olive"],
  ["onions", "onion"],
  ["scallions", "scallion"],
  ["peppers", "pepper"],
  ["peas", "pea"],
  ["beans", "bean"],
  ["cloves", "clove"],
  ["heads", "head"],
  ["bones", "bone"],
  ["thighs", "thigh"],
  ["breasts", "breast"],
  ["fillets", "fillet"],
  ["seeds", "seed"],
  ["pods", "pod"],
]);

export function singularize(word: string): string {
  const custom = PLURALS_TO_SINGULAR.get(word);
  if (custom) return custom;
  if (word.endsWith("us")) return word;
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (word.endsWith("es") && word.length > 3 && /(?:ch|sh|ss|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 2) return word.slice(0, -1);
  return word;
}

const operation = "(?:(?:finely|roughly|coarsely|thinly|thickly|lightly)\\s+)?(?:diced|sliced|chopped|cubed|grated|peeled|crushed|rinsed|washed|deseeded|zested|juiced|trimmed|torn|shredded|beaten|divided|sifted|halved|quartered|crumbled|melted|whisked|cut\\s+into\\s+[a-z\\s]+|half\\s+juiced[a-z\\s]+|to\\s+serve|for\\s+serving|to\\s+taste|for\\s+(?:dusting|frying|greasing|garnish|garnishing|drizzling)|zest\\s+only|fine|minced|\\d+(?:[-–—]\\d+)?\\s*(?:cloves?|heads?|bulbs?|stalks?|sprigs?|leaves?|bunches?))";
const operationTail = new RegExp("^\\s*" + operation + "(?:(?:\\s+and\\s+|,\\s*(?:and\\s+)?)" + operation + ")*\\s*$", "i");

export function preparedName(name: string): string {
  const comma = name.indexOf(",");
  return comma >= 0 && operationTail.test(name.slice(comma + 1)) ? name.slice(0, comma).trim() : name;
}

export const PHRASE_EQUIVALENCES: Array<[string, string]> = [
  // Transatlantic Produce
  ["aubergine", "eggplant"],
  ["courgette", "zucchini"],
  ["rocket", "arugula"],
  ["spring onion", "scallion"],
  ["beetroot", "beet root"],
  ["swede", "rutabaga"],
  ["okra", "lady finger"],
  ["swiss chard", "silverbeet"],
  ["pak choi", "bok choy"],
  ["chinese napa cabbage", "napa cabbage"],
  ["lamb lettuce", "mache"],
  ["broad bean", "fava bean"],
  ["chickpea", "garbanzo bean"],
  ["cannellini bean", "white kidney bean"],
  ["black-eyed pea", "black-eyed bean"],
  ["sugar snap pea", "snap pea"],
  ["corn on the cob", "maize on the cob"],
  ["bell pepper", "sweet pepper"],
  ["groundnut", "peanut"],
  ["hazelnut", "filbert"],
  ["prune", "dried plum"],
  ["jerusalem artichoke", "sunchoke"],
  ["borlotti bean", "cranberry bean"],
  ["daikon radish", "mooli"],
  ["cassava root", "yuca root"],
  ["fresh coriander leaf", "fresh cilantro"],

  // Spices & herbs
  ["methi seed", "fenugreek seed"],
  ["nigella seed", "kalonji seed"],
  ["ajwain seed", "carom seed"],
  ["asafoetida powder", "hing powder"],
  ["cayenne pepper powder", "ground cayenne pepper"],
  ["star anise pod", "whole star anise"],
  ["ground mustard seed", "mustard powder"],
  ["ground cumin", "cumin powder"],
  ["ground coriander seed", "coriander powder"],
  ["ground cinnamon", "cinnamon powder"],
  ["ground ginger", "ginger powder"],
  ["ground turmeric", "turmeric powder"],

  // Pantry & baking
  ["icing sugar", "powdered sugar"],
  ["caster sugar", "superfine sugar"],
  ["bicarbonate of soda", "baking soda"],
  ["cornstarch", "corn starch"],
  ["low-erucic rapeseed oil", "canola oil"],
  ["roasted sesame oil", "toasted sesame oil"],
  ["almond meal", "ground almond"],
  ["plain yogurt", "plain yoghurt"],
  ["whole-wheat flour", "wholemeal wheat flour"],
  ["canned diced tomato", "tinned chopped tomato"],

  // Meat cuts & descriptors
  ["ground beef", "minced beef"],
  ["ground pork", "minced pork"],
  ["ground turkey", "minced turkey"],
  ["ground chicken", "minced chicken"],
  ["salmon fillet without skin", "skinless salmon fillet"],
  ["chicken thigh with bone removed", "boneless chicken thigh"],
  ["chicken breast without skin", "skinless chicken breast"],
  ["stoned green olive", "pitted green olive"],
  ["stoned date", "pitted date"],
  ["stoned sour cherry", "pitted sour cherry"],
  ["halved pecan", "pecan half"],
  ["chicory head (belgian endive)", "belgian endive"],
  ["chicory head", "belgian endive"],
];

const CANONICAL = new Map<string, string>();
for (const [left, right] of PHRASE_EQUIVALENCES) {
  const normL = left.toLowerCase().replace(/[-]/g, " ").replace(/\s+/g, " ").trim();
  const normR = right.toLowerCase().replace(/[-]/g, " ").replace(/\s+/g, " ").trim();
  const canon = normL < normR ? normL : normR;
  CANONICAL.set(normL, canon);
  CANONICAL.set(normR, canon);
}

const CANONICAL_REGEX = new RegExp("\\b(?:" + [...CANONICAL.keys()]
  .sort((a, b) => b.length - a.length)
  .map(variant => variant.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"))
  .join("|") + ")\\b", "g");

export function normalizeShoppingNoun(text: string): string {
  if (typeof text !== "string") return "";
  let s = preparedName(text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim());
  s = s.replace(/['\u2019]s\b/g, "");
  s = s.replace(/(?<=[a-z])-(?=[a-z])/g, " ");
  s = s.replace(/\s+/g, " ").trim();

  const words = s.split(" ").map(w => singularize(w));
  s = words.join(" ");

  if (CANONICAL.has(s)) return CANONICAL.get(s)!;

  s = s.replace(CANONICAL_REGEX, match => CANONICAL.get(match)!);

  return s.replace(/\s+/g, " ").trim();
}

export function classifyShoppingPair(a: string, b: string): { relation: "same" | "different" | "unknown"; score?: number } {
  if (typeof a !== "string" || typeof b !== "string") return { relation: "unknown" };
  const normA = normalizeShoppingNoun(a);
  const normB = normalizeShoppingNoun(b);
  if (normA && normB && normA === normB) return { relation: "same", score: 1.0 };
  return { relation: "unknown" };
}

export function shoppingIngredient(text: string): {
  noun: string;
  name: string;
  display: string;
  amount: RecipeAmount | null;
} {
  const clean = text.replace(/<!--[\s\S]*?-->/g, "").trim();
  try {
    const ingredient = parseRecipeIngredient(clean, true);
    return {
      noun: normalizeShoppingNoun(ingredient.name),
      name: ingredient.name,
      display: ingredient.display,
      amount: ingredient.amount,
    };
  } catch {
    return {
      noun: normalizeShoppingNoun(clean),
      name: clean,
      display: clean,
      amount: null,
    };
  }
}

// Bounded rational arithmetic
export type Rational = [bigint, bigint];

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a, y = b < 0n ? -b : b;
  while (y) { const t = y; y = x % y; x = t; }
  return x || 1n;
}

export function rational(n: bigint, d = 1n): Rational {
  if (d === 0n) throw new RangeError("Zero denominator");
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return [n / g, d / g];
}

export function parseRational(text: string): Rational {
  const trimmed = text.trim();
  if (trimmed.includes("/")) {
    const [n, d] = trimmed.split("/").map(s => BigInt(s.trim()));
    return rational(n, d);
  }
  if (trimmed.includes(".")) {
    const [whole, frac = ""] = trimmed.split(".");
    const d = 10n ** BigInt(frac.length);
    const n = BigInt(whole + frac);
    return rational(n, d);
  }
  return rational(BigInt(trimmed), 1n);
}

export function addRational([a, b]: Rational, [c, d]: Rational): Rational {
  return rational(a * d + c * b, b * d);
}

export function formatRational([n, d]: Rational): string {
  if (d === 1n) return String(n);
  if (d === 2n || d === 4n || d === 5n || d === 10n) {
    const hundredths = (n < 0n ? -n : n) * (100n / d);
    const digits = String(hundredths).padStart(3, "0");
    return `${n < 0n ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`.replace(/0+$/, "").replace(/\.$/, "");
  }
  return `${n}/${d}`;
}

function normalizeUnit(unit: string | null): string | null {
  if (!unit) return null;
  const lower = unit.toLowerCase();
  if (lower === "cans" || lower === "can") return "cans";
  if (lower === "tins" || lower === "tin") return "tins";
  if (lower === "tablespoons" || lower === "tablespoon") return "tbsp";
  if (lower === "teaspoons" || lower === "teaspoon") return "tsp";
  if (lower === "grams" || lower === "gram") return "g";
  if (lower === "kilograms" || lower === "kilogram") return "kg";
  if (lower === "millilitres" || lower === "millilitre" || lower === "milliliters" || lower === "milliliter") return "ml";
  if (lower === "litres" || lower === "litre" || lower === "liters" || lower === "liter") return "l";
  return unit;
}

export function mergeShoppingItems(items: readonly ShoppingItem[]): ShoppingRow[] {
  type GroupData = {
    row: ShoppingRow;
    amounts: Map<string | null, Rational>;
    unquantified: Map<string, string>;
    displayName: string;
    sources: Set<string>;
  };
  const groups = new Map<string, GroupData>();

  for (const item of items) {
    const { noun, name, display, amount } = shoppingIngredient(item.content);
    const unit = normalizeUnit(amount?.unit ?? null);
    const isPackaged = unit === "cans" || unit === "tins";
    const groupKey = isPackaged ? `${noun}:package` : noun;

    let group = groups.get(groupKey);
    if (!group) {
      group = {
        row: {
          ...item,
          content: preparedName(name),
          memberIds: [],
          checked: true,
          checkedCount: 0,
        },
        sources: new Set(),
        amounts: new Map(),
        unquantified: new Map(),
        displayName: preparedName(name),
      };
      groups.set(groupKey, group);
    }
    group.row.memberIds.push(item.id);
    for (const source of item.sources ?? []) group.sources.add(source);
    if (item.labels?.length && !group.row.labels?.length) group.row.labels = item.labels;
    if (item.aisle && !group.row.aisle) group.row.aisle = item.aisle;
    if (item.checked) {
      group.row.checkedCount = (group.row.checkedCount ?? 0) + 1;
    } else {
      group.row.checked = false;
    }

    if (amount) {
      try {
        const factor = parseRational(amount.factor);
        const current = group.amounts.get(unit);
        group.amounts.set(unit, current ? addRational(current, factor) : factor);
      } catch {
        const key = display.toLowerCase();
        if (!group.unquantified.has(key)) group.unquantified.set(key, display);
      }
    } else {
      const key = display.toLowerCase();
      if (!group.unquantified.has(key)) group.unquantified.set(key, display);
    }
  }

  return [...groups.values()].map(({ row, amounts, unquantified, displayName, sources }) => {
    const quantities = [...amounts].map(([unit, factor]) => `${formatRational(factor)}${unit ? ` ${unit}` : ""}`);
    const quantified = quantities.length ? `${displayName} ${quantities.join(" + ")}` : "";
    const content = [quantified, ...unquantified.values()].filter(Boolean).join(" + ");
    const totalMembers = row.memberIds.length;
    const checkedCount = row.checkedCount ?? 0;
    const partial = checkedCount > 0 && checkedCount < totalMembers;
    return {
      ...row,
      sources: [...sources],
      content,
      partial,
    };
  });
}

export type ShoppingIngredientInput = {
  noun: string;
  name?: string;
  amount?: RecipeAmount | null;
};

const PHRASE_RULES: ReadonlyArray<[string, RegExp]> = [
  ["Frozen", /^frozen\b/i],
  ["Tins & jars", /^(?:can|tin|jar|cans|tins|jars|canned|tinned|jarred)\b/i],
  ["Fruit & vegetables", /\bfresh\s+(?:coriander|basil|parsley|mint|dill|rosemary|thyme|chive|chives|cilantro|tarragon|sage|oregano)$/i],
  ["Herbs, spices & oils", /\b(?:dried|ground)\s+(?:coriander|basil|parsley|mint|dill|rosemary|thyme|chive|chives|cilantro|tarragon|sage|oregano)$/i],
  ["Tins & jars", /\b(?:peanut|groundnut|almond|cashew|seed|nut)\s+butter$/i],
  ["Tins & jars", /\bcoconut\s+(?:milk|cream)$/i],
  ["Tins & jars", /\bolives?(?:\s+(?:pitted|stoned|chopped)(?:\s+and\s+(?:pitted|stoned|chopped))*)?$/i],
  ["Baking", /\b(?:cocoa|cacao|shea)\s+butter$/i],
  ["Herbs, spices & oils", /\b(?:black|white|cracked|cayenne|ground)\s+pepp?er(?:corn)?s?$/i],
  ["Fruit & vegetables", /\b(?:bell|sweet|green|red|yellow|poblano|serrano)\s+peppers?$/i],
];

const SUFFIX_RULES: ReadonlyArray<[string, RegExp]> = [
  ["Baking", /(?:^|\s)(?:flours?|sugars?|yeasts?|syrups?|treacles?|molasses|nectars?|baking powder|bicarbonate|cornstarch|cornflour|starches?|icings?|chocolates?|pastr(?:y|ies)|extracts?|essences?|malt powder|nuts?|walnuts?|pecans?|almonds?|cashews?|pistachios?|hazelnuts?|pine nuts?|peanuts?)$/i],
  ["Herbs, spices & oils", /(?:^|\s)(?:oils?|vinegars?|powders?|peppercorns?|chilli flakes|chili flakes|seasonings?|spices?|rubs?|masalas?|seeds?|salts?|cumins?|corianders?|cinnamons?|paprikas?|turmerics?|cardamoms?|nutmegs?|cloves?|saffrons?|cayennes?|oreganos?|basils?|thymes?|rosemarys?|sages?|dills?|tarragons?|parsleys?|mints?|cilantros?|bay leaves?|bay leaf|chives?|curry leaves?|marjoram|za['’]?atar|seaweed|nori|amchur|achiote|gochugaru)$/i],
  ["Tins & jars", /(?:^|\s)(?:sauces?|pastes?|chutneys?|pickles?|jams?|marmalades?|mustards?|ketchups?|mayos?|mayonnaises?|relishes?|stocks?|broths?|misos?|harissas?|srirachas?|sambals?|gochujang|tamaris?|aminos?|capers?|passatas?|purees?|pestos?|tahinis?|honeys?)$/i],
  ["Dairy & eggs", /(?:^|\s)(?:cheeses?|milks?|creams?|yoghurts?|yogurts?|butters?|eggs?|ghees?|cheddar|parmesan|mozzarella|ricotta|feta|halloumi|brie|gouda|camembert|gruyere|mascarpone|paneer|pecorino|grana padano|quark)$/i],
  ["Meat & fish", /(?:^|\s)(?:steaks?|fillets?|minces?|sausages?|chops?|breasts?|thighs?|wings?|bacons?|pancetta|hams?|prosciutto|salami|chorizo|salmons?|tunas?|cods?|haddocks?|prawns?|shrimps?|crabs?|lobsters?|mussels?|clams?|scallops?|anchov(?:y|ies)|sardines?|mackerels?|trouts?|beefs?|lambs?|porks?|chickens?|turkeys?|ducks?|lards?|suets?|speck)$/i],
  ["Bakery", /(?:^|\s)(?:breads?|loaf|loaves|bagels?|croissants?|rolls?|buns?|tortillas?|wraps?|pitas?|pittas?|naans?|rotis?|flatbreads?|scones?|brioches?|ciabattas?|baguettes?|crumpets?|muffins?|breadcrumbs?|panko|toasts?|biscuits?|starters?)$/i],
  ["Rice, pasta & grains", /(?:^|\s)(?:rices?|pastas?|noodles?|spaghetti|fusilli|penne|linguine|macaroni|couscous|quinoas?|lentils?|chickpeas?|oats?|barleys?|bulgurs?|farros?|orzos?|polentas?|buckwheats?|millets?|cornmeals?)$/i],
  ["Chilled", /(?:^|\s)(?:tofus?|tempehs?|hummuses?|hummus|dips?|seitans?|sauerkrauts?|kimchis?)$/i],
  ["Drinks", /(?:^|\s)(?:teas?|coffees?|wines?|beers?|ciders?|juices?|sodas?|colas?|lagers?|rieslings?|burgund(?:y|ies)|kirsch|moscatels?|waters?|espressos?)$/i],
  ["Fruit & vegetables", /(?:^|\s)(?:onions?|garlics?|tomatoes?|potatoes?|carrots?|celerys?|courgettes?|zucchinis?|aubergines?|eggplants?|broccolis?|cauliflowers?|cabbages?|spinachs?|kales?|lettuces?|rockets?|arugulas?|cucumbers?|peppers?|chill(?:i|is|ies)|chilis?|jalapenos?|jalapeños?|mushrooms?|avocados?|apples?|bananas?|lemons?|limes?|oranges?|pears?|berr(?:y|ies)|strawberr(?:y|ies)|raspberr(?:y|ies)|blueberr(?:y|ies)|blackberr(?:y|ies)|mangos?|mangoes?|pineapples?|peaches?|plums?|gingers?|squash(?:es)?|pumpkins?|beetroots?|radishes?|parsnips?|asparagus|artichokes?|corns?|scallions?|spring onions?|shallots?|peas?|beans?|fennels?|leeks?|swedes?|turnips?|sweet potatoes?|watermelons?|melons?|grapefruits?|pomegranates?|figs?|dates?|cherr(?:y|ies)|apricots?|kiwis?|papayas?|brussels sprouts?|rhubarbs?|radicchios?|chards?|lemongrass|plantains?|yucas?|sprouts?|endives?|alfalfa|watercress)$/i],
  ["Household", /(?:^|\s)(?:foils?|sponges?|bleaches?|detergents?|soaps?|clingfilms?|towels?|tissues?|cleaners?|sprays?|ramekins?)$/i],
];

/**
 * Infers an aisle from explicit packaging, product phrases, and noun heads.
 * Returns null if no confident aisle matches.
 */
export function inferAisle(
  ingredient: ShoppingIngredientInput | string
): string | null {
  if (!ingredient) return null;

  const parsed = typeof ingredient === "string" ? shoppingIngredient(ingredient) : ingredient;
  const clean = (parsed.name ?? parsed.noun ?? "").trim();
  if (!clean || /^\*\*.*\*\*$/.test(clean) || /^(?:for the|to serve|to garnish):?$/i.test(clean)) {
    return null;
  }

  if (/^(?:cans?|tins?|jars?)$/i.test(parsed.amount?.unit?.trim() ?? "")) return "Tins & jars";

  // Base noun without connector prefix, preparation commas, or parentheticals
  const base = clean.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/^[,\s;:-]+(?:plus\s+more\s+for\s+\w+\s+|plus\s+for\s+\w+\s+|plus\s+more\s+)?/i, "")
    .split(",")[0]
    .replace(/\([^)]*\)/g, "")
    .trim();

  // Only product identity participates; preparation tails cannot override its aisle.
  for (const [aisle, rx] of PHRASE_RULES) {
    if (rx.test(base)) return aisle;
  }

  // Match the complete product head, never a prefix within another word.
  for (const [aisle, rx] of SUFFIX_RULES) {
    if (rx.test(base)) {
      if (aisle === "Drinks" && /\b(?:or|and|soaked)\b/i.test(base)) return null;
      return aisle;
    }
  }

  return null;
}

/**
 * Resolves the shopping aisle for an ingredient with user preference sovereignty:
 * Layer 1: Household assignment from Aisles.md (if present)
 * Layer 2: Unified priority sieve inference
 * Layer 3: Fallback to "Other"
 */
export function resolveShoppingAisle(
  ingredient: ShoppingIngredientInput | string,
  householdAisles?: ReadonlyMap<string, string>
): string {
  if (!ingredient) return "Other";
  const rawNoun = typeof ingredient === "string"
    ? ingredient
    : (ingredient.noun ?? ingredient.name ?? "");
  const explicit = householdAisles?.get(normalizeShoppingNoun(rawNoun));
  return explicit ?? inferAisle(ingredient) ?? "Other";
}

