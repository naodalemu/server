import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import cors from 'cors';

// Initialize cors middleware.
const corsMiddleware = cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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

async function relayRequestWithPuppeteer(path, method, body, headers) {
    console.log(`Relaying request: ${method} to /api/${path}`);
    let browser = null;
    try {
        // Explicitly provide the executablePath to fix the error.
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

        // Give the page up to 60 seconds to load to prevent timeouts
        await page.goto(baseApiUrl, { waitUntil: 'networkidle0', timeout: 15000 });

        console.log('Security challenge passed, cookie should be set.');

        if (['PUT', 'PATCH'].includes(method)) {
            console.log(`Spoofing ${method} request as POST.`);
            body._method = method;
            method = 'POST';
        }

        const targetUrl = `${baseApiUrl}/api/${path}`;
        const response = await page.evaluate(async (url, method, body, authorizationHeader) => {
            try {
                const requestOptions = {
                    method: method,
                    headers: { 
                        'Content-Type': 'application/json', 
                        'Accept': 'application/json' 
                    }
                };

                if (authorizationHeader) {
                    requestOptions.headers['Authorization'] = authorizationHeader;
                }

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
        }, targetUrl, method, body, headers.authorization);

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

    const result = await relayRequestWithPuppeteer(path, req.method, body, req.headers);

    res.status(result.status).json(result.data);
}
