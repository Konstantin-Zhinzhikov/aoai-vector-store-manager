import readline from 'node:readline/promises';
import {stdin as input, stdout as output} from 'node:process';
import {mkdir, appendFile} from 'node:fs/promises';
import {join} from 'node:path';

const API_PREFIX = '/openai/v1';
const PAGE_SIZE = 100;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CONSOLE_FILE_LINES = 200;
const REQUEST_RETRIES = 5;
const RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);
let operationalLogPath = null;

let rl = readline.createInterface({input, output});
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

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function request(endpoint, apiKey, path, options = {}) {
    for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
        const method = options.method ?? 'GET';
        const startedAt = Date.now();
        let response;
        try {
            response = await fetch(new URL(`${API_PREFIX}${path}`, endpoint), {
                ...options,
                headers: {
                    'api-key': apiKey,
                    'Content-Type': 'application/json',
                    ...(options.headers ?? {}),
                },
            });
        } catch (error) {
            if (operationalLogPath) {
                await logLine(operationalLogPath,
                        `HTTP ${method} ${path} attempt=${attempt + 1}/${REQUEST_RETRIES + 1} network_error="${error.message}" duration_ms=${Date.now() - startedAt}`);
            }
            if (attempt === REQUEST_RETRIES) throw error;
            if (operationalLogPath) await logLine(operationalLogPath, `HTTP_RETRY ${method} ${path} next_attempt=${attempt + 2}`);
            await sleep(500 * 2 ** attempt);
            continue;
        }
        let body = {};
        try { body = await response.json(); } catch { /* empty response */ }
        const durationMs = Date.now() - startedAt;
        if (operationalLogPath) {
            await logLine(operationalLogPath,
                    `HTTP ${method} ${path} attempt=${attempt + 1}/${REQUEST_RETRIES + 1} status=${response.status} duration_ms=${durationMs}`);
        }
        if (response.ok) return body;
        const error = new Error(`${method} ${path} failed (${response.status}): ${body?.error?.message ?? response.statusText}`);
        error.status = response.status;
        if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt === REQUEST_RETRIES) throw error;
        const retryAfter = Number(response.headers.get('retry-after'));
        if (operationalLogPath) await logLine(operationalLogPath, `HTTP_RETRY ${method} ${path} next_attempt=${attempt + 2}`);
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt);
    }
}

async function listVectorStoreFiles(endpoint, apiKey, vectorStoreId) {
    const files = [];
    let after = null;
    do {
        const query = new URLSearchParams({limit: String(PAGE_SIZE)});
        if (after) query.set('after', after);
        const page = await request(endpoint, apiKey,
                `/vector_stores/${vectorStoreId}/files?${query}`);
        files.push(...(Array.isArray(page.data) ? page.data : []));
        after = page.has_more ? page.last_id : null;
    } while (after);
    return files;
}

async function getFile(endpoint, apiKey, fileId) {
    return request(endpoint, apiKey, `/files/${fileId}`);
}

function logLine(logPath, message) {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    return appendFile(logPath, `${line}\n`);
}

async function reportLine(reportPath, message = '') {
    await appendFile(reportPath, `${message}\n`);
}

