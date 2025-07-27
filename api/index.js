import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import cors from 'cors';

// Initialize cors middleware.
const corsMiddleware = cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
});

async function runCorsMiddleware(req, res) {
    return new Promise((resolve, reject) => {
        corsMiddleware(req, res, (result) => {
            if (result instanceof Error) {
                return reject(result);
            }
            return resolve(result);
        });
    });
}

async function relayRequestWithPuppeteer(path, method, body) {
    console.log(`[Proxy] Initiating relay: ${method} to /api/${path}`);
    let browser = null;
    const stateChangingMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];

    try {
        // STEP 1: Launch the browser with robust settings for serverless environments
        console.log('[Proxy] Launching Chromium browser...');
        browser = await puppeteer.launch({
            args: [
              ...chromium.args,
                '--no-sandbox', // A required flag for running in many serverless/containerized environments
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Overcomes resource limits in some environments
                '--single-process', // Can reduce memory footprint
            ],
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });
        console.log('[Proxy] Browser launched successfully.');

        const page = await browser.newPage();
        const baseApiUrl = 'https://ssr-system.ct.ws';

        // STEP 2: Navigate to the base URL to establish a session and get cookies
        console.log(`[Proxy] Navigating to ${baseApiUrl} to establish session...`);
        try {
            // Use 'networkidle0' to wait for network activity to cease, indicating a fully loaded page.
            // A generous timeout is set to handle slow network conditions.
            await page.goto(baseApiUrl, { waitUntil: 'networkidle0', timeout: 12000 });
        } catch (navError) {
            console.error('[Proxy] Navigation to base URL failed:', navError.message);
            // On failure, capture a screenshot for remote debugging. This is invaluable.
            const screenshotBuffer = await page.screenshot({ encoding: 'base64' });
            console.log(`[Proxy] Screenshot of failure page: data:image/png;base64,${screenshotBuffer}`);
            throw new Error(`Navigation to ${baseApiUrl} timed out or failed.`);
        }
        console.log('[Proxy] Navigation successful. Page content loaded.');

        // Log cookies to verify that the Laravel session has been established.
        const cookies = await page.cookies();
        console.log('[Proxy] Cookies found after navigation:', JSON.stringify(cookies.map(c => ({name: c.name, domain: c.domain, httpOnly: c.httpOnly})), null, 2));
        if (!cookies.some(c => c.name.includes('session'))) {
            console.warn('[Proxy] WARNING: A session-like cookie was not found. CSRF/Auth may fail.');
        }

        let csrfToken = null;
        // Only attempt to scrape a CSRF token for methods that require it.
        if (stateChangingMethods.includes(method)) {
            console.log(`[Proxy] ${method} request detected. Attempting to fetch CSRF token...`);
            try {
                // STEP 3: Reliably scrape the CSRF token using an explicit wait, not a fixed timeout.
                await page.waitForSelector('meta[name="csrf-token"]', { timeout: 7000 });
                csrfToken = await page.evaluate(() => {
                    const meta = document.querySelector('meta[name="csrf-token"]');
                    return meta? meta.getAttribute('content') : null;
                });

                if (csrfToken) {
                    console.log('[Proxy] CSRF Token successfully extracted.');
                } else {
                    // This case handles if the meta tag exists but has no content.
                    throw new Error('CSRF meta tag was found, but its content attribute is empty or null.');
                }
            } catch (tokenError) {
                console.error('[Proxy] Critical error: Failed to find or extract CSRF token:', tokenError.message);
                const screenshotBuffer = await page.screenshot({ encoding: 'base64' });
                console.log(`[Proxy] Screenshot of page without CSRF token: data:image/png;base64,${screenshotBuffer}`);
                throw new Error('Could not find the CSRF token meta tag on the page.');
            }
        }

        // STEP 4: Execute the actual API request from within the browser's sandboxed context.
        const targetUrl = `${baseApiUrl}/api/${path}`;
        console.log(`[Proxy] Executing sandboxed fetch to: ${targetUrl}`);

        const response = await page.evaluate(async (url, method, body, token, stateChangingMethods) => {
            try {
                const headers = {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest', // Helps Laravel identify the request as AJAX.
                };

                // Add the CSRF token to the headers, the standard for modern APIs.
                if (token) {
                    headers = token;
                }

                const requestOptions = {
                    method: method,
                    headers: headers,
                };

                if (body && Object.keys(body).length > 0 && stateChangingMethods.includes(method)) {
                    requestOptions.body = JSON.stringify(body);
                }

                const apiResponse = await fetch(url, requestOptions);
                const responseText = await apiResponse.text();
                let responseData;
                try {
                    // Attempt to parse the response as JSON.
                    responseData = JSON.parse(responseText);
                } catch (e) {
                    // If parsing fails, return the raw text. This handles HTML error pages gracefully.
                    responseData = responseText;
                }
                return { status: apiResponse.status, data: responseData };
            } catch (error) {
                // This captures errors within the fetch call itself (e.g., network issues inside the sandbox).
                return { status: 500, data: { message: `page.evaluate() fetch failed: ${error.message}` } };
            }
        }, targetUrl, method, body, csrfToken, stateChangingMethods);

        console.log(`[Proxy] Relay completed with backend status: ${response.status}`);
        return response;

    } catch (error) {
        console.error('[Proxy] A fatal error occurred during the Puppeteer relay operation:', error);
        // Return a detailed error message to the client.
        return { status: 502, data: { error: true, message: `Proxy error: ${error.message}` } };
    } finally {
        if (browser) {
            await browser.close();
            console.log('[Proxy] Puppeteer browser instance closed.');
        }
    }
}

export default async function handler(req, res) {
    await runCorsMiddleware(req, res);

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    const path = req.url.startsWith('/api/') ? req.url.substring(5) : req.url.substring(1);
    const body = req.body;

    const result = await relayRequestWithPuppeteer(path, req.method, body);

    res.status(result.status).json(result.data);
}
