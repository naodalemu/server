// api/index.js

const puppeteer = require('puppeteer-core');
// Using the "-min" version is often more stable on Vercel
const chromium = require('@sparticuz/chromium-min');

async function relayRequestWithPuppeteer(path, method, body) {
    console.log(`Relaying request: ${method} to /api/${path}`);
    let browser = null;
    try {
        // The new .puppeteerrc.cjs file handles all the configuration.
        // We can now use a much simpler launch command.
        browser = await puppeteer.launch({
            args: chromium.args,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        const baseApiUrl = 'https://ssr-system.ct.ws';

        console.log('Navigating to base URL to solve security challenge...');
        await page.goto(baseApiUrl, { waitUntil: 'networkidle0' });
        console.log('Security challenge passed, cookie should be set.');

        if (method === 'POST') {
            console.log('POST request detected. Attempting to fetch CSRF token...');
            const csrfToken = await page.evaluate(() => {
                const metaToken = document.querySelector('meta[name="csrf-token"]');
                if (metaToken) return metaToken.getAttribute('content');
                const inputToken = document.querySelector('input[name="_token"]');
                if (inputToken) return inputToken.value;
                return null;
            });
            if (csrfToken) {
                console.log('CSRF Token found:', csrfToken);
                body._token = csrfToken;
            } else {
                console.log('WARNING: No CSRF token found on the page.');
            }
        }

        const targetUrl = `${baseApiUrl}/api/${path}`;
        const response = await page.evaluate(async (url, method, body) => {
            try {
                const requestOptions = {
                    method: method,
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
                };
                if (body && Object.keys(body).length > 0 && ['POST', 'PUT', 'PATCH'].includes(method)) {
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
        }, targetUrl, method, body);

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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const path = req.url.substring(1);
    const body = req.body;

    const result = await relayRequestWithPuppeteer(path, req.method, body);

    res.status(result.status).json(result.data);
}
