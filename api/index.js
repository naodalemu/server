// api/index.js

// Import necessary libraries
const express = require('express');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const cors = require('cors');

const app = express();

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
        // --- FIX: Forcing a specific, compatible Chromium revision for Vercel ---
        browser = await puppeteer.launch({
            args: chromium.args,
            executablePath: await chromium.executablePath({ revision: '119.0.2' }),
            headless: chromium.headless,
        });
        
        const page = await browser.newPage();

        // STEP 1: Navigate to the base URL to solve the security challenge.
        // This single navigation is now used to get the CSRF token for all POST requests.
        console.log('Navigating to base URL to solve security challenge...');
        await page.goto(baseApiUrl, { waitUntil: 'networkidle0' });
        console.log('Security challenge passed, cookie should be set.');

        // --- IMPROVED CSRF TOKEN HANDLING FOR POST REQUESTS ---
        if (method === 'POST') {
            console.log('POST request detected. Attempting to fetch CSRF token from the page...');
            
            // The page is already loaded from Step 1. We now scrape the token from it.
            const csrfToken = await page.evaluate(() => {
                // Strategy 1: Look for the CSRF token in a meta tag (standard Laravel practice).
                const metaToken = document.querySelector('meta[name="csrf-token"]');
                if (metaToken) {
                    return metaToken.getAttribute('content');
                }

                // Strategy 2: Fallback to looking for a hidden input field (for login forms, etc.).
                const inputToken = document.querySelector('input[name="_token"]');
                if (inputToken) {
                    return inputToken.value;
                }

                return null; // Return null if no token is found
            });

            if (csrfToken) {
                console.log('CSRF Token found:', csrfToken);
                // Add the token to the body of the request
                body._token = csrfToken;
            } else {
                // This is a critical warning. If no token is found, the request will likely fail.
                console.log('CRITICAL WARNING: No CSRF token found on the page. The POST request will likely be rejected.');
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
// Changed from /api/* to /* to work correctly with Vercel's rewrites.
app.all('/*', async (req, res) => {
    // Vercel gives us the path directly on req.url
    const path = req.url.substring(1); // Remove the leading '/'
    const result = await relayRequestWithPuppeteer(path, req.method, req.body);
    res.status(result.status).json(result.data);
});

// Export the app for Vercel's serverless environment
module.exports = app;
