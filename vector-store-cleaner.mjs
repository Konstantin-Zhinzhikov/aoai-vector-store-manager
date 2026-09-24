import readline from 'node:readline/promises';
import {stdin as input, stdout as output} from 'node:process';
import {mkdir, appendFile} from 'node:fs/promises';
import {join} from 'node:path';

const API_PREFIX = '/openai/v1';
const PAGE_SIZE = 100;
const REQUEST_RETRIES = 5;
const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);
let rl = readline.createInterface({input, output});
let logPath;

const ask = async (question) => (await rl.question(question)).trim();

async function askSecret(question) {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
        return ask(question);
    }
    rl.close();
    output.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return new Promise((resolve, reject) => {
        let value = '';
        const finish = () => {
            process.stdin.setRawMode(false);
            process.stdin.removeListener('data', onData);
            rl = readline.createInterface({input, output});
        };
        const onData = (chunk) => {
            const key = chunk.toString('utf8');
            if (key === '\r' || key === '\n') {
                finish();
                output.write('\n');
                resolve(value.trim());
            } else if (key === '\u0003') {
                finish();
                reject(new Error('Input interrupted.'));
            } else if (key === '\b' || key === '\u007f') {
                value = value.slice(0, -1);
            } else {
                value += key;
            }
        };
        process.stdin.on('data', onData);
    });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    return appendFile(logPath, `${line}\n`);
}

async function request(endpoint, apiKey, path, options = {}) {
    const method = options.method ?? 'GET';
    for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
        const startedAt = Date.now();
        let response;
        try {
            response = await fetch(new URL(`${API_PREFIX}${path}`, endpoint), {
                ...options,
                headers: {'api-key': apiKey, 'Content-Type': 'application/json', ...(options.headers ?? {})},
            });
        } catch (error) {
            await log(`HTTP ${method} ${path} attempt=${attempt + 1}/${REQUEST_RETRIES + 1} network_error="${error.message}" duration_ms=${Date.now() - startedAt}`);
            if (attempt === REQUEST_RETRIES) throw error;
            await log(`HTTP_RETRY ${method} ${path} next_attempt=${attempt + 2}`);
            await sleep(500 * 2 ** attempt);
            continue;
        }
        let body = {};
        try { body = await response.json(); } catch { /* empty response */ }
        await log(`HTTP ${method} ${path} attempt=${attempt + 1}/${REQUEST_RETRIES + 1} status=${response.status} duration_ms=${Date.now() - startedAt}`);
        if (response.ok) return body;
        const error = new Error(`${method} ${path} failed (${response.status}): ${body?.error?.message ?? response.statusText}`);
        error.status = response.status;
        if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === REQUEST_RETRIES) throw error;
        await log(`HTTP_RETRY ${method} ${path} next_attempt=${attempt + 2}`);
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt);
    }
}

async function listFiles(endpoint, apiKey, vectorStoreId) {
    const files = [];
    let after = null;
    do {
        const query = new URLSearchParams({limit: String(PAGE_SIZE)});
        if (after) query.set('after', after);
        const page = await request(endpoint, apiKey, `/vector_stores/${vectorStoreId}/files?${query}`);
        files.push(...(Array.isArray(page.data) ? page.data : []));
        after = page.has_more ? page.last_id : null;
    } while (after);
    return files;
}

