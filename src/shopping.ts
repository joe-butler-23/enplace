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

const preparationVerbs = "diced|sliced|chopped|cubed|grated|peeled|unpeeled|crushed|smashed|bashed|rinsed|washed|seeded|deseeded|cored|zested|juiced|trimmed|torn|shredded|beaten|divided|sifted|halved|quartered|crumbled|melted|whisked|warmed|minced|pitted|stoned|drained|pressed|softened";
const preparationModifier = "(?:(?:finely|roughly|coarsely|thinly|thickly|lightly|freshly)\\s+)?";
const preparationStart = new RegExp("^(?:" + preparationModifier + "(?:" + preparationVerbs + ")\\b|cut\\s+into\\b|(?:crusts?|skins?|seeds?|stems?|stalks?|cores?|pith|leaves?)\\s+(?:removed|picked)\\b|(?:plus\\s+more\\s+)?(?:to\\s+(?:taste|serve)|for\\s+\\w+)\\b|to\\s+get\\b|frozen\\s+for\\s+storage$|zest\\s+only$|\\d+(?:[-–—]\\d+)?\\s*(?:cloves?|heads?|bulbs?|stalks?|sprigs?|leaves?|bunches?)$)", "i");
const inlinePreparation = new RegExp("\\s+" + preparationModifier + "(?:" + preparationVerbs + "|cut\\s+into)\\b", "i");
const countPart = /^(cloves?|heads?|bulbs?|stalks?|sprigs?|bunches?)\s+(?:of\s+)?(.+)$|^(.+?)\s+(cloves?|heads?|bulbs?|stalks?|sprigs?|bunches?)$/i;

export function preparedName(name: string): string {
  // Remove quantity hints, never parenthesised product forms or alternatives.
  let product = name.replace(/\s+/g, " ").replace(/\(\s*(?:about\s+)?\d+(?:[./]\d+)?\s*(?:g|kg|ml|l|tsp|tbsp|small|medium|large|slices?|cloves?)\s*\)/gi, " ").trim()
    .replace(/^[,\s]*(?:plus\s+(?:more\s+)?for\s+(?:dusting|oiling|greasing|frying)\s+)/i, "");
  product = product.replace(/^(?:a\s+(?:handful|little|few|small\s+bunch)|some)(?:\s+(?:sprigs?|bunches?))?\s+(?:of\s+)?/i, "");
  product = product.replace(/^(.+),\s*(bone[- ]in|skin[- ]on|boneless|skinless)$/i, "$2 $1");
  product = product.replace(/^(.+),\s*(fine|coarse|flaky)$/i, "$2 $1");
  product = product.replace(/\b(lemon|lime|orange|grapefruit)(?:s)?\s+finely grated zest\b/gi, "$1 zest");
  const clauses = product.split(/,\s*/);
  const preparation = clauses.findIndex((clause, i) => i > 0 && preparationStart.test(clause));
  if (preparation >= 0 && clauses.slice(preparation).every(clause => !/\bor\b/i.test(clause) && preparationStart.test(clause.replace(/^(?:and\s+|(?:the\s+)?rest\s+|(?:[¼-¾⅐-⅞]|\d+(?:\/\d+)?|half)\s+(?:of\s+it\s+)?)/i, "")))) product = clauses.slice(0, preparation).join(", ");
  const inline = inlinePreparation.exec(product);
  if (inline) {
    const head = product.slice(0, inline.index);
    if (AISLE_RULES.some(([, rx]) => rx.test(head)) && !/[,]|\bor\b/i.test(product.slice(inline.index))) product = head;
  }
  return product.replace(/,?\s+to\s+(?:taste|serve)$/i, "").replace(/\s+/g, " ").trim() || name;
}

function countedProduct(name: string): { name: string; unit: string | null } {
  const match = countPart.exec(name);
  if (match && !AISLE_RULES.some(([, rx]) => rx.test(match[2] ?? match[3]))) return { name, unit: null };
  return match ? { name: match[2] ?? match[3], unit: singularize((match[1] ?? match[4]).toLowerCase()) + "s" } : { name, unit: null };
}

