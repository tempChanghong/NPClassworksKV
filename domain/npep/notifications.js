import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import schema from './notifications.schema.json' with {type: 'json'};
const ajv = new Ajv({strict: true});
addFormats(ajv);
const validators = new Map();
export function validateNotification(name, value) {
  if (!validators.has(name)) validators.set(name, ajv.compile({definitions: schema.definitions, $ref: `#/definitions/${name}`}));
  return validators.get(name)(value);
}