async function main() {
    console.log('Azure OpenAI Vector Store cleaner\n');
    const endpoint = (await ask(`Azure OpenAI endpoint [${process.env.AZURE_OPENAI_ENDPOINT ?? ''}]: `)) || process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = await askSecret('Azure token/API key: ');
    const vectorStoreId = await ask('Vector store ID to clean: ');
    const deleteFiles = (await ask('Permanently delete underlying Azure files? Type YES to enable, otherwise they will be preserved: ')).toUpperCase() === 'YES';
    if (!endpoint || !apiKey || !vectorStoreId) throw new Error('Endpoint, token, and vector store ID are required.');
    const parsedEndpoint = new URL(endpoint);
    if (parsedEndpoint.protocol !== 'https:') throw new Error('Azure endpoint must use HTTPS.');
    await mkdir(join(process.cwd(), 'logs'), {recursive: true});
    const stamp = new Date().toISOString().replaceAll(':', '-');
    logPath = join(process.cwd(), 'logs', `clean-${stamp}.log`);
    const reportPath = join(process.cwd(), 'logs', `clean-report-${stamp}.txt`);
    await log(`START vector_store=${vectorStoreId} delete_files=${deleteFiles}`);
    const files = await listFiles(endpoint, apiKey, vectorStoreId);
    const report = [
        '======================================================================',
        'Azure OpenAI Vector Store cleanup report',
        `Generated: ${new Date().toISOString()}`,
        `Vector store: ${vectorStoreId}`,
        `Mode: ${deleteFiles ? 'unattach and permanently delete files' : 'unattach only; preserve files'}`,
        '======================================================================',
        '',
        `Files found: ${files.length}`,
        '',
        'FILES',
        '-----',
        ...files.map((file, index) => `${String(index + 1).padStart(4, ' ')}. ${file.id}  status=${file.status ?? 'unknown'}`),
        '',
        'No DELETE request has been sent yet.',
    ];
    await appendFile(reportPath, `${report.join('\n')}\n`);
    console.log(`\nDRY RUN: ${files.length} file(s) will be removed from vector store ${vectorStoreId}.`);
    if (deleteFiles) console.log('The underlying Azure files will also be permanently deleted.');
    console.log('\nCleanup summary:');
    console.log(`  Vector store: ${vectorStoreId}`);
    console.log(`  Files to detach: ${files.length}`);
    console.log(`  Permanently delete Azure files: ${deleteFiles ? 'YES' : 'NO'}`);
    console.log(`Report: ${reportPath}`);
    const requiredConfirmation = deleteFiles ? 'DELETE FILES' : 'YES';
    const confirmation = (await ask(`Review the report. Start cleanup? Type ${requiredConfirmation}: `)).toUpperCase();
    if (confirmation !== requiredConfirmation) {
        await log('ABORTED after dry-run');
        console.log('Cleanup cancelled.');
        return;
    }
    let detached = 0;
    let deleted = 0;
    let alreadyAbsent = 0;
    let failed = 0;
    for (const [index, file] of files.entries()) {
        console.log(`\n[${index + 1}/${files.length}] ${file.id}`);
        try {
            await request(endpoint, apiKey, `/vector_stores/${vectorStoreId}/files/${file.id}`, {method: 'DELETE'});
            detached++;
            await log(`DETACHED file=${file.id} vector_store=${vectorStoreId}`);
            console.log('  Unattach: OK');
            if (deleteFiles) {
                try {
                    await request(endpoint, apiKey, `/files/${file.id}`, {method: 'DELETE'});
                    deleted++;
                    await log(`DELETED file=${file.id} permanently=true`);
                    console.log('  Delete Azure file: OK');
                } catch (error) {
                    if (error.status !== 404) throw error;
                    alreadyAbsent++;
                    await log(`ALREADY_ABSENT file=${file.id} permanently=true`);
                    console.log('  Delete Azure file: already absent');
                }
            }
        } catch (error) {
            failed++;
            await log(`ERROR file=${file.id}: ${error.message}`);
            console.log(`  FAILED: ${error.message}`);
        }
    }
    await log(`FINISHED detached=${detached} deleted=${deleted} failed=${failed}`);
    await appendFile(reportPath, `\nEXECUTION RESULT\n----------------\nDetached: ${detached}\nPermanently deleted: ${deleted}\nAlready absent: ${alreadyAbsent}\nFailed: ${failed}\nResult: ${failed ? 'FAILED' : 'SUCCESS'}\n`);
    console.log(`\nOperational log: ${logPath}`);
    console.log(`Report: ${reportPath}`);
    if (failed) process.exitCode = 1;
}

try {
    await main();
} catch (error) {
    console.error(`\nFatal error: ${error.message}`);
    if (logPath) await log(`FATAL_ERROR ${error.message}`);
    process.exitCode = 1;
} finally {
    rl.close();
}
