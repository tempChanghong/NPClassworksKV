import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
// Optional isolated dependency directory when a moved checkout has stale junctions.
const require = createRequire(process.env.NPEP_SCHEMA_VALIDATION_ROOT
  ? resolve(process.env.NPEP_SCHEMA_VALIDATION_ROOT, 'package.json')
  : new URL('../../package.json', import.meta.url));
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const schema = JSON.parse(fs.readFileSync(new URL('runtime-control.schema.json', import.meta.url)));
const {cases, semanticCasesNotExecuted} = JSON.parse(fs.readFileSync(new URL('examples.json', import.meta.url)));
const ajv = new Ajv({strict: true, allErrors: true});
addFormats(ajv);
const validators = new Map(Object.keys(schema.definitions).map(name => [name,
  ajv.compile({definitions: schema.definitions, $ref: `#/definitions/${name}`})]));

function utf16Check(spec, value) {
  if (spec.$ref) return utf16Check(schema.definitions[spec.$ref.split('/').at(-1)], value);
  if (spec.anyOf) return spec.anyOf.some(branch => {
    if (branch.type === 'null') return value === null;
    return value !== null && utf16Check(branch, value);
  });
  if (typeof value === 'string') return value.isWellFormed() && (spec.maxLength === undefined || value.length <= spec.maxLength);
  if (Array.isArray(value) && spec.items) return value.every(item => utf16Check(spec.items, item));
  if (value && typeof value === 'object' && spec.properties) return Object.entries(value).every(([key, item]) =>
    !spec.properties[key] || utf16Check(spec.properties[key], item));
  return true;
}
for (const example of cases) {
  assert.ok(validators.has(example.definition), example.definition);
  const validate = validators.get(example.definition);
  const valid = validate(example.value) && utf16Check(schema.definitions[example.definition], example.value);
  assert.equal(valid, example.valid, `${example.name}: ${JSON.stringify(validate.errors)}`);
}
console.log(`PASS ${cases.length}/${cases.length} documentation shape/UTF-16 examples; ${validators.size} definitions compiled.`);
console.log(`${semanticCasesNotExecuted.length} semantic scenarios listed, NOT EXECUTED. No server, database or Windows actions tested.`);
