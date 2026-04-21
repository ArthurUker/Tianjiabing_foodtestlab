const fs = require('fs');
const html = fs.readFileSync('test-quick.html', 'utf8');

const testsMatch = html.match(/const tests = (\[[\s\S]*?\]);/);
if (!testsMatch) {
  console.log('Could not find tests array');
  process.exit(1);
}

// Extract the array string. 
// We need to be careful with eval if there are template literals or backticks.
let testsStr = testsMatch[1];
// Minimal cleaning for eval
const tests = eval(testsStr);

const apiUrl = 'http://localhost:3000';
const credentials = { username: 'admin', password: '8888' };
let token = null;

async function runTests() {
    console.log('Starting automated tests...');
    let passed = 0;
    let failed = 0;

    for (const test of tests) {
        process.stdout.write('Testing: ' + test.name + '... ');
        try {
            const endpoint = test.endpoint.startsWith('/') ? test.endpoint : '/' + test.endpoint;
            const url = apiUrl + endpoint;
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = 'Bearer ' + token;
            
            let body = typeof test.payload === 'function' ? test.payload() : test.payload;
            
            // Replace placeholders in body
            if (body) {
                let bodyStr = JSON.stringify(body);
                bodyStr = bodyStr.replace(/\{username\}/g, credentials.username)
                               .replace(/\{password\}/g, credentials.password);
                body = JSON.parse(bodyStr);
            }

            const response = await fetch(url, {
                method: test.method,
                headers: headers,
                body: test.method !== 'GET' ? JSON.stringify(body) : undefined
            });

            let data;
            const text = await response.text();
            try {
                data = JSON.parse(text);
            } catch(e) {
                data = { error: 'Invalid JSON', body: text };
            }

            const isOk = response.status === (test.expectedStatus || 200);
            
            if (isOk) {
                console.log('✅ PASS');
                passed++;
                // Handle token extraction for "用户登录" or similar
                if (data && data.data && data.data.token) {
                    token = data.data.token;
                } else if (data && data.token) {
                    token = data.token;
                }
            } else {
                console.log('❌ FAIL (Status: ' + response.status + ')');
                console.log('   Response:', JSON.stringify(data).substring(0, 200));
                failed++;
            }
        } catch (err) {
            console.log('❌ ERROR: ' + err.message);
            failed++;
        }
    }
    console.log('\n--- Test Summary ---');
    console.log('Total: ' + (passed + failed));
    console.log('Passed: ' + passed);
    console.log('Failed: ' + failed);
}

runTests();
