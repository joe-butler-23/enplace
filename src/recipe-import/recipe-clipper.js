// Vendored from the RecipeClipper browser rewrite (src/index.js at commit 40539e8, SHA256 e3067ce94c4f9ee1…),
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

const labelField = label => /^(ingredients|ingrédients|ingrediënten|ingredientes|ingredienti|ingredienser|zutaten|składniki|hozzávalók|suroviny|υλικά|ингредиенты|材料|用料)$/.test(label) ? 'ingredients'
  : /^(instructions|cooking instructions|directions|method|procedure|steps|preparation|(?:here['’]s )?how to make it|préparation|zubereitung|bereiden|bereiding|bereidingswijze|preparación|elaboración|preparazione|preparação|modo de preparo|fremgangsmåde|tilberedning|gör så här|przygotowanie|elkészítés|postup|εκτέλεση|приготовление|做法|步骤|作り方)$/.test(label) ? 'instructions' : '';

const nutritionLabels = {
  calories: 'Calories', fatContent: 'Fat', saturatedFatContent: 'Saturated Fat',
  cholesterolContent: 'Cholesterol', sodiumContent: 'Sodium', carbohydrateContent: 'Carbohydrates',
  fiberContent: 'Fiber', sugarContent: 'Sugar', proteinContent: 'Protein', servingSize: 'Serving Size',
};
const canonical = data => ({ ...data,
  ingredients: data.recipeIngredient ?? data.recipeIngredients ?? data.ingredients,
  instructions: data.recipeInstructions ?? data.instructions });

function readable(root, sections, listed) {
  const visit = node => {
    if (node.nodeType === 3) return !listed || root.contains(node.parentElement?.closest('li')) ? node.nodeValue.replace(/\s+/g, ' ') : '';
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
const content = (node, steps) => {
  // A nested download/control list cannot suppress surrounding table or definition rows.
  const listed = !steps && node.tagName !== 'LI' && !node.querySelector('tr,dt,dd') && !!node.querySelector('li:not([role="tablist"] li)');
  let value = readable(node, true, listed).replace(node.nodeType === 1 ? /^\[[^\]\n]*\](?:\n|$)/ : '', '');
  // A single ingredient row may split amount and description into block cells.
  if (!steps && node.matches?.('li,tr') && !node.querySelector('li,tr,dl,br')) value = value.replace(/\n/g, ' ');
  return value;
}; // An element's own leading heading is its title, not a section.

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
    // A document title can carry site/rating text; require two metadata titles and an owned heading to agree.
    if (scope?.matches('html') && scope.querySelector('title[itemprop~="name"]') && title === clean(doc.title)) {
      const social = clean(doc.querySelector('meta[property="og:title"]')?.getAttribute('content'));
      const twitter = clean(doc.querySelector('meta[name="twitter:title"]')?.getAttribute('content'));
      if (social && social === twitter && title.startsWith(`${social} `)) {
        const headings = [...scope.querySelectorAll('h1')].filter(heading => {
          const owner = heading.closest('article,main,[role="main"]');
          return readable(heading) === social && owner && owner.querySelector(fields.ingredients[0]) && owner.querySelector(fields.instructions[0]);
        });
        if (headings.length === 1) title = social;
      }
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
          const group = label && label !== text(existing.name || data.name) && !labelField(label.toLowerCase().replace(/[:：]\s*$/, '').trim());
          return [group ? `[${label}]` : '', field === 'ingredients' ? content(el) : readable(el, field === 'instructions')];
        }).filter(Boolean);
        if (values.length) data[field] = field === 'name' ? values[0] : values.join('\n');
      }
    }
    if (!has(existing.ingredients || data.ingredients) || !has(existing.instructions || data.instructions)) {
      const readAfter = (start, end) => {
        const range = doc.createRange();
        range.selectNodeContents(start.parentElement); range.setStartAfter(start);
        if (end) range.setEndBefore(end);
        return readable(pruneNestedCards(range.cloneContents()), true);
      };
      const labels = new Map(), columns = new Map();
      for (const node of scope.querySelectorAll('p,h1,h2,h3,h4,h5,h6')) {
        const paragraph = node.tagName === 'P';
        if (paragraph && node.textContent.length > 120) continue; // A caption paragraph is short; ordinary prose need not be read.
        let field = paragraph ? labelField(readable(node).toLowerCase().replace(/[:：]\s*$/, '').trim()) : '';
        if (paragraph && !field) continue;
        // A transparent wrapper does not change ownership of the exact caption.
        let block = node;
        while (block.parentElement !== scope && block.parentElement?.children.length === 1 &&
            [...block.parentElement.childNodes].every(child => child.nodeType !== 3 || !child.nodeValue.trim())) block = block.parentElement;
        const owner = block.parentElement, root = owner?.parentElement;
        const column = owner?.firstElementChild === block && root?.children.length === 2 && scope.contains(root) &&
          [...root.childNodes].every(child => child.nodeType !== 3 || !child.nodeValue.trim());
        // Headings are eligible only for two-column ownership; ordinary headings need no text traversal here.
        if (!paragraph) {
          if (!column) continue;
          field = labelField(readable(node).toLowerCase().replace(/[:：]\s*$/, '').trim());
        }
        if (!field || !belongs(node, scope) || hiddenByAncestor(node) || node.closest('nav,header,footer,[role="navigation"]')) continue;
        if (paragraph) {
          const pair = labels.get(node.parentElement) || [];
          pair.push({ node, field }); labels.set(node.parentElement, pair);
        }
        if (column) {
          const pair = columns.get(root) || [];
          pair.push({ node: block, field, owner }); columns.set(root, pair);
        }
      }
      const pairs = [...labels.values()].filter(pair => pair.length === 2 &&
        pair[0].field === 'ingredients' && pair[1].field === 'instructions');
      if (pairs.length === 1) {
        const [ingredients, instructions] = pairs[0];
        const pair = { ingredients: readAfter(ingredients.node, instructions.node), instructions: readAfter(instructions.node) };
        if (has(pair.ingredients) && has(pair.instructions)) for (const field of ['ingredients', 'instructions'])
          if (!has(existing[field]) && !has(data[field])) data[field] = pair[field];
      }
      const columnPairs = [...columns.values()].filter(pair => pair.length === 2 &&
        pair[0].field === 'ingredients' && pair[1].field === 'instructions' && pair[0].owner !== pair[1].owner);
      if (!pairs.length && columnPairs.length === 1) {
        const pair = Object.fromEntries(columnPairs[0].map(({ node, field }) => [field, readAfter(node)]));
        if (has(pair.ingredients) && has(pair.instructions)) for (const field of ['ingredients', 'instructions'])
          if (!has(existing[field]) && !has(data[field])) data[field] = pair[field];
      }
      // Explicit local targets keep collapsed field bodies separate from other accordion panels.
      const panels = new Map();
      for (const control of scope.querySelectorAll('a[data-target],button[data-target],a[aria-controls],button[aria-controls]')) {
        const field = labelField(clean(control.textContent).toLowerCase().replace(/[:：]\s*$/, '').trim());
        if (!field || !belongs(control, scope) || hiddenByAncestor(control) || control.closest('nav,header,footer,[role="navigation"]')) continue;
        const fragment = control.getAttribute('data-target');
        const id = fragment?.startsWith('#') ? fragment.slice(1) : control.getAttribute('aria-controls');
        const target = id && !/\s/.test(id) ? doc.getElementById(id) : null;
        const owner = target?.parentElement, root = owner?.parentElement;
        if (!target || hiddenByAncestor(target) || target.contains(control) || !owner.contains(control) || !scope.contains(root) || !belongs(target, scope)) continue;
        const pair = panels.get(root) || [];
        pair.push({ field, target, owner }); panels.set(root, pair);
      }
      const panelPairs = [...panels.values()].filter(pair => pair.length === 2 &&
        pair[0].field === 'ingredients' && pair[1].field === 'instructions' && pair[0].owner !== pair[1].owner);
      if (panelPairs.length === 1) {
        const pair = Object.fromEntries(panelPairs[0].map(({ field, target }) => [field, readable(pruneNestedCards(target.cloneNode(true)), true)]));
        if (has(pair.ingredients) && has(pair.instructions)) for (const field of ['ingredients', 'instructions'])
          if (!has(existing[field]) && !has(data[field])) data[field] = pair[field];
      }
      // This paired recipe component names its food list and its ordered procedure locally.
      const components = [...scope.querySelectorAll('.recipe-content')].filter(body => belongs(body, scope) &&
        !hiddenByAncestor(body) && !body.querySelector('[itemscope],.recipe-content,article,main,dialog,[role="dialog"],nav,header,footer') &&
        !cards.some(card => card !== body && body.contains(card)) && body.children.length === 2 &&
        [...body.childNodes].every(child => child.nodeType !== 3 || !child.nodeValue.trim()) &&
        body.children[0].matches('.recipe-left') && body.children[1].matches('.recipe-right'));
      if (components.length === 1) {
        const body = components[0], [left, right] = body.children;
        const titles = [...scope.querySelectorAll('h1')].filter(title => belongs(title, scope) && !hiddenByAncestor(title) &&
          title.closest('article') === body.closest('article') && readable(title));
        const captions = [...left.children].filter(node => node.matches('em,p,h1,h2,h3,h4,h5,h6'));
        const ingredients = captions.filter(node => labelField(readable(node).toLowerCase()) === 'ingredients');
        const tools = captions.filter(node => /^(tools|equipment)$/i.test(readable(node)));
        const procedure = right.firstElementChild;
        if (titles.length === 1 && ingredients.length === 1 && tools.length <= 1 && !hiddenByAncestor(left) && !hiddenByAncestor(right) &&
            ingredients[0].nextElementSibling?.matches('ul') && procedure?.matches('p,h1,h2,h3,h4,h5,h6') &&
            /^let['’]s get started!$/i.test(readable(procedure)) && procedure.nextElementSibling?.matches('ol') &&
            readable(ingredients[0].nextElementSibling) && readable(procedure.nextElementSibling)) {
          const start = ingredients[0], tool = tools[0], after = tool && !!(start.compareDocumentPosition(tool) & 4);
          const pair = { ingredients: readAfter(start, after ? tool : null), instructions: readAfter(procedure) };
          if (has(pair.ingredients) && has(pair.instructions)) {
            for (const field of ['ingredients', 'instructions']) if (!has(existing[field]) && !has(data[field])) data[field] = pair[field];
            const first = left.firstElementChild;
            const genericCaption = first?.matches('h1,h2,h3,h4,h5,h6') && /^things you['’]ll need$/i.test(readable(first));
            const prefix = first !== start ? (first === tool ? `[${readable(tool)}]\n` : genericCaption ? '' : readable(first, true) + '\n') + readAfter(first, start) : '';
            const notes = [prefix, after ? `[${readable(tool)}]\n${readAfter(tool)}` : ''].filter(Boolean).join('\n');
            if (notes && !has(existing.notes) && !has(data.notes)) data.notes = notes;
          }
        }
      }
    }
    // A named recipe body may publish taxonomy-linked ingredients beside an explicit method accordion.
    if (!has(existing.ingredients) && !has(data.ingredients)) {
      const bodies = [...scope.querySelectorAll('.recipe__body')].filter(body => belongs(body, scope));
      const body = bodies.length === 1 ? bodies[0] : null;
      const titles = body ? [...body.parentElement.querySelectorAll('.recipe__title')].filter(title => belongs(title, scope)) : [];
      const methods = body ? [...body.querySelectorAll('[itemprop~="recipeInstructions"].accordion-trigger')]
        .filter(trigger => belongs(trigger, scope) && trigger.nextElementSibling?.matches('.accordion__content')) : [];
      const asides = body ? [...body.querySelectorAll('.recipe__aside')].filter(aside => belongs(aside, scope) && aside.querySelector(':scope > ul')) : [];
      if (titles?.length === 1 && methods.length === 1 && asides.length === 1) {
        const aside = asides[0], rows = [...aside.querySelectorAll(':scope > ul > li')];
        if (rows.length && rows.every(row => belongs(row, scope) && row.querySelector('a[href*="/ingredient/"]'))) {
          data.ingredients = [...aside.children].filter(el => el.matches('ul,h1,h2,h3,h4,h5,h6'))
            .map(el => readable(el, true)).filter(Boolean).join('\n');
          if (!has(existing.name) && !has(data.name)) data.name = readable(titles[0]);
          if (!has(existing.instructions)) data.instructions = content(methods[0].nextElementSibling, true);
        }
      }
    }
    for (const [field, selectors] of Object.entries(fields)) {
      if (has(existing[field]) || has(data[field])) continue;
      for (const selector of selectors) {
        const matches = [...scope.querySelectorAll(selector)].filter(el => belongs(el, scope) &&
          (field !== 'ingredients' || !el.matches(fields.instructions.join(','))));
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
            const group = el.previousElementSibling;
            if (group?.matches('li[class*="ingredientSectionHeading" i]') && !matches.includes(group) && belongs(group, scope) && !hiddenByAncestor(group)) {
              const label = readable(group);
              if (label) return `[${label}]\n${content(el)}`;
            }
          }
          if (field === 'ingredients' && selector === fields.ingredients.at(-1)) {
            const captions = [...el.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(node => belongs(node, scope) && !hiddenByAncestor(node));
            const fieldOf = node => labelField(readable(node).toLowerCase().replace(/\s*[:*(].*$/, ''));
            const end = captions.slice(1).find(node => fieldOf(node) === 'instructions');
            if (captions.length && fieldOf(captions[0]) === 'ingredients' && end) {
              const range = doc.createRange();
              range.selectNodeContents(el); range.setStartAfter(captions[0]); range.setEndBefore(end);
              return content(pruneNestedCards(range.cloneContents()));
            }
          }
          return /ingredients|instructions/.test(field) ? content(el, field === 'instructions') : readable(el);
        }).filter(Boolean);
        if (values.length) {
          data[field] = field === 'name' ? values[0] : values.join('\n');
          break;
        }
      }
    }
    const image = has(existing.image || data.image) ? null : scope.querySelector('[class*="recipe-image" i] img,img[class*="recipe-image" i]');
    data.image ||= image?.getAttribute('data-src') || image?.getAttribute('src') || '';
    if (has(existing.ingredients || data.ingredients) && has(existing.instructions || data.instructions)) return data;
    const headings = [...scope.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(el => belongs(el, scope) && !hiddenByAncestor(el));
    // A title-linked, numbered procedure can corroborate a sibling supplies caption.
    const caption = node => readable(node).toLowerCase().replace(/^[^\p{L}\p{N}]+/u, '').trim();
    const recipeArticle = scope.matches('article') && [...scope.classList].some(name => /(?:^|[-_])recipes?(?:$|[-_])/i.test(name));
    const procedures = recipeArticle ? headings.filter(node => caption(node).startsWith('how to make ')) : [];
    const pairedFields = new Map();
    if (procedures.length === 1) {
      const method = procedures[0], title = caption(method).slice('how to make '.length);
      const titles = [...doc.querySelectorAll('h1')].filter(node => !hiddenByAncestor(node) && caption(node) === title);
      const siblings = headings.filter(node => node.parentElement === method.parentElement);
      const start = siblings.indexOf(method), end = siblings.findIndex((node, i) => i > start && node.tagName <= method.tagName);
      const steps = siblings.slice(start + 1, end < 0 ? undefined : end);
      const ingredients = siblings.slice(0, start).filter(node => node.tagName === method.tagName && /^what you['’]ll need$/.test(caption(node)));
      if (titles.length === 1 && ingredients.length === 1 && steps.length &&
          steps.every((node, i) => Number(node.tagName.slice(1)) === Number(method.tagName.slice(1)) + 1 &&
            /^step\s+(\d+)\s*:/i.exec(readable(node))?.[1] === String(i + 1) &&
            node.nextElementSibling?.tagName === 'P' && readable(node.nextElementSibling))) {
        pairedFields.set(ingredients[0], 'ingredients'); pairedFields.set(method, 'instructions');
      }
    }
    const captions = headings.map(node => labelField(readable(node).toLowerCase().replace(/\s*[:*(].*$/, '')));
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i], field = captions[i] || pairedFields.get(heading);
      if (!field || has(data[field]) || has(existing[field])) continue;
      const body = heading.closest('[itemprop~="articleBody"],.sqs-layout');
      const owner = body && scope.contains(body) ? body : scope;
      // A later field caption ends this field even when its heading level is deeper.
      const end = headings.slice(i + 1).find((next, k) => owner.contains(next) && (next.tagName <= heading.tagName || captions[i + 1 + k]));
      const range = doc.createRange();
      range.selectNodeContents(owner); range.setStartAfter(heading);
      if (end) range.setEndBefore(end);
      const fragment = range.cloneContents();
      data[field] = pairedFields.has(heading) ? readable(fragment, true) : content(fragment, /instructions/.test(field));
    }
    // A standalone method caption can own a complete ordered list and explicitly labelled notes.
    if (has(existing.ingredients || data.ingredients) && !has(existing.instructions || data.instructions)) {
      const captions = [...scope.querySelectorAll('p')].filter(el => belongs(el, scope) && !hiddenByAncestor(el) &&
        labelField(readable(el).toLowerCase().replace(/[:：]\s*$/, '').trim()) === 'instructions' && el.nextElementSibling?.tagName === 'OL');
      if (captions.length === 1) {
        const list = captions[0].nextElementSibling, notes = [];
        for (let el = list.nextElementSibling; el; el = el.nextElementSibling) notes.push(el);
        if (notes.every(el => el.tagName === 'P' && /^(?:notes?|tips?|options?):\s/i.test(readable(el))) &&
            (!notes.length || !has(existing.notes || data.notes))) {
          data.instructions = readable(list, true);
          if (notes.length) data.notes = notes.map(el => readable(el)).join('\n');
        }
      }
    }
    return data;
  };

  // Add source quantities only when one owned row set preserves every schema item in order.
  const quantityRows = (scope, existing, reconcile = false) => {
    const flat = value => value.replace(/\s+/g, ' ').trim();
    const unwrap = value => value.replace(/\(\(/g, '(').replace(/\)\)/g, ')');
    if (hiddenByAncestor(scope)) return null;
    const owned = el => {
      for (let node = el; node; node = node.parentElement) {
        if (concealed(node) || node.matches('template,nav,header,footer,[role="navigation"],dialog,[role="dialog"]')) return false;
        if (node === scope) return true;
        if (cardSet.has(node) || node.matches('[itemscope],article,main,[role="main"]')) return false;
      }
      return false;
    };
    const groups = new Map(), nameSelector = classes('ingredient-name ingredient__label');
    for (const list of scope.querySelectorAll('ul,ol')) {
      const label = list.previousElementSibling;
      const labelled = label && (/^H[1-6]$/.test(label.tagName) || label.matches('p') && label.children.length === 1 && label.firstElementChild.matches('b,strong')) &&
        labelField(readable(label).toLowerCase().split(/\s+/)[0].replace(/[:：]$/, '')) === 'ingredients';
      if (!owned(list) || list.matches(fields.instructions.join(',')) || !labelled &&
          !list.matches(fields.ingredients[0] + ',' + fields.ingredients[2]) && !list.parentElement.matches(fields.ingredients[2])) continue;
      groups.set(list, [...list.children].filter(row => row.tagName === 'LI').map(node => {
        const names = [...node.querySelectorAll(nameSelector)];
        return { node, name: names[0], invalid: names.length > 1 };
      }));
    }
    for (const name of scope.querySelectorAll(nameSelector)) {
      const row = name.parentElement, cells = [...row.children];
      const amount = cells.find(cell => cell !== name && [...cell.classList].some(token => /(?:^|[-_])(?:amount|quantity)(?:$|[-_])/i.test(token)));
      const value = cells.length === 2 && amount ? { node: row, name, cells } : { node: row, invalid: true };
      for (let parent = row.parentElement; parent && parent !== scope; parent = parent.parentElement) {
        if (parent.matches('[class*="ingredients" i]') && !parent.matches('ul,ol')) {
          if (!groups.has(parent)) groups.set(parent, []);
          groups.get(parent).push(value);
        }
      }
    }
    const wanted = existing.map(flat), matches = [];
    for (const [owner, rows] of groups) {
      if (!owned(owner) || rows.length !== wanted.length || rows.some(row => row.invalid || !owned(row.node) || row.node.querySelector('[itemscope],li,ul,ol,article,main,[role="main"],dialog,[role="dialog"],nav,header,footer,[role="navigation"]'))) continue;
      if (matches.some(match => match.rows.every((row, i) => row.node === rows[i].node))) continue;
      const values = rows.map(row => flat(row.cells ? row.cells.map(cell => readable(cell)).join(' ') : readable(row.node)));
      if (!values.every((value, i) => reconcile ? value === unwrap(wanted[i]) : (!rows[i].name || flat(readable(rows[i].name)) === wanted[i]) &&
          (value === wanted[i] || value.startsWith(wanted[i] + ' ') || value.endsWith(' ' + wanted[i])))) continue;
      matches.push({ owner, rows, values });
    }
    if (matches.length !== 1 || !matches[0].values.some((value, i) => value !== wanted[i])) return null;
    const { owner, rows, values } = matches[0];
    const ordered = rows.map((row, i) => ({ node: row.node, value: values[i] }));
    for (const node of outer([...owner.querySelectorAll('[class*="ingredient__subtitle" i]')])) {
      if (!owned(node) || rows.some(row => row.node.contains(node) || node.contains(row.node))) continue;
      const label = flat(readable(node));
      if (label) ordered.push({ node, value: `[${label}]` });
    }
    return ordered.sort((a, b) => a.node.compareDocumentPosition(b.node) & 2 ? 1 : -1).map(row => row.value);
  };

  // Visible lines that repeat every serialised row in order, with nothing but short captions between them,
  // are the page's own rendering of the list; they are adopted when their numerals are written differently.
  const renderedRows = (root, rows) => {
    const keys = rows.map(rowKey);
    if (keys.some(key => !key)) return null;
    const visible = readable(root).split('\n'), matched = [];
    let from = 0;
    for (const key of keys) {
      const at = visible.findIndex((line, i) => i >= from && rowKey(line) === key);
      if (at < 0) return null;
      matched.push(at); from = at + 1;
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
    const result = [];
    let changed = false;
    // A caption directly above the first row names the first group, unless it is the field's own heading.
    const lead = visible[matched[0] - 1];
    if (lead && lead.length <= 48 && captionRow.test(lead) && !labelField(lead.toLowerCase().replace(/[:：]\s*$/, '').trim())) result.push(`[${lead.replace(/:$/, '').trim()}]`);
    for (let i = matched[0]; i <= matched.at(-1); i++) {
      const line = visible[i], row = matched.indexOf(i);
      if (row >= 0) { const value = respelt(rows[row], line); result.push(value); changed ||= value !== rows[row]; }
      else if (!/\d/.test(line) && line.split(/\s+/).length <= 5) result.push(`[${line.replace(/:$/, '').trim()}]`);
      else return null;
    }
    return changed ? result : null;
  };

  // A paragraph made only of bold lines, most opening with a quantity, is a printed ingredient list.
  const quantityLine = /^(?:\d|[¼½¾⅓⅔⅛⅜⅝⅞]|(?:around|about|approx\.?|roughly) \d)/iu;
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
      if (!belongs(heading, scope) || hiddenByAncestor(heading)) continue;
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
    if (!scope && recipes.length === 1 && (fillMissing || probeQuantities || scalar)) {
      const name = text(data.name);
      // A visible title equal to the name, or the name less a trailing site label, corroborates ownership.
      const titled = heading => {
        const title = readable(heading), rest = title && name.startsWith(title) ? name.slice(title.length) : null;
        return rest === '' || !!rest && /^\s*[-–—|:·(]|\s[-–—|·]\s/.test(rest);
      };
      const headings = [...doc.querySelectorAll('h1')].filter(heading => !hiddenByAncestor(heading) && titled(heading));
      // Without any article or main landmark, the document itself is the only possible owner.
      const landmark = doc.querySelector('article,main,[role="main"]');
      const owners = new Set(headings.map(heading => heading.closest('article,main,[role="main"]') || (landmark ? null : doc.body)).filter(Boolean));
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
    // Serialized rows wrapped in doubled parentheses are rendered once in their visible owned rows.
    const probeParentheses = Array.isArray(data.ingredients) && data.ingredients.some(item => typeof item === 'string' && item.includes('((') && item.includes('))'));
    const quantities = probeQuantities && scope ? quantityRows(scope, data.ingredients)
      : probeParentheses && scope ? quantityRows(scope, data.ingredients, true) : null;
    if (quantities) additions.ingredients = quantities;
    // Serialised decimals such as "50.0g" beside a rendered "50g" are re-read from the page's own rows.
    const rows = !quantities && Array.isArray(data.ingredients) && data.ingredients.length > 1 && data.ingredients.every(item => typeof item === 'string') ? data.ingredients : null;
    if (rows && rows.some(item => /\d\.\d/.test(item))) {
      const landmarks = doc.querySelectorAll('article,main');
      const rendered = renderedRows(scope || (landmarks.length === 1 ? landmarks[0] : doc.body), rows);
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
