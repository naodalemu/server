import { join } from 'path';
import { homedir } from 'os';

/**
 * @type {import("puppeteer").Configuration}
 */
export default {
  // Changes the cache location for Puppeteer.
  cacheDirectory: join(homedir(), '.cache', 'puppeteer'),

  /**
   * By default, Puppeteer downloads Chromium to a shared location for all projects.
   * This changes the location to the project's node_modules directory.
   */
  downloadPath: join(process.cwd(), 'node_modules'),
};
