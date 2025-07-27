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
    console.log(`Relaying request: ${method} to /api/${path}`);
    let browser = null;
    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();
        const baseApiUrl = 'https://ssr-system.ct.ws';

        console.log('Navigating to base URL to solve security challenge...');

        await page.goto(baseApiUrl, { timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 3000));

        console.log('Security challenge passed, cookies should be set.');

        // **NEW:** Get the XSRF-TOKEN from the browser's cookies
        const cookies = await page.cookies();
        const xsrfTokenCookie = cookies.find(cookie => cookie.name === 'XSRF-TOKEN');
        const xsrfToken = xsrfTokenCookie ? decodeURIComponent(xsrfTokenCookie.value) : null;

        if (xsrfToken) {
            console.log('XSRF Token found in cookie:', xsrfToken);
        } else {
            console.log('WARNING: XSRF-TOKEN cookie not found.');
        }

        // This block is still useful as a fallback for non-API form pages
        if (method === 'POST') {
            console.log('POST request detected. Attempting to fetch CSRF token from HTML...');
            const csrfToken = await page.evaluate(() => {
                const metaToken = document.querySelector('meta[name="csrf-token"]');
                if (metaToken) return metaToken.getAttribute('content');
                const inputToken = document.querySelector('input[name="_token"]');
                if (inputToken) return inputToken.value;
                return null;
            });
            if (csrfToken) {
                console.log('CSRF Token found in HTML:', csrfToken);
                body._token = csrfToken;
            } else {
                console.log('WARNING: No CSRF token found in HTML.');
            }
        }

        const targetUrl = `${baseApiUrl}/api/${path}`;

        // **MODIFIED:** Pass the xsrfToken to page.evaluate and add it to headers
        const response = await page.evaluate(async (url, method, body, token) => {
            try {
                const requestOptions = {
                    method: method,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    }
                };

                // **NEW:** Add the X-XSRF-TOKEN header if it exists
                if (token) {
                    requestOptions.headers = token;
                }

                if (body && Object.keys(body).length > 0 &&.includes(method)) {
                    requestOptions.body = JSON.stringify(body);
                }
                const apiResponse = await fetch(url, requestOptions);
                const responseText = await apiResponse.text();
                let responseData;
                try {
                    responseData = JSON.parse(responseText);
                } catch (e) {
                    responseData = responseText;
                }
                return { status: apiResponse.status, data: responseData };
            } catch (error) {
                return { status: 500, data: { message: error.message } };
            }
        }, targetUrl, method, body, xsrfToken); // Pass the token here

        console.log(`Relay successful with status: ${response.status}`);
        return response;

    } catch (error) {
        console.error('An error occurred during the Puppeteer relay operation:', error);
        return { status: 502, data: { error: true, message: `Proxy error: ${error.message}` } };
    } finally {
        if (browser) await browser.close();
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
