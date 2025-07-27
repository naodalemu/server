// api/index.js

// Import necessary libraries
// Note: We are no longer using the 'express' library
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

// --- Main Puppeteer Logic (this function is unchanged) ---
async function relayRequestWithPuppeteer(path, method, body) {
    console.log(`Relaying request: ${method} to /api/${path}`);
    let browser = null;
    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            executablePath: await chromium.executablePath({ revision: '119.0.2' }),
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
                console.log('CRITICAL WARNING: No CSRF token found on the page.');
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

// --- Vercel Serverless Function Handler ---
// This is the main entry point for all requests.
export default async function handler(req, res) {
    // Manually set CORS headers to allow requests from your frontend
    res.setHeader('Access-Control-Allow-Origin', '*'); // Or your specific frontend domain
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight requests for CORS
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // Vercel's rewrite gives us the path like '/menuitems'. We remove the leading '/'.
    const path = req.url.substring(1);
    
    // Vercel automatically parses the JSON body for us
    const body = req.body;
    
    // Call our main logic function
    const result = await relayRequestWithPuppeteer(path, req.method, body);
    
    // Send the response back to the client
    res.status(result.status).json(result.data);
}