function elapsed(seconds) {
    const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
    const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${minutes}:${remainder}`;
}

async function loadInventory(endpoint, apiKey, sourceIds, destinationId, logPath) {
    const destinationFiles = await listVectorStoreFiles(endpoint, apiKey, destinationId);
    const destinationFileIds = new Set(destinationFiles.map((file) => file.id));
    const candidates = new Map();
    const sourceCounts = new Map();
    const missingFiles = [];

    for (const sourceId of sourceIds) {
        const files = await listVectorStoreFiles(endpoint, apiKey, sourceId);
        sourceCounts.set(sourceId, files.length);
        await logLine(logPath, `SOURCE ${sourceId}: ${files.length} vector-store file(s)`);
        for (const vectorFile of files) {
            if (!vectorFile?.id || candidates.has(vectorFile.id)) continue;
            let metadata;
            try {
                metadata = await getFile(endpoint, apiKey, vectorFile.id);
            } catch (error) {
                if (error.status === 404) {
                    missingFiles.push({fileId: vectorFile.id, sourceId});
                    await logLine(logPath, `SKIP_MISSING file=${vectorFile.id} source=${sourceId}`);
                    continue;
                }
                throw error;
            }
            if (!metadata?.id) {
                missingFiles.push({fileId: vectorFile.id, sourceId});
                await logLine(logPath, `SKIP_MISSING file=${vectorFile.id} source=${sourceId} reason=empty_metadata`);
                continue;
            }
            candidates.set(vectorFile.id, {
                fileId: vectorFile.id,
                filename: metadata.filename ?? '<filename unavailable>',
                sourceId,
                status: vectorFile.status ?? 'unknown',
                alreadyAttached: destinationFileIds.has(vectorFile.id),
            });
        }
    }
    return {destinationFileIds, candidates: [...candidates.values()], sourceCounts, missingFiles};
}

async function printReport(inventory, logPath, reportPath, endpoint, destinationId) {
    const pending = inventory.candidates.filter((file) => !file.alreadyAttached);
    const existing = inventory.candidates.length - pending.length;
    await reportLine(reportPath, '======================================================================');
    await reportLine(reportPath, 'Azure OpenAI Vector Store migration report');
    await reportLine(reportPath, `Generated: ${new Date().toISOString()}`);
    await reportLine(reportPath, `Endpoint: ${endpoint}`);
    await reportLine(reportPath, `Destination: ${destinationId}`);
    await reportLine(reportPath, '======================================================================');
    await reportLine(reportPath);
    await reportLine(reportPath, 'DRY-RUN SUMMARY');
    await reportLine(reportPath, '-------------');
    await reportLine(reportPath, `Unique source files:       ${inventory.candidates.length}`);
    await reportLine(reportPath, `Already in destination:    ${existing}`);
    await reportLine(reportPath, `Missing Azure files:       ${inventory.missingFiles.length}`);
    await reportLine(reportPath, `Files to attach:           ${pending.length}`);
    await reportLine(reportPath);
    await reportLine(reportPath, 'FILES BY SOURCE');
    await reportLine(reportPath, '---------------');
    console.log('\n=== DRY-RUN REPORT ===');
    for (const [sourceId, count] of inventory.sourceCounts) {
        const sourceFiles = inventory.candidates.filter((file) => file.sourceId === sourceId);
        const sourceMissing = inventory.missingFiles.filter((file) => file.sourceId === sourceId).length;
        const sourcePending = sourceFiles.filter((file) => !file.alreadyAttached).length;
        console.log(`\nSource: ${sourceId}`);
        console.log(`  Found: ${count} | Attach: ${sourcePending} | Existing: ${sourceFiles.length - sourcePending} | Missing: ${sourceMissing}`);
        await reportLine(reportPath, `Source: ${sourceId}`);
        await reportLine(reportPath, `  Found: ${count}`);
        await reportLine(reportPath, `  To attach: ${sourcePending}`);
        await reportLine(reportPath, `  Already in destination: ${sourceFiles.length - sourcePending}`);
        await reportLine(reportPath, `  Missing Azure files: ${sourceMissing}`);
        await reportLine(reportPath, '  Files:');
    }
    console.log(`Unique source files: ${inventory.candidates.length}`);
    console.log(`Already in destination: ${existing}`);
    console.log(`Missing Azure files skipped: ${inventory.missingFiles.length}`);
    console.log(`Will attach: ${pending.length}`);
    for (const [index, file] of inventory.candidates.entries()) {
        if (index < MAX_CONSOLE_FILE_LINES) {
            console.log(`  [${file.alreadyAttached ? 'SKIP' : 'ATTACH'}] ${file.filename} (${file.fileId})`);
        }
        await reportLine(reportPath, `    [${file.alreadyAttached ? 'SKIP' : 'ATTACH'}] ${file.filename} (${file.fileId})`);
        await logLine(logPath, `DRY_RUN_FILE action=${file.alreadyAttached ? 'SKIP_ALREADY_ATTACHED' : 'ATTACH'} file=${file.fileId} name="${file.filename}" source=${file.sourceId} source_status=${file.status}`);
    }
    if (inventory.candidates.length > MAX_CONSOLE_FILE_LINES) {
        console.log(`  ... ${inventory.candidates.length - MAX_CONSOLE_FILE_LINES} more file(s) are in the log`);
    }
    for (const file of inventory.missingFiles) {
        await reportLine(reportPath, `    [MISSING] ${file.fileId}`);
        await logLine(logPath, `DRY_RUN_FILE action=SKIP_MISSING file=${file.fileId} source=${file.sourceId}`);
    }
    await reportLine(reportPath);
    await reportLine(reportPath, '======================================================================');
    console.log('======================\n');
}

async function attach(endpoint, apiKey, destinationId, file, logPath) {
    await request(endpoint, apiKey, `/vector_stores/${destinationId}/files`, {
        method: 'POST', body: JSON.stringify({file_id: file.fileId}),
    });
    await logLine(logPath, `ATTACHED file=${file.fileId} name="${file.filename}" destination=${destinationId}`);
    console.log(`  Attach OK: ${file.filename}`);
    process.stdout.write('  Indexing: waiting for Azure\r');
    const startedAt = Date.now();
    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
        const current = await request(endpoint, apiKey,
                `/vector_stores/${destinationId}/files/${file.fileId}`);
        const seconds = (Date.now() - startedAt) / 1000;
        process.stdout.write(`  Indexing: ${current.status ?? 'unknown'} | elapsed ${elapsed(seconds)}\r`);
        if (current.status === 'completed') {
            process.stdout.write(`  Indexing: completed | elapsed ${elapsed(seconds)}\n`);
            await logLine(logPath, `INDEXED file=${file.fileId} status=completed`);
            return;
        }
        if (['failed', 'cancelled'].includes(current.status)) {
            process.stdout.write(`  Indexing: ${current.status} | elapsed ${elapsed(seconds)}\n`);
            throw new Error(`file status=${current.status}`);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    process.stdout.write(`  Indexing: timeout after ${elapsed(POLL_TIMEOUT_MS / 1000)}\n`);
    throw new Error(`indexing timeout after ${POLL_TIMEOUT_MS / 1000}s`);
}

async function main() {
    console.log('Azure OpenAI Vector Store copier\n');
    const endpoint = (await ask(`Azure OpenAI endpoint [${process.env.AZURE_OPENAI_ENDPOINT ?? ''}]: `))
            || process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = await askSecret('Azure token/API key: ');
    const sourceIds = (await ask('Source vector store IDs (comma-separated): '))
            .split(',').map((id) => id.trim()).filter(Boolean);
    const destinationId = await ask('Destination vector store ID: ');
    if (!endpoint || !apiKey || !sourceIds.length || !destinationId) {
        throw new Error('Endpoint, token, at least one source ID, and destination ID are required.');
    }
    const normalizedEndpoint = new URL(endpoint);
    if (normalizedEndpoint.protocol !== 'https:') throw new Error('Azure endpoint must use HTTPS.');
    if (sourceIds.includes(destinationId)) throw new Error('Destination vector store must not be listed among source stores.');
    const logDir = join(process.cwd(), 'logs');
    await mkdir(logDir, {recursive: true});
    const logPath = join(logDir, `copy-${new Date().toISOString().replaceAll(':', '-')}.log`);
    const reportPath = join(logDir, `report-${new Date().toISOString().replaceAll(':', '-')}.txt`);
    operationalLogPath = logPath;
    await logLine(logPath, `START sources=${sourceIds.join(',')} destination=${destinationId}`);
    const uniqueSourceIds = [...new Set(sourceIds)];
    const inventory = await loadInventory(endpoint, apiKey, uniqueSourceIds, destinationId, logPath);
    await printReport(inventory, logPath, reportPath, endpoint, destinationId);
    await logLine(logPath, `DRY_RUN candidates=${inventory.candidates.length} pending=${inventory.candidates.filter((f) => !f.alreadyAttached).length}`);
    const pendingCount = inventory.candidates.filter((file) => !file.alreadyAttached).length;
    const existingCount = inventory.candidates.length - pendingCount;
    console.log('\nCopy summary:');
    console.log(`  Source stores: ${uniqueSourceIds.length}`);
    console.log(`  Destination: ${destinationId}`);
    console.log(`  Files to attach: ${pendingCount}`);
    console.log(`  Already attached: ${existingCount}`);
    console.log(`  Missing Azure files: ${inventory.missingFiles.length}`);
    const confirmation = (await ask('Start real copying? Type YES: ')).toUpperCase();
    if (confirmation !== 'YES') {
        await logLine(logPath, 'ABORTED after dry-run');
        return;
    }
    const freshDestinationIds = new Set((await listVectorStoreFiles(endpoint, apiKey, destinationId)).map((file) => file.id));
    let failedCount = 0;
    let attachedCount = 0;
    for (const file of inventory.candidates.filter((candidate) => !candidate.alreadyAttached)) {
        if (freshDestinationIds.has(file.fileId)) {
            await logLine(logPath, `SKIP_ALREADY_ATTACHED file=${file.fileId} destination=${destinationId}`);
            continue;
        }
        try {
            await attach(endpoint, apiKey, destinationId, file, logPath);
            freshDestinationIds.add(file.fileId);
            attachedCount++;
        } catch (error) {
            failedCount++;
            await logLine(logPath, `ERROR file=${file.fileId} name="${file.filename}": ${error.message}`);
        }
    }
    await logLine(logPath, `FINISHED failed=${failedCount}`);
    await reportLine(reportPath);
    await reportLine(reportPath, 'EXECUTION RESULT');
    await reportLine(reportPath, '----------------');
    await reportLine(reportPath, `Files successfully attached: ${attachedCount}`);
    await reportLine(reportPath, `Files failed:                ${failedCount}`);
    await reportLine(reportPath, `Result:                      ${failedCount === 0 ? 'SUCCESS' : 'FAILED'}`);
    await reportLine(reportPath, '======================================================================');
    if (failedCount > 0) process.exitCode = 1;
    console.log(`\nOperational log: ${logPath}`);
    console.log(`Human-readable report: ${reportPath}`);
}

try {
    await main();
} catch (error) {
    console.error(`\nFatal error: ${error.message}`);
    process.exitCode = 1;
} finally {
    rl.close();
}
