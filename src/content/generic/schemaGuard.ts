/**
 * BR-G6-01. Structural validation for the healing contracts without runtime code generation.
 *
 * A content script is evaluated under the host page's Content Security Policy, so a validator
 * that compiles its schema into a function body generated from a string throws while the module
 * is still loading, and takes the whole generic bundle down with it. That is not a degraded
 * repair path: nothing in the bundle installs. The schemas the healing contracts need are
 * closed, string-shaped and three keywords wide, so they are interpreted here, not compiled.
 */

export type SchemaRule =
  | { readonly const: string }
  | { readonly enum: readonly string[] }
  | { readonly type: "array"; readonly maxItems: number; readonly items: { readonly type: "string" } };

export type ObjectSchema = {
  readonly type: "object";
  readonly additionalProperties: false;
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, SchemaRule>>;
};

const valueMatchesRule = (rule: SchemaRule, value: unknown): boolean => {
  if ("const" in rule) return value === rule.const;
  if ("enum" in rule) return typeof value === "string" && rule.enum.includes(value);
  return Array.isArray(value)
    && value.length <= rule.maxItems
    && value.every((entry) => typeof entry === "string");
};

/**
 * Own keys only, in both directions. `in` walks the prototype chain, so a parsed payload
 * carrying `constructor` or `toString` would otherwise pass the closed-object check against a
 * schema that never declared it.
 */
export const createSchemaValidator = (schema: ObjectSchema) => (value: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(schema.properties, key)) return false;
  }
  for (const key of schema.required) {
    if (!Object.hasOwn(record, key)) return false;
  }
  for (const key of Object.keys(schema.properties)) {
    if (!Object.hasOwn(record, key)) continue;
    if (!valueMatchesRule(schema.properties[key] as SchemaRule, record[key])) return false;
  }
  return true;
};
