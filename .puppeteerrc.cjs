// .puppeteerrc.cjs

const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Changes the cache location for Puppeteer.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),

  /**
   * This is the section that downloads the browser.
   * We are telling Puppeteer to not download a browser, and to use the one from @sparticuz/chromium instead.
   */
  skipDownload: true,
};
