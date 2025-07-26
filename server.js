// server.js

// Import necessary libraries
const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
// 1. Enable CORS to allow requests from your frontend.
app.use(cors());
// 2. Enable Express to parse JSON request bodies.
app.use(express.json());

// The base URL of your API hosted on InfinityFree
const baseApiUrl = 'https://ssr-system.ct.ws';

/**
 * Dynamically relays an API request using Puppeteer to bypass browser checks.
 * @param {string} path - The API endpoint path (e.g., 'menuitems', 'users/1').
 * @param {string} method - The HTTP method (GET, POST, PUT, DELETE).
 * @param {object} body - The JSON request body for POST/PUT requests.
 * @returns {object} An object containing the status and data from the target API.
 */
async function relayRequestWithPuppeteer(path, method, body) {
    console.log(`Relaying request: ${method} to /api/${path}`);
    let browser = null;
    try {
        // Launch a headless browser.
        // The --no-sandbox argument is often needed on hosting platforms.
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        
        const page = await browser.newPage();

        // STEP 1: Navigate to a simple page on the target domain.
        // This action triggers and solves the JavaScript security challenge,
        // which sets a necessary cookie in the browser instance for subsequent requests.
        console.log('Navigating to base URL to solve security challenge...');
        await page.goto(baseApiUrl, { waitUntil: 'networkidle0' });
        console.log('Security challenge passed, cookie should be set.');

        // STEP 2: With the security cookie now present in the browser,
        // execute the *actual* API request from within the browser's context using fetch().
        // This makes the request appear legitimate to the server.
        const targetUrl = `${baseApiUrl}/api/${path}`;
        
        const response = await page.evaluate(async (url, method, body) => {
            // This block of code runs INSIDE the Puppeteer-controlled browser
            try {
                const requestOptions = {
                    method: method,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    }
                };

                // Only attach a body for relevant methods if a body exists
                if (body && Object.keys(body).length > 0 && ['POST', 'PUT', 'PATCH'].includes(method)) {
                    requestOptions.body = JSON.stringify(body);
                }

                const apiResponse = await fetch(url, requestOptions);
                const responseText = await apiResponse.text();
                
                let responseData;
                try {
                    // Assume the response is JSON, try to parse it
                    responseData = JSON.parse(responseText);
                } catch (e) {
                    // If parsing fails, the response was likely plain text or HTML
                    responseData = responseText;
                }

                return {
                    status: apiResponse.status,
                    data: responseData
                };
            } catch (error) {
                return { status: 500, data: { message: error.message } };
            }
        }, targetUrl, method, body);

        console.log(`Relay successful with status: ${response.status}`);
        return response;

    } catch (error) {
        console.error('An error occurred during the Puppeteer relay operation:', error);
        return { status: 502, data: { error: true, message: `Proxy error: ${error.message}` } }; // 502 Bad Gateway
    } finally {
        if (browser) {
            await browser.close();
            console.log('Puppeteer browser closed.');
        }
    }
}

// --- Dynamic Catch-All API Route ---
// This route will catch any request made to /api/...
app.all('/api/*', async (req, res) => {
    // Extract the dynamic path part after '/api/'
    // For a request to '/api/users/1', req.params[0] will be 'users/1'
    const path = req.params[0];
    
    const result = await relayRequestWithPuppeteer(path, req.method, req.body);
    
    // Forward the status and JSON data from the relayed request back to the original client
    res.status(result.status).json(result.data);
});

// Start the Express server
app.listen(PORT, () => {
    console.log(`Dynamic API proxy server is running on http://localhost:${PORT}`);
});
