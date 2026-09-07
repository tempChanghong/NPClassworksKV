// The command loads deploy/.env.debug before imports; production startup remains bin/www.
process.env.NODE_ENV = 'development';
await import('../bin/www');