// Purchase identity; original recipe quantities remain in Shopping.md.
function purchaseFamily(noun: string): string {
  if (/^(?:(?:extra )?virgin )?olive oil$/.test(noun)) return "olive oil";
  if (/^(?:(?:fine|coarse|flaky) )?(?:(?:sea|kosher|table) )?salt$/.test(noun)) return "salt";
  return noun;
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
  let s = countedProduct(preparedName(text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim())).name;
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
    let name = preparedName(ingredient.name);
    let amount = ingredient.amount;
    const counted = countedProduct(name);
    if (counted.unit) {
      name = counted.name;
      if (amount && !amount.unit) amount = { ...amount, unit: counted.unit };
    }
    // A counted citrus fruit can supply zest/juice; a mass of zest is not fruit mass.
    if (amount && !amount.unit) name = name.replace(/^(.*?\b(?:lemon|lime|orange|grapefruit)s?)[,\s]+(?:zest|finely grated zest)\b.*$/i, "$1");
    return {
      noun: normalizeShoppingNoun(name),
      name,
      display: ingredient.display,
      amount,
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
  return lower;
}

export function mergeShoppingItems(items: readonly ShoppingItem[]): ShoppingRow[] {
  type GroupData = {
    row: ShoppingRow;
    amounts: Map<string | null, { unit: string | null; factor: Rational }>;
    unquantified: Map<string, string>;
    sources: Set<string>;
  };
  const groups = new Map<string, GroupData>();

  for (const item of items) {
    const { noun, name, display, amount } = shoppingIngredient(item.content);
    const unit = normalizeUnit(amount?.unit ?? null);
    const isPackaged = /^(?:cans?|tins?|jars?)$/.test(unit ?? "");
    const family = purchaseFamily(noun);
    const groupKey = JSON.stringify([family, isPackaged, item.aisle ?? item.labels[0] ?? ""]);

    let group = groups.get(groupKey);
    if (!group) {
      group = {
        row: {
          ...item,
          content: family === "salt" || family !== noun ? family : name,
          memberIds: [],
          checked: true,
          checkedCount: 0,
        },
        sources: new Set(),
        amounts: new Map(),
        unquantified: new Map(),
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
        group.amounts.set(unit, { unit, factor: current ? addRational(current.factor, factor) : factor });
      } catch {
        const key = display.toLowerCase();
        if (!group.unquantified.has(key)) group.unquantified.set(key, display);
      }
    } else {
      const key = display.toLowerCase();
      if (!group.unquantified.has(key)) group.unquantified.set(key, display);
    }
  }

  return [...groups.values()].map(({ row, amounts, unquantified, sources }) => {
    const totals = [...amounts.values()];
    const quantity = ({ unit, factor }: typeof totals[number]) => `${formatRational(factor)}${unit ? ` ${unit}` : ""}`;
    const quantified = totals.length ? `${totals.map(quantity).join(" + ")} ${row.content}` : "";
    let content = [quantified, ...unquantified.values()].filter(Boolean).join(" + ");
    if (row.content === "salt") {
      content = quantified || "salt";
      if (totals.length > 1) {
        const mass = totals.some(total => total.unit === "g" || total.unit === "kg");
        const factors = new Map<string, bigint>(mass ? [["g", 1n], ["kg", 1000n], ["tsp", 6n], ["tbsp", 18n]] : [["tsp", 1n], ["tbsp", 3n]]);
        if (totals.every(total => total.unit && factors.has(total.unit))) {
          const sum = totals.reduce((sum, total) => addRational(sum, rational(total.factor[0] * factors.get(total.unit!)!, total.factor[1])), rational(0n));
          // Shopping estimate only: salt crystal size makes volume-to-mass inexact.
          const approximate = mass && totals.some(total => total.unit === "tsp" || total.unit === "tbsp");
          content = `${approximate ? "≈" : ""}${formatRational(sum)} ${mass ? "g" : "tsp"} salt`;
        } else content = "salt";
      }
    }
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

const AISLE_RULES: ReadonlyArray<[string, RegExp]> = [
  ["Frozen", /^frozen\b/i],
  ["Tins & jars", /^(?:can|tin|jar|cans|tins|jars|canned|tinned|jarred)\b/i],
  ["Fruit & vegetables", /\bfresh\s+(?:coriander|basil|parsley|mint|dill|rosemary|thyme|chive|chives|cilantro|tarragon|sage|oregano)(?:\s+(?:leaf|leaves))?$/i],
  ["Herbs, spices & oils", /\b(?:dried|ground)\s+(?:ginger|coriander|basil|parsley|mint|dill|rosemary|thyme|chive|chives|cilantro|tarragon|sage|oregano)(?:\s+(?:leaf|leaves))?$/i],
  ["Tins & jars", /\b(?:peanut|groundnut|almond|cashew|seed|nut)\s+butter$/i],
  ["Tins & jars", /\bcoconut\s+(?:milk|cream)$/i],
  ["Baking", /\b(?:(?:cocoa|cacao)\s+(?:butter|powder)|shea\s+butter)$/i],
  ["Herbs, spices & oils", /\b(?:black|white|cracked|cayenne|ground)\s+pepp?er(?:corn)?s?$/i],
  ["Fruit & vegetables", /\b(?:bell|sweet|green|red|yellow|poblano|serrano)\s+peppers?$/i],
  ["Baking", /(?:^|\s)(?:flours?|sugars?|yeasts?|syrups?|treacles?|molasses|nectars?|baking powder|bicarbonate|cornstarch|cornflour|starches?|icings?|chocolates?|pastr(?:y|ies)|extracts?|essences?|malt powder|nuts?|walnuts?|pecans?|almonds?|cashews?|pistachios?|hazelnuts?|pine nuts?|peanuts?)$/i],
  ["Herbs, spices & oils", /(?:^|\s)(?:oils?|vinegars?|powders?|peppercorns?|chilli flakes|chili flakes|seasonings?|spices?|rubs?|masalas?|seeds?|salts?|cumins?|corianders?|cinnamons?|paprikas?|turmerics?|cardamoms?|nutmegs?|cloves?|saffrons?|cayennes?|oreganos?|basils?|thymes?|rosemarys?|sages?|dills?|tarragons?|parsleys?|mints?|cilantros?|bay leaves?|bay leaf|chives?|curry leaves?|marjoram|za['’]?atar|seaweed|nori|amchur|achiote|gochugaru)$/i],
  ["Tins & jars", /(?:^|\s)(?:sauces?|pastes?|chutneys?|pickles?|jams?|marmalades?|mustards?|ketchups?|mayos?|mayonnaises?|relishes?|stocks?|broths?|misos?|harissas?|srirachas?|sambals?|gochujang|tamaris?|aminos?|olives?|capers?|passatas?|purees?|pestos?|tahinis?|honeys?)$/i],
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

  const base = preparedName(clean).normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  if (/\bsoaked\b/i.test(clean)) return null;
  if (/^(?:lemon|lime|orange|grapefruit)s?\s+zest(?:\s*(?:and|&)\s*juice)?$/i.test(base)) return "Fruit & vegetables";
  const alternatives = base.split(/,\s*(?:(?:or|and)\s+)?|\s+(?:or|and)\s+|\s*&\s*/i);
  const classify = (name: string) => AISLE_RULES.find(([, rx]) => rx.test(name.trim()))?.[0];
  const head = alternatives[alternatives.length - 1]?.trim().split(/\s+/).pop() ?? "";
  if (alternatives.length === 1 && /^(?:cans?|tins?|jars?)$/i.test(parsed.amount?.unit?.trim() ?? "")) return "Tins & jars";
  // Only adjective alternatives inherit a shared head; known nouns keep their own aisle.
  const aisles = alternatives.map(name => classify(name) ?? (/^(?:white|brown|green|red|yellow|orange|black|french|italian|white sandwich)$/i.test(name.trim()) ? classify(`${name} ${head}`) : undefined));
  return aisles[0] && aisles.every(aisle => aisle === aisles[0]) ? aisles[0] : null;
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

