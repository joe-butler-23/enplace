// Vendored from the RecipeClipper browser rewrite (src/index.js at commit 0020283, SHA256 b514c7af76723c4a…),
// MIT licensed, with attribution to Julian Poyourow for the original project. Sync from that
// repository rather than editing here; the module reads a parsed Document and never fetches.

const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const has = value => Array.isArray(value) ? value.some(has) : (typeof value === 'string' ? value.trim() : value != null);
const isType = (value, type) => array(value).some(v =>
  v === type || v === `https://schema.org/${type}` || v === `http://schema.org/${type}`);
const clean = value => value && (value.includes('\u200b') || value.includes('\ufeff') ? value.replace(/[\u200b\ufeff]/g, '') : value).replace(/\r\n?/g, '\n').split('\n')
  .map(line => line.replace(/[\t \u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
const blocks = 'br,p,div,li,section,h1,h2,h3,h4,h5,h6,tr';
const classes = names => names.split(' ').map(name => `[class*="${name}" i]`).join(',');
const cardClasses = ['wprm-recipe-container', 'tasty-recipes', 'recipe-card', 'hrecipe', 'h-recipe'];
const cardSelector = cardClasses.map(name => `.${name}`).join(',');
const fields = {
  name: ['.wprm-recipe-name,.tasty-recipes-title', classes('recipe-name recipe-title'), 'h1'],
  description: ['.wprm-recipe-summary'],
  recipeYield: [classes('yield servings')],
  prepTime: [classes('prep_time prep-time')],
  totalTime: [classes('total_time total-time')],
  ingredients: ['[itemprop~="recipeIngredient"],[itemprop~="ingredients"]', 'li.ingredient,li.p-ingredient,li[class*="ingredientItem" i],li[class*="ingredient-item" i],tr[class*="ingredient-row" i]', classes('ingredients ingredientlist ingredient-list')],
  instructions: ['[itemprop~="recipeInstructions"],[itemprop~="instructions"]', classes('instruction direction method steps step-by-step preparation')],
  notes: [classes('notes')],
  nutrition: [classes('nutrition nutrient')],
};

// A tab panel is concealed when its own tab is unselected while a sibling tab in the same list is selected.
const unselectedPanel = el => {
  if (el.getAttribute('role') !== 'tabpanel') return false;
  const owner = el.ownerDocument, labels = el.getAttribute('aria-labelledby');
  const tab = el.id && owner.querySelector(`[role="tab"][aria-controls~="${CSS.escape(el.id)}"]`) ||
    (labels ? owner.getElementById(labels.trim().split(/\s+/)[0]) : null);
  return !!tab && tab.getAttribute('aria-selected') === 'false' &&
    !!tab.closest('[role="tablist"]')?.querySelector('[role="tab"][aria-selected="true"]');
};
const concealed = el => el.hidden || el.getAttribute('aria-hidden') === 'true' || el.style?.display === 'none' || unselectedPanel(el);
const hiddenByAncestor = el => {
  for (; el; el = el.parentElement) if (concealed(el)) return true;
  return false;
};

// Visible list markers and bare step counters carry no recipe text of their own.
const counter = /^(?:(?:step|steps|schritt|étape|etape|paso|passo|stap|krok|trin|steg|vaihe|lépés|adım|шаг|крок|βήμα|步骤|ステップ|단계)\s*)?\(?\d{1,3}[.:)]?$/iu;
// A short digit-free row that names a group ("For the sauce", "Sauce:") captions the rows after it.
const captionRow = /^(?:[^\d:\[]{2,40}:|for (?:the|serving|garnish)\b[^\d]{0,40}|to (?:serve|finish|garnish)|für [^\d]{2,40}|pour (?:la|le|les|l['’])[^\d]{1,40}|para (?:la|el|los|las) [^\d]{1,40}|voor (?:de|het) [^\d]{1,40})$/iu;
const presentable = (line, steps) => {
  const code = line.charCodeAt(0), alphanumeric = code >= 0x30 && code <= 0x39 || (code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a;
  if (code >= 0x2022) line = line.replace(/^[•▢◻●■▪▫○□‣◦]\s*/u, '');
  if (!alphanumeric && !/[\p{L}\p{N}]/u.test(line)) return '';
  if (steps) return line.length <= 16 && counter.test(line) ? `[${line}]` : line;
  // Only a row ending in a colon or opening with a caption word can be a caption; most rows open with a digit.
  const first = code | 0x20, colon = line.charCodeAt(line.length - 1) === 0x3a;
  return line.length <= 48 && (colon || first === 0x66 || first === 0x74 || first === 0x70 || first === 0x76) && captionRow.test(line) ? `[${line.replace(/:$/, '').trim()}]` : line;
};

// Row identity across serialisations: numbers by value, words by letters, punctuation ignored.
const fractionValues = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875, '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8, '⅙': 1 / 6, '⅚': 5 / 6 };
const numeral = value => String(Math.round(value * 100) / 100);
const rowKey = line => (line.toLowerCase()
  .replace(/(\d+)\s+(\d+)\s*\/\s*(\d+)/g, (_, a, b, c) => numeral(+a + b / c))
  .replace(/(\d+)\s*\/\s*(\d+)/g, (_, a, b) => numeral(a / b))
  .replace(/(\d+)\s*([¼½¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚])/g, (_, a, f) => numeral(+a + fractionValues[f]))
  .replace(/[¼½¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚]/g, f => numeral(fractionValues[f]))
  .match(/\d+(?:[.,]\d+)?|\p{L}+/gu) || []).map(token => /^\d/.test(token) ? numeral(parseFloat(token.replace(',', '.'))) : token).sort().join(' ');
const numeralPattern = /\d+(?:\s+\d+\s*\/\s*\d+|\s*\/\s*\d+|[.,]\d+)?(?:\s*[¼½¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚])?|[¼½¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚]/g;

// A row that opens with a quantity.
const quantityLine = /^(?:\d|[¼½¾⅓⅔⅛⅜⅝⅞]|(?:around|about|approx\.?|roughly) \d)/iu;

const labels = new Map([
  ...['ingredients', "what you'll need", 'what you’ll need', 'what you will need', 'you will need', 'ingrédients', 'ingrediënten', 'ingredientes', 'ingredienti', 'ingredienser', 'zutaten', 'składniki', 'hozzávalók', 'suroviny', 'υλικά', 'ингредиенты', '材料', '用料'].map(label => [label, 'ingredients']),
  ...['instructions', 'cooking instructions', 'directions', 'method', 'procedure', 'steps', 'preparation', 'how to make it', "here's how to make it", 'here’s how to make it', 'préparation', 'zubereitung', 'bereiden', 'bereiding', 'bereidingswijze', 'preparación', 'elaboración', 'preparazione', 'preparação', 'modo de preparo', 'fremgangsmåde', 'tilberedning', 'gör så här', 'przygotowanie', 'elkészítés', 'postup', 'εκτέλεση', 'приготовление', '做法', '步骤', '作り方'].map(label => [label, 'instructions']),
]);
const labelField = label => labels.get(label) || '';

// The field a caption names: a heading may carry a suffix ("Ingredients (serves 4)"); any caption may end in a colon.
const unglyph = text => { const c = text.charCodeAt(0) | 0x20; return c >= 0x61 && c <= 0x7a || (c ^ 0x20) >= 0x30 && (c ^ 0x20) <= 0x39 ? text : text.replace(/^[^\p{L}\p{N}]+/u, ''); };
const labelOf = (text, heading) => labelField(unglyph(text.toLowerCase()).replace(heading ? /\s*[:：*(].*$/ : /[:：]\s*$/, '').trim());
// A visible title equal to the name, or the name less a trailing site label, corroborates the shorter title.
const titledBy = (name, heading) => {
  const title = readable(heading), rest = title && name.startsWith(title) ? name.slice(title.length) : null;
  return rest === '' || !!rest && /^\s*[-–—|:·(]|\s[-–—|·]\s/.test(rest) ? title : '';
};

const nutritionLabels = {
  calories: 'Calories', fatContent: 'Fat', saturatedFatContent: 'Saturated Fat',
  cholesterolContent: 'Cholesterol', sodiumContent: 'Sodium', carbohydrateContent: 'Carbohydrates',
  fiberContent: 'Fiber', sugarContent: 'Sugar', proteinContent: 'Protein', servingSize: 'Serving Size',
};
// Field selectors in reading order: explicit properties, then class names; and the other field's selectors for the purity test.
const tiers = [['[itemprop', selector => selector.startsWith('[itemprop')], ['class', selector => !selector.startsWith('[itemprop')]]
  .map(([, tier]) => Object.entries(fields).map(([field, selectors]) => [field, selectors.filter(tier)]).filter(([, selectors]) => selectors.length));
const otherOf = { ingredients: fields.instructions.join(','), instructions: fields.ingredients.join(',') };
const canonical = data => ({ ...data,
  ingredients: data.recipeIngredient ?? data.recipeIngredients ?? data.ingredients,
  instructions: data.recipeInstructions ?? data.instructions });

function readable(root, sections, listed, exclude) {
  const visit = node => {
    if (node.nodeType === 3) {
      const text = node.nodeValue.replace(/\s+/g, ' ');
      // Outside the rows of a listed read, text is marked so that only captions survive.
      return !listed || root.contains(node.parentElement?.closest('li')) ? text : text.trim() ? `\u0001${text}\u0001` : text;
    }
    if (exclude && node !== root && node.matches?.(exclude)) return '';
    // A matched tab panel is excluded only when its own tab is unselected.
    if (node.style?.display === 'none' || node.matches?.('script,style,template,button,input,select,svg,.sharedaddy,.print-share,.mw-editsection,[hidden],[aria-hidden="true"],[role="tablist"],[role="tabpanel"]') &&
        (node.getAttribute('role') !== 'tabpanel' || unselectedPanel(node))) return '';
    const body = [...node.childNodes].map(visit).join('');
    // Some definition rows render the linked term and underlined value as adjacent cells.
    if (node.tagName === 'U' && node.parentElement?.tagName === 'DT' &&
        node.previousElementSibling?.tagName === 'A' && node.parentElement.children.length === 2) return ` ${body}`;
    if (node.tagName === 'DT') return `\n${body} `;
    if (node.tagName === 'DD') return `${body}\n`;
    if (sections && /^H[1-6]$/.test(node.tagName) && !body.trim().includes('\n')) return body.trim() ? `\n[${clean(body)}]\n` : '';
    return node.matches?.(blocks) ? `\n${body}\n` : body + (node.matches?.('td,th') ? ' ' : '');
  };
  return clean(visit(root));
}

// Document order means a nested match can only follow the outermost match that contains it.
const outer = (nodes, kept = []) => nodes.filter(node => !kept.at(-1)?.contains(node) && kept.push(node));
const content = (node, steps, exclude) => {
  // A nested download/control list cannot suppress surrounding table or definition rows.
  const listed = !steps && node.tagName !== 'LI' && !node.querySelector('tr,dt,dd') && !!node.querySelector('li:not([role="tablist"] li)');
  let value = readable(node, true, listed, exclude);
  // Among list rows, text outside the rows is kept only as a caption: a heading label or a caption-shaped line.
  if (listed && value.includes('\u0001')) value = value.split('\n').filter(line => {
    if (!line.includes('\u0001')) return true;
    const bare = line.replace(/\u0001/g, '').trim();
    return bare.startsWith('[') || presentable(bare, false).startsWith('[');
  }).map(line => line.replace(/\u0001/g, '').trim()).join('\n');
  value = value.replace(node.nodeType === 1 ? /^\[[^\]\n]*\](?:\n|$)/ : '', '');
  // A single ingredient row may split amount and description into block cells.
  if (!steps && node.matches?.('li,tr') && !node.querySelector('li,tr,dl,br')) value = value.replace(/\n/g, ' ');
  return value;
}; // An element's own leading heading is its title, not a section.

// A run of sibling nodes read as one region without cloning them; nested recipe cards are excluded while reading.
const nestedRecipes = `${cardSelector},[itemscope][itemtype~="https://schema.org/Recipe"],[itemscope][itemtype~="http://schema.org/Recipe"],[itemscope][itemtype~="Recipe"]`;
const region = (nodes, exclude) => {
  const kept = nodes.filter(node => node.nodeType !== 1 || !exclude || !node.matches(exclude));
  const inside = (node, hit) => { const bad = exclude && hit.closest(exclude); return !bad || !node.contains(bad); };
  return {
    nodeType: 11, childNodes: kept,
    contains: other => kept.some(node => node === other || node.nodeType === 1 && node.contains(other)),
    querySelector: selector => { for (const node of kept) { if (node.nodeType !== 1) continue; if (node.matches(selector)) return node; for (const hit of node.querySelectorAll(selector)) if (inside(node, hit)) return hit; } return null; },
    querySelectorAll: selector => kept.flatMap(node => node.nodeType !== 1 ? [] : [...(node.matches(selector) ? [node] : []), ...[...node.querySelectorAll(selector)].filter(hit => inside(node, hit))]),
  };
};

const httpURL = (value, base) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  try { const url = new URL(value, base); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; }
};

/** Extract independent recipe candidates. Reads the current DOM; never fetches or caches. */
export function clipRecipes(doc = document, { url = doc.URL } = {}) {
  const base = httpURL(doc.querySelector('base[href]')?.getAttribute('href'), url) || url;
  const source = httpURL(doc.querySelector('link[rel~="canonical"]')?.getAttribute('href'), base) || httpURL(url);
  const text = value => {
    if (Array.isArray(value)) value = value[0];
    if (value && typeof value === 'object') value = value['@value'];
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    const raw = String(value);
    if (!/<[a-z!/]|&(?:#\w+|\w+);/i.test(raw)) return clean(raw);
    const template = doc.createElement('template');
    try { template.innerHTML = raw; } catch { return clean(raw); } // Trusted Types may disallow parsing strings.
    return readable(template.content);
  };
  const objects = [];
  const key = id => { try { return new URL(id, base).href; } catch { return id; } };
  const byId = new Map();
  for (const script of doc.scripts) {
    if (script.type.toLowerCase() !== "application/ld+json") continue;
    let parsed;
    const raw = script.textContent.replace(/^\uFEFF/, '');
    try { parsed = JSON.parse(raw); } catch {
      try { parsed = JSON.parse(raw.replace(/"(?:[^"\\]|\\.)*"/gs, s => s.replace(/[\u0000-\u001f]/g, c => JSON.stringify(c).slice(1, -1)))); }
      catch { continue; }
    }
    const stack = [parsed];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (isType(node['@type'], 'Recipe')) objects.push(node);
      if (typeof node['@id'] === 'string') byId.set(key(node['@id']), { ...byId.get(key(node['@id'])), ...node });
      for (const child of Object.values(node).reverse()) if (child && typeof child === 'object') stack.push(child);
    }
  }
  const resolve = value => value && typeof value === 'object' && typeof value['@id'] === 'string'
    ? byId.get(key(value['@id'])) || value : value;
  const lines = (value, steps = false) => {
    const result = [], stack = [{ value, ancestors: new Set() }];
    while (stack.length) {
      const { value: raw, ancestors } = stack.pop();
      const node = resolve(raw);
      if (node == null) continue;
      if (typeof node !== 'object') {
        const s = text(node);
        if (s) result.push(...s.split('\n').map(line => presentable(line, steps)).filter(Boolean));
        continue;
      }
      if (ancestors.has(node)) continue;
      const next = new Set(ancestors).add(node);
      const body = node.text ?? (steps && !node.item ? node.description : undefined);
      if (node.name && (isType(node['@type'], 'HowToSection') || steps && body && !text(body).startsWith(text(node.name).replace(/\.$/, '')))) result.push(`[${text(node.name)}]`);
      const quantity = has(node.value) ? [text(node.value), text(node.unitText), text(node.name)].filter(Boolean).join(' ') : undefined;
      const children = Array.isArray(node) ? node : array(node['@list'] ?? node['@value'] ?? node.itemListElement ?? body ?? node.item ?? quantity ?? node.name);
      for (const child of [...children].reverse()) stack.push({ value: child, ancestors: next });
    }
    return result;
  };
  const normalize = (data, method, scope) => {
    let title = text(data.name);
    // A name carrying a trailing site or rating label takes the shorter title when one visible owned heading and both
    // social metadata titles agree on it.
    const social = scope && title && /\s[-–—|·]\s|[:(]/.test(title) ? clean(doc.head?.querySelector('meta[property="og:title"]')?.getAttribute('content')) : '';
    if (social && social !== title && title.startsWith(social) && social === clean(doc.head?.querySelector('meta[name="twitter:title"]')?.getAttribute('content'))) {
      const owns = heading => { const owner = heading.closest('article,main,[role="main"]'); return !!owner && !!owner.querySelector(fields.ingredients[0]) && !!owner.querySelector(fields.instructions[0]); };
      const titles = new Set([...scope.querySelectorAll('h1')].filter(heading => !hiddenByAncestor(heading) && owns(heading)).map(heading => titledBy(title, heading)).filter(Boolean));
      if (titles.size === 1 && titles.has(social)) title = social;
    }
    const nutrition = resolve(data.nutrition);
    const result = {
      title: title || clean(doc.querySelector('h1')?.textContent) || '', description: text(data.description),
      source, imageURL: array(data.image).map(resolve)
        .reduce((url, image) => url || httpURL(typeof image === 'object' && image ? image.url || image.contentUrl : image, base), ''),
      yield: lines(data.recipeYield).join(' / '),
      activeTime: text(data.prepTime), cookTime: text(data.cookTime), totalTime: text(data.totalTime),
      ingredients: lines(data.ingredients), instructions: lines(data.instructions, true), notes: text(data.notes),
      nutritionInfo: nutrition && typeof nutrition === 'object'
        ? Object.entries(nutritionLabels).flatMap(([key, label]) => text(nutrition[key]) ? [`${label}: ${text(nutrition[key])}`] : []).join('\n')
        : text(nutrition),
      method,
    };
    result.missing = ['title', 'ingredients', 'instructions'].filter(field => !result[field].length);
    return result;
  };

  const readItem = (scope, ancestors = new Set()) => {
    if (ancestors.has(scope)) return {};
    const next = new Set(ancestors).add(scope);
    const result = Object.create(null);
    result['@type'] = (scope.getAttribute('itemtype') || '').split(/\s+/);
    for (const el of [...scope.querySelectorAll('[itemprop]')].filter(el => el.parentElement?.closest('[itemscope]') === scope)) {
      const props = el.getAttribute('itemprop'), rawContent = el.getAttribute('content');
      if (rawContent?.trim() === '[{' && el.getAttributeNames().some(name => name.includes('"')) &&
          /instruction/i.test(props) && procedureLists(scope).length) continue;
      const row = el.matches(fields.ingredients[0]) && !el.hasAttribute('content') ? el.closest('li,tr') : null;
      const ingredient = row && row !== el && row.closest('[itemscope]') === scope &&
        !row.querySelector('[itemscope]') && row.querySelectorAll(fields.ingredients[0]).length === 1 ? row : el;
      const value = el.hasAttribute('itemscope') ? readItem(el, next)
        : rawContent ?? el.getAttribute('datetime') ?? el.getAttribute('src') ?? el.getAttribute('href') ?? (/ingredient|instruction/i.test(props) ? content(ingredient, /instruction/i.test(props)) : readable(el));
      for (const prop of props.split(/\s+/).filter(Boolean)) {
        result[prop] = Object.hasOwn(result, prop) ? [...array(result[prop]), value] : value;
      }
    }
    return result;
  };

  const found = cardClasses.flatMap(name => [...doc.getElementsByClassName(name)]);
  for (const scope of doc.querySelectorAll('[itemscope]')) {
    if (isType((scope.getAttribute('itemtype') || '').split(/\s+/), 'Recipe')) found.push(scope);
  }
  const cardSet = new Set(found), cards = [...cardSet].sort((a, b) => a.compareDocumentPosition(b) & 2 ? 1 : -1);
  const belongs = (el, scope) => {
    for (; el; el = el.parentElement) if (cardSet.has(el)) return el === scope;
    return true;
  };
  const procedureLists = scope => outer([...scope.querySelectorAll('ol[class*="__"],ul[class*="__"]')].filter(el => belongs(el, scope) &&
    [...el.classList].some(name => /(?:__(?:instructions|directions|method|steps|preparation)(?:--[\w-]+)?|(?:^|[-_])(?:instructions|directions|method|steps|preparation)__(?:inner|list|items))$/i.test(name))));
  // Only detached field clones enter here; nested recipe candidates retain their own source ownership.
  const pruneNestedCards = root => {
    for (const node of root.querySelectorAll(`${cardSelector},[itemscope]`))
      if (node.matches(cardSelector) || isType((node.getAttribute('itemtype') || '').split(/\s+/), 'Recipe')) node.remove();
    return root;
  };
  // An element a reader may take from a scope: owned by it, not concealed, and outside navigation, chrome and dialogs.
  const visible = (el, scope) => belongs(el, scope) && !hiddenByAncestor(el) && !el.closest('nav,header,footer,[role="navigation"],dialog,[role="dialog"]');
  // Fields recognised by shape, without any caption: an ingredient list is a list whose rows mostly open with a quantity,
  // and the method is the first ordered list, or run of "Step 1", "Step 2"… headings, after it. Adjacent such lists
  // separated only by short captions are one list with [labels]. The reading is taken only when the scope holds one such list.
  const shapedFields = (scope, known = false) => {
    const between = (a, b) => {
      const range = doc.createRange(); range.setStartAfter(a); range.setEndBefore(b);
      return readable(pruneNestedCards(range.cloneContents())).split('\n').filter(Boolean);
    };
    const caption = line => line.length <= 60 && !/\d/.test(line);
    const label = line => `[${line.replace(/:$/, '').trim()}]`;
    const ingredientRows = list => {
      const rows = list.tagName === 'TABLE' ? [...list.querySelectorAll('tr')].filter(row => row.closest('table') === list && row.querySelector('td'))
        : [...list.children].filter(el => el.tagName === 'LI');
      if (rows.length < 3 || rows.filter(row => quantityLine.test(row.textContent.trimStart())).length * 2 < rows.length ||
          rows.some(row => row.querySelector('ul,ol,table,h1,h2,h3,h4,h5,h6,[itemscope]'))) return null;
      const values = rows.map(row => content(row));
      return values.every(value => value && !value.includes('\n') && value.length <= 200) ? values : null;
    };
    const stepHeading = /^step\s*(\d+)\b/i;
    const lists = [], procedures = [];
    for (const el of scope.querySelectorAll('ul,ol,table,h1,h2,h3,h4,h5,h6')) {
      const heading = /^H/.test(el.tagName);
      if (heading ? !/^\s*step\s*1\b/i.test(el.textContent) : el.tagName !== 'TABLE' && el.childElementCount < 2) continue;
      if (!visible(el, scope)) continue;
      if (heading) {
        if (stepHeading.exec(readable(el))?.[1] !== '1') continue;
        const nodes = [];
        let n = 1;
        for (let node = el; node; node = node.nextElementSibling) {
          if (/^H[1-6]$/.test(node.tagName)) {
            if (node.tagName > el.tagName) { nodes.push(node); continue; }
            if (stepHeading.exec(readable(node))?.[1] !== String(n++)) break;
            nodes.push(node);
          } else if (node.matches('p,ol,ul') && readable(node)) nodes.push(node);
        }
        if (n > 2 && nodes.some(node => node.tagName !== 'H' + el.tagName[1] && node.tagName === 'P')) procedures.push({ node: el, nodes });
        continue;
      }
      if (el.matches(fields.instructions.join(','))) continue;
      const rows = ingredientRows(el);
      if (rows) { lists.push({ node: el, rows }); continue; }
      if (el.tagName !== 'OL' || el.querySelector('[itemscope]')) continue;
      const items = [...el.children].filter(li => li.tagName === 'LI');
      if (items.length < 2 || !items.every(li => /\p{L}/u.test(readable(li))) || !known && items.reduce((n, li) => n + readable(li).length, 0) < 25 * items.length) continue;
      // Paragraphs directly after the list finish the method, up to a heading, another list, or a note caption.
      const nodes = [el];
      for (let next = el.nextElementSibling; next?.tagName === 'P' && readable(next) && !/^(?:notes?|tips?|options?|hints?)\s*[:：]/i.test(readable(next)); next = next.nextElementSibling) nodes.push(next);
      procedures.push({ node: el, nodes });
    }
    // With the ingredients already read, the scope's only procedure is the method.
    if (!lists.length) return known && procedures.length === 1 ? { instructions: procedures[0].nodes.map(node => readable(node, true)).filter(Boolean).join('\n') } : null;
    const groups = [];
    for (const list of lists) {
      const last = groups.at(-1), gap = last ? between(last.tail, list.node) : null;
      if (last && gap.length <= 2 && gap.every(caption)) { last.rows.push(...gap.map(label), ...list.rows); last.tail = list.node; }
      else groups.push({ head: list.node, tail: list.node, rows: [...list.rows] });
    }
    if (groups.length !== 1) return null;
    const [group] = groups;
    // A short caption directly above the first rows names the first group, unless it is the field's own heading.
    const lead = group.head.previousElementSibling;
    const leadText = lead?.matches('h1,h2,h3,h4,h5,h6,p,strong,b,em,div,span') && !lead.querySelector('ul,ol,table') ? readable(lead) : '';
    if (leadText && leadText.length <= 48 && caption(leadText) && !labelOf(leadText) &&
        group.rows.some(row => row.startsWith('['))) group.rows.unshift(label(leadText));
    // Across more than a caption's worth of content, the method must be introduced by a method caption.
    const methodCaption = line => {
      const text = line.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '').replace(/[:：]\s*$/, '').trim();
      return labelOf(text) === 'instructions' || /^(?:how to make|method\b|directions\b|instructions\b)/.test(text);
    };
    const intro = node => {
      while (node !== scope && !node.previousElementSibling) node = node.parentElement;
      const prev = node.previousElementSibling;
      return prev && !prev.querySelector('ul,ol,table') ? readable(prev).split('\n').at(-1) : '';
    };
    const apart = p => !group.tail.contains(p.node) && !p.node.contains(group.tail);
    const procedure = procedures.find(p => {
      if (!apart(p) || !(group.tail.compareDocumentPosition(p.node) & 4)) return false;
      const gap = between(group.tail, p.node);
      return gap.length <= 2 || methodCaption(gap.at(-1));
    // A method published before its ingredients is taken only when a method caption introduces it.
    }) || procedures.findLast(p => group.head.compareDocumentPosition(p.node) & 2 && apart(p) && methodCaption(intro(p.node)));
    const result = { ingredients: group.rows.join('\n') };
    if (procedure) result.instructions = procedure.nodes.map(node => readable(node, true)).filter(Boolean).join('\n');
    return result;
  };
  let titles;
  const markup = (scope, existing = {}) => {
    const data = canonical(scope.hasAttribute('itemscope') ? readItem(scope) : {});
    if (!has(existing.instructions) && !has(data.instructions)) {
      const procedures = procedureLists(scope);
      if (procedures.length) data.instructions = procedures.map(el => readable(el, true)).filter(Boolean).join('\n');
    }
    if (scope.matches('.hrecipe,.h-recipe')) {
      for (const [field, selector] of [['name', '.fn,.p-name'], ['ingredients', 'li.ingredient,li.p-ingredient'], ['instructions', '.instructions,.e-instructions']]) {
        if (has(existing[field]) || has(data[field])) continue;
        const nodes = [...scope.querySelectorAll(selector)].filter(el => belongs(el, scope) && !el.closest('.vcard,.h-card'));
        const ingredientRows = field === 'ingredients' ? new Set(nodes) : null;
        const values = (field === 'instructions' ? outer(nodes) : nodes).flatMap(el => {
          const list = field === 'ingredients' && !el.previousElementSibling && el.parentElement?.matches('ul,ol') ? el.parentElement : null;
          const heading = list && [...list.children].every(row => ingredientRows.has(row)) ? list.previousElementSibling : null;
          const label = heading?.matches('h1,h2,h3,h4,h5,h6') && belongs(heading, scope) ? readable(heading) : '';
          const group = label && label !== text(existing.name || data.name) && !labelOf(label);
          return [group ? `[${label}]` : '', field === 'ingredients' ? content(el) : readable(el, field === 'instructions')];
        }).filter(Boolean);
        if (values.length) data[field] = field === 'name' ? values[0] : values.join('\n');
      }
    }
    // Captions name regions. A caption is a heading that opens with a field label, a short block whose whole text is one,
    // or a control whose target holds the field. A control's region is its target; a caption leading one of two columns owns
    // the column; any other caption owns what follows it up to the next caption, or heading of no deeper level, inside the
    // smallest ancestor holding every caption of the scope. The first caption for a field reads it.
    // An unambiguous caption (the only one for its field) is read before class selectors; the first of several, after.
    let captions, scopeHeadings;
    const captionFields = unique => {
      if (has(existing.ingredients || data.ingredients) && has(existing.instructions || data.instructions)) return;
      const blank = node => [...node.childNodes].every(child => child.nodeType !== 3 || !child.nodeValue.trim());
      const captionOf = node => {
        const tag = node.tagName, heading = tag.length === 2 && tag[0] === 'H';
        // Emphasis captions a line only from its start; a block caption is short and holds at most one element; a div or
        // span caption holds nothing but its text.
        const before = node.previousSibling;
        if ((tag === 'STRONG' || tag === 'B' || tag === 'EM') && before?.nodeType === 3 && before.nodeValue.trim()) return '';
        const first = node.firstChild;
        if (!heading && (node.childElementCount > (tag === 'DIV' || tag === 'SPAN' ? 0 : 1) || first?.nodeType === 3 && first.nodeValue.length > 80 && first.nodeValue.trim().length > 60 ||
            first?.nodeType === 1 && node.childNodes.length > 2)) return '';
        const raw = (heading ? node.textContent : !node.childElementCount ? first?.nodeValue ?? '' : first.nodeType === 1 && !first.childElementCount && node.childNodes.length === 1 ? first.firstChild?.nodeValue ?? '' : node.textContent).trim();
        if (!heading && raw.length > 60) return '';
        // The cheap text decides whether the element is worth reading at all.
        const quick = unglyph(raw.toLowerCase()).replace(heading ? /\s*[:：*(].*$/ : /[:：]\s*$/, '').trim();
        if (!labelField(quick) && !(heading && quick.startsWith('how to make ')) && !/^(?:tools|equipment|utensils)/.test(quick)) return '';
        const label = unglyph(readable(node).toLowerCase()).replace(heading ? /\s*[:：*(].*$/ : /[:：]\s*$/, '').trim();
        // "How to make <this recipe>" captions the method when the rest names the page's own title.
        if (heading && label.startsWith('how to make ') && (titles ??= new Set([...doc.querySelectorAll('h1')].map(h => readable(h).toLowerCase()))).has(label.slice('how to make '.length))) return 'linked';
        return labelField(label) || (/^(?:tools|equipment|utensils|tools you['’]ll need|equipment needed)$/.test(label) ? 'equipment' : '');
      };
      const scan = !captions;
      captions ??= [];
      const collect = selector => {
        for (const node of scope.querySelectorAll(selector)) {
          // Only inline elements and controls can sit inside a caption already taken.
          const tag = node.tagName;
          if ((tag === 'STRONG' || tag === 'B' || tag === 'EM' || tag === 'SPAN' || tag === 'A' || tag === 'BUTTON') && captions.some(caption => caption.node.contains(node))) continue;
          const field = captionOf(node);
          if (!field || !visible(node, scope)) continue;
          captions.push({ node, field: field === 'linked' ? 'instructions' : field, linked: field === 'linked', level: /^H[1-6]$/.test(node.tagName) ? +node.tagName[1] : 7, control: node.matches('a,button') });
        }
      };
      if (scan) {
        collect('h1,h2,h3,h4,h5,h6,p,dt,summary,strong,b,em,a[data-target],button[data-target],a[aria-controls],button[aria-controls]');
        // Bare div and span captions are rarer and dearer to scan for; they are sought only when a field still has none.
        if (!['ingredients', 'instructions'].every(field => captions.some(caption => caption.field === field))) {
          collect('div,span');
          captions.sort((a, b) => a.node.compareDocumentPosition(b.node) & 2 ? 1 : -1);
        }
      }
      // A title-linked "How to make …" heading yields to any caption from the vocabulary.
      if (captions.some(c => c.linked) && captions.some(c => c.field === 'instructions' && !c.linked)) captions = captions.filter(c => !c.linked);
      let owner = captions[0]?.node.parentElement;
      for (const { node } of captions) while (!owner.contains(node)) owner = owner.parentElement;
      if (owner && !scope.contains(owner)) owner = scope;
      const headings = captions.length ? scopeHeadings ??= [...scope.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(h => belongs(h, scope) && !hiddenByAncestor(h)) : [];
      // A same-field caption deeper than an earlier one ("Method" then "Preparation") sections that field rather than competing.
      const subs = new Set(unique ? captions.filter(caption => captions.some(other => other.field === caption.field && other.level < caption.level && !!(other.node.compareDocumentPosition(caption.node) & 4) &&
        !headings.some(h => +h.tagName[1] <= other.level && other.node.compareDocumentPosition(h) & 4 && h.compareDocumentPosition(caption.node) & 4))) : []);
      for (const [i, caption] of captions.entries()) {
        const { node, field } = caption;
        if (field === 'equipment' ? has(existing.notes) || has(data.notes) : has(existing[field]) || has(data[field]) || unique && captions.filter(other => other.field === field && !other.control && !subs.has(other)).length > 1) continue;
        const control = node.matches('a,button') ? node.getAttribute('data-target') || node.getAttribute('aria-controls') : null;
        let fragment;
        if (control !== null) {
          const id = control.startsWith('#') ? control.slice(1) : control;
          const target = id && !/\s/.test(id) ? doc.getElementById(id) : null;
          if (!target || hiddenByAncestor(target) || target.contains(node) || !scope.contains(target) || !belongs(target, scope)) continue;
          fragment = region([target], nestedRecipes);
        } else {
          // A transparent wrapper does not change ownership of the exact caption.
          let block = node;
          while (block.parentElement !== scope && block.parentElement?.children.length === 1 && blank(block.parentElement)) block = block.parentElement;
          const parent = block.parentElement, root = parent?.parentElement;
          const column = parent?.firstElementChild === block && root?.children.length === 2 && scope.contains(root) && blank(root);
          // A caption leading its container owns it, plus following sibling sections that open with a deeper heading; a block
          // caption inside a container stays in it; a heading's field otherwise runs to the ancestor shared with the other captions.
          const leads = parent !== scope && parent.firstElementChild === block;
          const within = column || caption.level === 7 && !leads ? parent : owner.contains(block) ? owner : scope;
          let end = null, stop = null;
          if (leads && !column) for (let sibling = parent.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
            const first = sibling.firstElementChild;
            if (sibling.matches('section,div') && first && /^H[1-6]$/.test(first.tagName) && +first.tagName[1] > caption.level && !captionOf(first)) continue;
            stop = sibling; break;
          }
          const after = other => other !== node && !block.contains(other) && within.contains(other) && !!(node.compareDocumentPosition(other) & 4);
          // The earliest of: the next caption, the next heading of no deeper level, and the first sibling after a led container.
          const ends = [captions.slice(i + 1).find(c => (c.field !== field || caption.level < 7 && c.level <= caption.level) && after(c.node))?.node,
            column ? null : headings.find(h => +h.tagName[1] <= caption.level && (caption.level < 7 || h.parentElement === parent) && after(h)), stop];
          for (const other of ends) if (other && (!end || other.compareDocumentPosition(end) & 4)) end = other;
          // Siblings of the caption are read in place; a region crossing containers is cloned.
          if (block.parentElement === within && (!end || end.parentElement === within)) {
            const nodes = [];
            for (let node = block.nextSibling; node && node !== end; node = node.nextSibling) nodes.push(node);
            fragment = region(nodes, nestedRecipes);
          } else {
            const range = doc.createRange();
            range.selectNodeContents(within); range.setStartAfter(block);
            if (end) range.setEndBefore(end);
            fragment = pruneNestedCards(range.cloneContents());
          }
        }
        const live = Array.isArray(fragment.childNodes);
        // A bold word alone is weak evidence: a block caption needs the other field captioned or read, or a list of rows under it.
        const counterpart = { ingredients: 'instructions', instructions: 'ingredients' }[field];
        if (caption.level === 7 && !caption.control && counterpart && !has(existing[counterpart]) && !has(data[counterpart]) &&
            !captions.some(other => other.field === counterpart) && fragment.querySelectorAll('li').length < 2) continue;
        // Trailing paragraphs that open with a note caption ("Tip:", "Note:") are notes, not steps.
        const notes = [];
        if (field === 'instructions') {
          const last = () => live ? fragment.childNodes.findLast(node => node.nodeType === 1) : fragment.lastElementChild;
          for (let node = last(); node; node = last()) {
            if (node.tagName !== 'P' || !/^(?:notes?|tips?|options?|hints?|variations?|storage|make ahead|anmerkung|hinweis|tipp|astuces?|conseils?|remarque|notas?|consejos?|opmerking)\s*[:：]\s/i.test(readable(node))) break;
            notes.unshift(readable(node));
            if (live) fragment.childNodes.splice(fragment.childNodes.indexOf(node)); else node.remove();
          }
        }
        const value = content(fragment, field === 'instructions', live ? nestedRecipes : undefined);
        // A caption over a bare number or duration ("Preparation" then "20 min") has not named the field, and a bold word
        // over prose ("Ingredients matter in cooking") needs a quantity row or list rows under it to be one.
        if (!has(value) || /^\p{N}[\p{N}\s/.,-]*(?:min(?:ute)?s?|m|h(?:ou)?rs?|h|std|uur|minuti|minutos)?\.?$/iu.test(value)) continue;
        if (caption.level === 7 && field === 'ingredients' && !value.includes('\n') && !quantityLine.test(value.replace(/^[-–—*]\s*/, '')) && fragment.querySelectorAll('li').length < 2) continue;
        if (field === 'equipment') { data.notes = `[${readable(node).replace(/[:：]\s*$/, '')}]\n${value}`; continue; }
        data[field] = value;
        if (notes.length && !has(existing.notes) && !has(data.notes)) data.notes = notes.join('\n');
      }
    };
    const readSelectors = tier => { for (const [field, selectors] of tier) {
      if (has(existing[field]) || has(data[field])) continue;
      for (const selector of selectors) {
        // A container holding the other field's own container is the whole recipe, not this field.
        const other = otherOf[field] || '';
        const container = selector === fields.ingredients[2] || selector === fields.instructions[1];
        const matches = [...scope.querySelectorAll(selector)].filter(el => belongs(el, scope) && (field === 'name' || !container || !el.closest('nav,[role="navigation"]')) &&
          (!other || !el.matches(other) && (!container || !el.querySelector(other))));
        // Row selection must retain the explicit ancestor visibility honored by a container read.
        if (field === 'ingredients' && selector === fields.ingredients[1]) {
          for (let i = matches.length - 1; i >= 0; i--) {
            for (let node = matches[i]; node; node = node.parentElement) {
              if (concealed(node)) { matches.splice(i, 1); break; }
              if (node === scope) break;
            }
          }
        }
        const values = outer(matches).map(el => {
          if (field === 'ingredients' && selector === fields.ingredients[1] && el.parentElement?.matches('ul,ol')) {
            // A short digit-free row that is not itself an ingredient row captions the rows after it.
            const group = el.previousElementSibling;
            if (group?.tagName === 'LI' && !matches.includes(group) && belongs(group, scope) && !hiddenByAncestor(group)) {
              const label = readable(group);
              if (label && label.length <= 48 && !/\d/.test(label) && !labelOf(label) &&
                  (captionRow.test(label) || /heading|title|label|group|caption/i.test(group.className))) return `[${label}]\n${content(el)}`;
            }
          }
          return /ingredients|instructions/.test(field) ? content(el, field === 'instructions') : readable(el);
        }).filter(Boolean);
        if (values.length) {
          data[field] = field === 'name' ? values[0] : values.join('\n');
          break;
        }
      }
    } };
    // Explicit properties, then unambiguous captions, then class names.
    readSelectors(tiers[0]);
    captionFields(true);
    readSelectors(tiers[1]);
    // A field whose whole value is its own caption word, as when a collapsed "Method" toggle carries the property, holds no content.
    for (const field of ['ingredients', 'instructions']) if (typeof data[field] === 'string' && data[field].length <= 48 && labelOf(clean(data[field]))) delete data[field];
    const image = has(existing.image || data.image) ? null : scope.querySelector('[class*="recipe-image" i] img,img[class*="recipe-image" i]');
    data.image ||= image?.getAttribute('data-src') || image?.getAttribute('src') || '';
    if (has(existing.ingredients || data.ingredients) && has(existing.instructions || data.instructions)) return data;
    captionFields(false);
    // Without a caption, the fields are read by shape.
    if (!has(existing.ingredients || data.ingredients) || !has(existing.instructions || data.instructions)) {
      const shaped = shapedFields(scope, has(existing.ingredients || data.ingredients));
      if (shaped) for (const field of ['ingredients', 'instructions']) if (shaped[field] && !has(existing[field]) && !has(data[field])) data[field] = shaped[field];
    }
    return data;
  };

  // One alignment of serialised rows to the page's visible lines: every row must appear, in order, with nothing but short
  // captions between. A row serialised without its quantity matches the line, or pair of lines, that adds a numeral at its
  // start or end, and takes it whole; a line equal to its row with doubled parentheses collapsed is taken whole; a row with
  // a decimal lends its numerals the page's spelling. Captions between the rows, and one directly above the first, become [labels].
  const renderedRows = (root, rows, mode = false) => {
    const names = !!mode;
    const flat = value => value.replace(/\s+/g, ' ').trim();
    const unwrap = value => value.replace(/\(\(/g, '(').replace(/\)\)/g, ')');
    const wanted = rows.map(row => flat(text(row))), keys = wanted.map(rowKey);
    if (keys.some(key => !key)) return null;
    // The rendering adds a quantity: a numeral, or within one line at most three words such as "etwas" or "to taste".
    const quantified = (line, row, pair) => {
      if (line === row) return !pair;
      if (!line.startsWith(row + ' ') && !line.endsWith(' ' + row)) return false;
      const extra = line.replace(row, '').trim();
      return /\d|[¼½¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚]/.test(extra) || !pair && extra.split(' ').length <= 3;
    };
    // Another item's markup inside the owner (a product card) is not the page's rendering of this list.
    const visible = readable(root, false, false, '[itemscope]').split('\n'), spans = [];
    let from = 0;
    for (const [i, row] of wanted.entries()) {
      let span = null;
      for (let k = from; k < visible.length && !span; k++) {
        const pair = names && k + 1 < visible.length && (visible[k] === row || visible[k + 1] === row) ? `${visible[k]} ${visible[k + 1]}` : '';
        if (pair && quantified(pair, row, true)) span = { start: k, end: k + 1, line: pair };
        else if (names ? quantified(visible[k], row) : rowKey(visible[k]) === keys[i]) span = { start: k, end: k, line: visible[k] };
      }
      if (!span) return null;
      spans.push(span); from = span.end + 1;
    }
    // A page that renders amounts on their own lines does so for most rows; one lone numeral line is not an amount.
    const paired = spans.filter(span => span.end > span.start).length;
    if (paired && paired * 2 < spans.length) return null;
    // Whole lines are adopted only from the page's own ingredient list: introduced by its caption, with no row left out.
    if (names) {
      const before = visible.slice(Math.max(0, spans[0].start - 6), spans[0].start), next = visible[spans.at(-1).end + 1] ?? '';
      if (quantityLine.test(next) || mode !== 'listed' && !before.some(line => labelOf(line, true) === 'ingredients' || labelField(line.toLowerCase().split(/\s+/)[0]) === 'ingredients')) return null;
    }
    // Only the numerals are re-spelt from the rendering; the serialised row keeps its own punctuation.
    const respelt = (row, line) => {
      const spellings = [...line.matchAll(numeralPattern)].map(m => ({ text: m[0], spaced: /\s/.test(line[m.index + m[0].length] ?? ' ') }));
      let k = 0;
      const value = row.replace(numeralPattern, (found, offset) => {
        const spelling = spellings[k++];
        if (!spelling) return found;
        return spelling.text + (spelling.spaced && /\p{L}/u.test(row[offset + found.length] ?? '') ? ' ' : '');
      });
      return spellings.length === k ? value : row;
    };
    const decimals = wanted.some(row => /\d\.\d/.test(row));
    const adopt = (i, line) => names || line === unwrap(wanted[i]) ? line : decimals ? respelt(rows[i], line) : rows[i];
    const result = [];
    let changed = false;
    // A caption directly above the first row names the first group, unless it is the field's own heading.
    const lead = visible[spans[0].start - 1];
    if (lead && lead.length <= 48 && captionRow.test(lead) && !labelOf(lead)) result.push(`[${lead.replace(/:$/, '').trim()}]`);
    for (let i = spans[0].start; i <= spans.at(-1).end; i++) {
      const line = visible[i], row = spans.findIndex(span => span.start === i);
      if (row >= 0) { const value = adopt(row, spans[row].line); result.push(value); changed ||= value !== rows[row] && value !== wanted[row]; i = spans[row].end; }
      else if (!/\d/.test(line) && line.split(/\s+/).length <= 5) result.push(`[${line.replace(/:$/, '').trim()}]`);
      else return null;
    }
    return changed ? result : null;
  };

  // A paragraph made only of bold lines, most opening with a quantity, is a printed ingredient list.
  const quantityBlock = el => {
    if (el.tagName !== 'P') return false;
    const parts = [...el.childNodes].filter(node => node.nodeType !== 3 || node.nodeValue.trim());
    if (parts.length < 3 || !parts.every(node => node.nodeType === 1 && (node.tagName === 'BR' || node.matches('strong,b')))) return false;
    const lines = readable(el).split('\n');
    return lines.length >= 3 && lines.filter(line => quantityLine.test(line)).length * 2 >= lines.length;
  };
  // Each heading owning such a block is a recipe: intro paragraphs before it, every bold block (with a short
  // caption directly above it as a group label) as ingredients, and the prose after the first block as the method.
  const proseRecipes = scope => {
    const found = [];
    for (const heading of scope.querySelectorAll('h1,h2,h3,h4')) {
      if (!visible(heading, scope)) continue;
      const blocks = [];
      for (let el = heading.nextElementSibling; el && !/^H[1-6]$/.test(el.tagName); el = el.nextElementSibling) blocks.push(el); // Any heading ends the recipe.
      const first = blocks.findIndex(quantityBlock);
      if (first < 0) continue;
      const ingredients = [], steps = [];
      blocks.slice(first).forEach((el, i, rest) => {
        if (quantityBlock(el)) {
          const caption = i > 0 ? rest[i - 1] : null;
          if (caption?.tagName === 'P' && !quantityBlock(caption) && steps.at(-1) === readable(caption) && readable(caption).length <= 48 && !/\d/.test(readable(caption))) ingredients.push(`[${steps.pop().replace(/:$/, '')}]`);
          ingredients.push(readable(el));
        } else if (el.matches('p,ol,ul') && readable(el)) steps.push(readable(el, true));
      });
      if (!steps.length) continue;
      const description = blocks.slice(0, first).filter(el => el.tagName === 'P').map(el => readable(el)).filter(Boolean).join('\n');
      found.push({ name: readable(heading), description, ingredients: ingredients.join('\n'), instructions: steps.join('\n') });
    }
    return found;
  };

  const distinct = [...new Map(objects.map(resolve).map(node => [JSON.stringify(node), canonical(node)])).values()];
  // A recipe published twice under one name is one recipe; its twin may only supply fields the first lacks.
  const recipes = [], byName = new Map();
  for (const data of distinct) {
    const name = text(data.name), twin = name ? byName.get(name) : null;
    const agrees = !!twin && ['ingredients', 'instructions'].every(field => !has(twin[field]) || !has(data[field]) ||
      JSON.stringify(lines(twin[field], field === 'instructions')) === JSON.stringify(lines(data[field], field === 'instructions')));
    if (!agrees) { if (name && !twin) byName.set(name, data); recipes.push(data); continue; }
    for (const [field, value] of Object.entries(data)) if (!has(twin[field]) && has(value)) twin[field] = value;
  }
  const usedCards = new Set();
  const results = recipes.map(data => {
    const serialized = array(data.instructions);
    const scalar = serialized.length === 1 && typeof serialized[0] === 'string' &&
      !serialized[0].includes('\n') && /[.!?][\p{L}\p{N}]/u.test(serialized[0]);
    // This is a probe gate, not a judgement that name-led recipes are incomplete.
    const probeQuantities = Array.isArray(data.ingredients) && data.ingredients.length > 0 &&
      data.ingredients.every(item => typeof item === 'string' && item.trim() && !/^\s*\p{N}/u.test(item));
    let scope;
    const id = data['@id'] || data.url;
    if (typeof id === 'string') {
      try { scope = doc.getElementById(decodeURIComponent(new URL(id, base).hash.slice(1))); } catch { /* malformed ID */ }
    }
    if (scope && !scope.children.length) scope = undefined; // A jump-link anchor is not a recipe card.
    if (!scope && recipes.length === 1 && cards.length === 1) {
      const title = cards[0].querySelector(fields.name[0]) || cards[0].querySelector('h1');
      if (title && readable(title) === text(data.name)) scope = cards[0];
    }
    const fillMissing = !!scope || !has(data.ingredients) || !has(data.instructions);
    let corroborated = '';
    const probeParentheses = Array.isArray(data.ingredients) && data.ingredients.some(item => typeof item === 'string' && item.includes('((') && item.includes('))'));
    if (!scope && recipes.length === 1 && (fillMissing || probeQuantities || probeParentheses || scalar)) {
      const name = text(data.name);
      // A visible title equal to the name, or the name less a trailing site label, corroborates ownership.
      const headings = [...doc.querySelectorAll('h1')].filter(heading => !hiddenByAncestor(heading) && titledBy(name, heading));
      // Without any article or main landmark, the document itself is the only possible owner.
      const landmark = doc.querySelector('article,main,[role="main"]');
      const owners = new Set(headings.map(heading => heading.closest('article,main,[role="main"]') || (landmark ? null : doc.body)).filter(Boolean));
      // The owning title found this way is itself the corroboration of a shorter name.
      if (owners.size === 1) {
        scope = [...owners][0];
        const titles = new Set(headings.filter(heading => scope.contains(heading)).map(heading => readable(heading)));
        if (titles.size === 1 && !titles.has(name)) corroborated = [...titles][0];
      }
    }
    // Only enrich within an identified card; never fill from an unrelated recipe.
    const extra = scope && (fillMissing || scalar) ? markup(scope, scalar ? { ...data, instructions: undefined } : data) : {};
    if (scope) usedCards.add(scope);
    const additions = Object.fromEntries(Object.entries(extra).filter(([field, value]) => has(value) && !has(data[field])));
    if (scalar && has(extra.instructions)) {
      const previous = lines(data.instructions, true), rows = lines(extra.instructions, true);
      const compact = value => value.replace(/\s/g, '');
      if (previous.length === 1 && rows.length > 1) {
        const original = previous[0], joined = compact(rows.join(''));
        if (joined === compact(original)) additions.instructions = rows;
        else {
          const caption = original.match(/^([^:]+:)\s*/);
          const label = caption?.[1].slice(0, -1).toLowerCase();
          if (labelField(label) === 'instructions' && joined === compact(original.slice(caption[0].length)) &&
              [...scope.querySelectorAll('h1,h2,h3,h4,h5,h6')].some(node => readable(node).toLowerCase().replace(/:\s*$/, '').trim() === label))
            additions.instructions = [`[${caption[1]}]`, ...rows];
        }
      }
    }
    // Rows serialised without their quantities, wrapped in doubled parentheses, or with decimals the page spells otherwise
    // ("50.0g" beside "50g") are re-read from the page's own rendering of the list.
    const rows = Array.isArray(data.ingredients) && data.ingredients.length > 1 && data.ingredients.every(item => typeof item === 'string' && item.trim()) ? data.ingredients : null;
    if (rows && (probeQuantities || probeParentheses || rows.some(item => /\d\.\d/.test(item)))) {
      const landmarks = doc.querySelectorAll('article,main');
      const root = scope || (probeQuantities || probeParentheses ? null : landmarks.length === 1 ? landmarks[0] : doc.body);
      const containers = probeQuantities && root ? [...root.querySelectorAll(fields.ingredients[2])].filter(el => !hiddenByAncestor(el) && !el.matches('ul,ol,li')) : [];
      const rendered = root ? renderedRows(containers.length === 1 ? containers[0] : root, rows, probeQuantities ? containers.length === 1 ? 'listed' : 'names' : false) : null;
      if (rendered) additions.ingredients = rendered;
    }
    if (corroborated) additions.name = corroborated;
    return normalize({ ...data, ...additions }, Object.keys(additions).length ? 'json-ld+markup' : 'json-ld', scope);
  });
  if (cards.length || !results.length) {
    const scopes = cards.length ? cards.filter(card => !usedCards.has(card)) : [...doc.querySelectorAll('article'), doc.body || doc.documentElement];
    for (const scope of scopes) {
      if (scope === doc.body && results.length) break; // The whole document is read only when no article holds a recipe.
      const microdata = scope.hasAttribute('itemscope') && isType((scope.getAttribute('itemtype') || '').split(/\s+/), 'Recipe');
      const data = markup(scope);
      // A named Recipe intro may publish its explicit fields in one sibling content section.
      if (microdata && cards.length === 1 && (!has(data.ingredients) || !has(data.instructions)) &&
          scope.parentElement?.matches('main,article')) {
        const headings = [...scope.querySelectorAll('h1')].filter(el => el.parentElement?.closest('[itemscope]') === scope);
        const names = [...scope.querySelectorAll('[itemprop~="name"]')].filter(el => el.parentElement?.closest('[itemscope]') === scope);
        if (headings.length === 1 && names.length === 1 && readable(headings[0]) === text(data.name)) {
          const sections = [...scope.parentElement.children].filter(el => {
            if (el === scope || hiddenByAncestor(el) || !el.matches('section,article') || el.matches('[role="dialog"]') || el.querySelector('dialog,[role="dialog"]')) return false;
            const rows = [...el.querySelectorAll(fields.ingredients[0])], methods = [...el.querySelectorAll(fields.instructions[0])];
            const owners = [...el.querySelectorAll('[itemscope]')].filter(item => methods.some(method => item.contains(method) || method.contains(item)));
            return rows.length && rows.every(row => !row.closest('[itemscope]')) && methods.length &&
              [...el.querySelectorAll('h1')].every(heading => readable(heading) === text(data.name)) &&
              owners.every(item => ['HowToSection', 'HowToStep'].some(type => isType((item.getAttribute('itemtype') || '').split(/\s+/), type)));
          });
          if (sections.length === 1) {
            const body = sections[0], extra = markup(body, data);
            const rows = [...body.querySelectorAll(fields.ingredients[0])], list = rows[0]?.parentElement;
            // Headings among this explicitly marked list's rows are ingredient group labels.
            if (!has(data.ingredients) && list?.matches('ul,ol') && rows.every(row => row.parentElement === list) &&
                [...list.children].every(el => el.matches('h1,h2,h3,h4,h5,h6') || el.matches(fields.ingredients[0]))) extra.ingredients = readable(list, true);
            if (!has(data.instructions)) {
              const method = outer([...body.querySelectorAll(fields.instructions[0])]).map(el => readable(el, true)).filter(Boolean).join('\n');
              if (method) extra.instructions = method;
            }
            for (const field of ['ingredients', 'instructions']) if (!has(data[field]) && has(extra[field])) data[field] = extra[field];
          }
        }
      }
      if (microdata || data.ingredients || cards.length && data.instructions) {
        results.push(normalize(data, microdata ? 'microdata' : cards.length ? 'markup' : 'headings', scope));
      } else if (!microdata && !cards.length && !has(data.ingredients) && !has(data.instructions)) {
        // A newspaper recipe: a heading, an intro, a paragraph of bold quantity lines, then the method as prose.
        for (const recipe of proseRecipes(scope)) results.push(normalize(recipe, 'headings', scope));
      }
    }
  }
  // Identical normalized results (a recipe published twice) collapse; distinct recipes stay.
  if (results.length < 2) return results;
  const signatures = results.map(result => JSON.stringify({ ...result, method: undefined }));
  const rank = { 'json-ld+markup': 0, 'json-ld': 0, microdata: 1, markup: 2, headings: 3 };
  // Complete recipes lead, structured provenance before inferred, otherwise document order.
  return results.filter((result, i) => signatures.indexOf(signatures[i]) === i)
    .sort((a, b) => a.missing.length - b.missing.length || rank[a.method] - rank[b.method]);
}
