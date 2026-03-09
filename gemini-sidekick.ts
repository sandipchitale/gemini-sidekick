import * as ChromeLauncher from 'chrome-launcher';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { connect, Browser, Page, Target, ElementHandle } from 'puppeteer-core';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const REMOTE_PORT: number = 19222;

async function launchChrome() {
    // 1. Launch Chrome using chrome-launcher
    const userDataDir = path.join(tmpdir(), 'gemini-sidekick-user-data-dir');

    // Ensure the directory exists, otherwise chrome-launcher fails to open log files
    mkdirSync(userDataDir, { recursive: true });

    let chrome = await ChromeLauncher.launch({
      port: REMOTE_PORT,
      startingUrl: 'about:blank',
      userDataDir,
      chromeFlags: [
        '--new-window',
        '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
      ],
    });
}

async function sessionStart(sessionId: string) {
    await launchChrome();
    const REMOTE_DEBUGGING_URL = `http://127.0.0.1:${REMOTE_PORT}`;

    // Connect to the existing instance
    const browser: Browser = await connect({
      browserURL: REMOTE_DEBUGGING_URL,
      defaultViewport: null // Matches the browser's current window size
    });

    await delay(1000);

    const pages = (await browser.pages());    

    // create page for session
    const page: Page = await browser.newPage();

    // Perform an action: Navigate and wait until network is idle
    await page.goto('https://gemini.google.com', { waitUntil: 'networkidle2' });
    await delay(1000);

    // close about:blank page if it exists
    for (const aPage of pages) {
        if (aPage.url() === 'about:blank') {
            await aPage.close({runBeforeUnload: false});
            break;
        }
    }
   
    // Set the window.name property
    await page.evaluate((sessionId) => {
      window.name = sessionId;
    }, sessionId);

    // add code to enable the canvas tool
    try {
        const toolsToggleButton = await page.waitForSelector('toolbox-drawer button:first-of-type', { timeout: 10000 });
        if (toolsToggleButton) {
            await toolsToggleButton.click();
            await delay(1000);
            const canvasButton = await page.waitForSelector('toolbox-drawer-item:nth-of-type(2) button', { timeout: 5000 });
            if (canvasButton) {
                await canvasButton.click();
            }
        }
    } catch (error) {
        console.error('Error enabling canvas tool:', error);
    }

}

async function findPageForSession(sessionId: string): Promise<Page | undefined> {
    const REMOTE_DEBUGGING_URL = `http://127.0.0.1:${REMOTE_PORT}`;

    // Connect to the existing instance
    const browser: Browser = await connect({
      browserURL: REMOTE_DEBUGGING_URL,
      defaultViewport: null // Matches the browser's current window size
    });

    // 1. Get all targets
    const targets: Target[] = browser.targets();

    // 2. Filter for actual pages (tabs/windows)
    const pageTargets = targets.filter(t => t.type() === 'page');

    // 3. Find page for session
    for (const pageTarget of pageTargets) {
        const page = await pageTarget.asPage();
        if (page) {
            const title = await page.title();
            const windowName = await page.evaluate(() => window.name);
            if (windowName === sessionId) {
                return page;
            }
        }
    }

    return undefined;
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];``
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
}

async function readJsonStdin<T>(): Promise<T> {
    const stdin = await readStdin();
    return JSON.parse(stdin);
}

async function safeExecute(fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch (error) {
        console.error('Error executing hook:', error);
        process.exit(1);
    }
}

interface ContentBlock {
    type: string;
    text?: string;
}

interface AssistantEntry {
    type: "assistant";
    message: {
        role: "assistant";
        content: ContentBlock[];
    };
    timestamp: string;
    uuid: string;
}

async function typeMultilineTextInPromptBox(page: Page, promptBox: ElementHandle<Element>, text: string) {
    if (text) {
        await promptBox.click();
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            await promptBox.type(line);
            if (i < lines.length - 1) {
                await page.keyboard.down('Shift');
                await page.keyboard.press('Enter');
                await page.keyboard.up('Shift');
            }
        }
    }
}

await (async () => {
    const json = await readJsonStdin<any>();
    const hookName = json.hook_event_name;

    try {
        switch (hookName) {
            case 'SessionStart':
                {
                    await safeExecute(async () => {
                        const sessionId: string = json.session_id;
                        await sessionStart(sessionId);
                    });
                }
                break;
            case 'BeforeAgent':
                await safeExecute(async () => {
                        const prompt: string = json.prompt;
                        if (prompt && prompt.includes('#prompt-sidekick')) {
                            const sessionId: string = json.session_id;
                            const page = await findPageForSession(sessionId);
                            if (page) {
                                const promptBox = await page.$('rich-textarea');
                                if (promptBox) {
                                    await typeMultilineTextInPromptBox(page, promptBox, `MANDATORY: Use canvas tool to process this prompt: ${prompt}`);
                                    await delay(1000);
                                    await page.keyboard.up('Enter');
                                    await page.keyboard.press('Enter');
                                }
                                process.stdout.write(JSON.stringify({
                                    continue: false,
                                    reason: 'Sent to sidekick. See the processing in browser.'
                                    }));
                                process.exit(0);
                            }
                        }
                    });
                break;
            case 'AfterAgent':
                {
                    await safeExecute(async () => {
                        const prompt: string = json.prompt;
                        if (prompt && prompt.includes('#sidekick')) {
                            const prompt_response = `MANDATORY: Visualize/animate/render the following using Canvas tool as is:\n${json.prompt_response}`;
                            const sessionId: string = json.session_id;
                            const page = await findPageForSession(sessionId);
                            if (page) {
                                const promptBox = await page.$('rich-textarea');
                                if (promptBox) {
                                    // await promptBox.type(prompt_response);
                                    await typeMultilineTextInPromptBox(page, promptBox, prompt_response);
                                    await delay(1000);
                                    // 4. Force a 'KeyUp' event before Enter (Crucial for some React versions)
                                    await page.keyboard.up('Enter');
                                    await page.keyboard.press('Enter');
                                }
                                process.exit(0);
                            }
                        }
                    });
                }
                break;
            case 'SessionEnd':
                break;
            default:
                console.error(`Unknown hook: ${hookName}`);
                process.exit(1);
        }
    } catch (error) {
        console.error('Error executing hook:', error);
        process.exit(1);
    }
    process.exit(0);
})();
