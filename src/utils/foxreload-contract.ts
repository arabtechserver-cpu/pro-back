export interface FieldChoice { value: string; label: string }

// Keep the submitted value separate from the label shown to the customer.
export function fieldChoices(raw: any): FieldChoice[] {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = raw.split(/\\n|[\r\n,|]+/); }
  }
  if (!raw || typeof raw !== 'object') return [];
  const entries = Array.isArray(raw) ? raw.map((v, i) => [String(i), v]) : Object.entries(raw);
  const seen = new Set<string>();
  return entries.flatMap(([key, item]: any[]) => {
    const value = item && typeof item === 'object' ? item.value ?? item.id : Array.isArray(raw) ? item : key;
    if (value === undefined || value === null || String(value) === '' || typeof value === 'object') return [];
    const text = String(value);
    if (seen.has(text)) return [];
    seen.add(text);
    return [{ value: text, label: String(item && typeof item === 'object' ? item.label ?? item.name ?? text : item) }];
  });
}

export function foxreloadCustomFields(product: any): any[] {
  const required: string[] = product.requiredNoteFields || [];
  const names = new Set<string>([...required, ...Object.keys(product.noteFieldTypes || {}), ...Object.keys(product.noteFieldOptions || {})]);
  return Array.from(names, name => {
    const choices = fieldChoices(product.noteFieldOptions?.[name]);
    const nativeType = product.noteFieldTypes?.[name] || (choices.length ? 'select' : 'string');
    const type = choices.length ? 'select' : nativeType === 'integer' ? 'number' : nativeType === 'string' ? 'text' : nativeType;
    return { name, fieldname: name, field_id: name, label: name, type, fieldtype: type,
      provider_field_type: nativeType, required: required.includes(name),
      options: choices.map(c => c.value), fieldoptions: choices.map(c => c.value), option_choices: choices };
  });
}

export function validateFoxreloadOrder(product: any, quantity: any, input: any, target?: string):
  { quantity: number; notes: Record<string, string | number> } {
  const qty = Number(quantity);
  const minimum = product.orderMinQuantity ?? product.minQty ?? 1;
  const maximum = product.orderMaxQuantity ?? product.maxQty;
  if (!Number.isSafeInteger(qty) || qty < minimum || qty < 1 || (maximum != null && maximum > 0 && qty > maximum)) {
    throw new Error(`Quantity must be an integer between ${minimum} and ${maximum || 'the provider limit'}`);
  }
  if (product.quantity != null && Number.isFinite(Number(product.quantity)) && qty > Number(product.quantity)) throw new Error('Requested quantity exceeds provider stock');
  if (product.price === null || (product.price !== undefined && (!Number.isFinite(Number(product.price)) || Number(product.price) < 0))) throw new Error('Product is unavailable for purchase');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Notes must be an object');
  const notes: Record<string, string | number> = Object.create(null);
  for (const field of foxreloadCustomFields(product)) {
    const key = field.name;
    let value = input[key] ?? input[`custom_${key}`];
    if ((value === undefined || value === null || value === '') && target && field.required && ['account_id', 'player_id', 'id'].includes(key)) value = target;
    if (value === undefined || value === null || value === '') {
      if (field.required) throw new Error(`Required field: ${key}`);
      continue;
    }
    if (!['string', 'number'].includes(typeof value)) throw new Error(`Invalid field: ${key}`);
    const text = String(value);
    if (field.required && !text.trim()) throw new Error(`Required field: ${key}`);
    if (field.option_choices.length && !field.option_choices.some((c: FieldChoice) => c.value === text)) throw new Error(`Invalid option for ${key}`);
    const type = field.provider_field_type;
    if (type === 'integer' || type === 'number') {
      const number = Number(text);
      if (!text.trim() || !Number.isFinite(number) || (type === 'integer' && !Number.isSafeInteger(number))) throw new Error(`Invalid ${type} for ${key}`);
      notes[key] = number;
    } else {
      if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new Error(`Invalid email for ${key}`);
      notes[key] = text;
    }
  }
  return { quantity: qty, notes };
}
