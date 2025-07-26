// server.js

// Import necessary libraries
const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
app.use(express.json());

// The base URL of your API hosted on InfinityFree
const baseApiUrl = 'https://ssr-system.ct.ws';

/**
 * Dynamically relays an API request using Puppeteer to bypass browser checks.
 * This version includes special handling for POST requests to include CSRF tokens.
 * @param {string} path - The API endpoint path (e.g., 'menuitems', 'admin/login').
 * @param {string} method - The HTTP method (GET, POST, PUT, DELETE).
 * @param {object} body - The JSON request body for POST/PUT requests.
 * @returns {object} An object containing the status and data from the target API.
 */
async function relayRequestWithPuppeteer(path, method, body) {
    console.log(`Relaying request: ${method} to /api/${path}`);
    let browser = null;
    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });
        
        const page = await browser.newPage();

        // STEP 1: Navigate to the base URL to solve the security challenge.
        console.log('Navigating to base URL to solve security challenge...');
        await page.goto(baseApiUrl, { waitUntil: 'networkidle0' });
        console.log('Security challenge passed, cookie should be set.');

        // --- NEW CSRF TOKEN HANDLING FOR POST REQUESTS ---
        if (method === 'POST') {
            console.log('POST request detected. Attempting to fetch CSRF token...');
            // Go to the page that contains the form to get a fresh CSRF token.
            // We assume the form is on a page with the same name as the API endpoint.
            // e.g., for a POST to '/api/admin/login', we visit '/admin/login'
            const formPageUrl = `${baseApiUrl}/${path.replace(/^api\//, '')}`;
            await page.goto(formPageUrl, { waitUntil: 'networkidle0' });

            const csrfToken = await page.evaluate(() => {
                const tokenElement = document.querySelector('input[name="_token"]');
                return tokenElement ? tokenElement.value : null;
            });

            if (csrfToken) {
                console.log('CSRF Token found:', csrfToken);
                // Add the token to the body of the request
                body._token = csrfToken;
            } else {
                console.log('Warning: CSRF token input field not found on page.');
            }
        }

        // STEP 2: Execute the actual API request from within the browser's context.
        const targetUrl = `${baseApiUrl}/api/${path}`;
        
        const response = await page.evaluate(async (url, method, body) => {
            try {
                const requestOptions = {
                    method: method,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    }
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

                return {
                    status: apiResponse.status,
                    data: responseData,
                    // Also return headers to check for cookies or redirects if needed later
                    headers: Object.fromEntries(apiResponse.headers.entries())
                };
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
        if (browser) {
            await browser.close();
            console.log('Puppeteer browser closed.');
        }
    }
}

// --- Dynamic Catch-All API Route ---
app.all('/api/*', async (req, res) => {
    const path = req.params[0];
    const result = await relayRequestWithPuppeteer(path, req.method, req.body);
    res.status(result.status).json(result.data);
});

// Start the Express server
app.listen(PORT, () => {
    console.log(`Dynamic API proxy server is running on http://localhost:${PORT}`);
});
