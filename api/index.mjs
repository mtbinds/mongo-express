import 'dotenv/config.js';
import csrf from 'csurf';
import express from 'express';
import middleware from '../lib/middleware.js';
import { deepmerge } from '../lib/utils.js';
import configDefault from '../config.default.js';
import fs from 'node:fs';

const loadConfig = async () => {
  if (fs.existsSync('./config.js')) {
    const { default: configCustom } = await import('../config.js');
    return deepmerge(configDefault, configCustom);
  }
  return configDefault;
};

const app = express();

const config = await loadConfig();
const resolvedMiddleware = await middleware(config);

app.use(config.site.baseUrl, resolvedMiddleware);
app.use(
  config.site.baseUrl,
  csrf({ cookie: true }),
);

export default app;
