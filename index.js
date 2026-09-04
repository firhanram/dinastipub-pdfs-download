const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

loadEnvFile();

const DEFAULT_ISSUE_URL = "https://dinastipub.org/DIJEMSS/issue/view/138";
const ISSUE_URLS = getIssueUrls();
const DOWNLOAD_DIR = expandHomeDir(
	process.env.DOWNLOAD_DIR || path.join(os.homedir(), "Downloads"),
);
const HEADLESS = process.env.HEADLESS !== "false";

function loadEnvFile() {
	const envPath = path.join(__dirname, ".env");

	if (!fs.existsSync(envPath)) {
		return;
	}

	const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

	for (const line of lines) {
		const trimmedLine = line.trim();

		if (!trimmedLine || trimmedLine.startsWith("#")) {
			continue;
		}

		const separatorIndex = trimmedLine.indexOf("=");

		if (separatorIndex === -1) {
			continue;
		}

		const key = trimmedLine.slice(0, separatorIndex).trim();
		const rawValue = trimmedLine.slice(separatorIndex + 1).trim();
		const value = rawValue.replace(/^("|')|("|')$/g, "");

		if (key && process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}

function getIssueUrls() {
	const cliIssueUrls = process.argv.slice(2);
	const envIssueUrls = splitIssueUrls(process.env.ISSUE_URLS);
	const legacyIssueUrls = splitIssueUrls(process.env.ISSUE_URL);
	const issueUrls = [...cliIssueUrls, ...envIssueUrls, ...legacyIssueUrls]
		.map((url) => url.trim())
		.filter(Boolean);

	return [...new Set(issueUrls.length > 0 ? issueUrls : [DEFAULT_ISSUE_URL])];
}

function splitIssueUrls(value) {
	if (!value) {
		return [];
	}

	return value.split(/[\n,]+/);
}

function expandHomeDir(value) {
	if (value === "~") {
		return os.homedir();
	}

	if (value.startsWith("~/")) {
		return path.join(os.homedir(), value.slice(2));
	}

	return value;
}

function sanitizeFilename(value) {
	return value
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 180);
}

function uniqueFilename(filename, usedFilenames) {
	const parsed = path.parse(filename);
	let candidate = filename;
	let counter = 1;

	while (usedFilenames.has(candidate)) {
		candidate = `${parsed.name}-${counter}${parsed.ext}`;
		counter += 1;
	}

	usedFilenames.add(candidate);
	return candidate;
}

async function collectPdfLinks(page, issueUrl) {
	await page.goto(issueUrl, { waitUntil: "domcontentloaded" });
	await page.waitForSelector("a.obj_galley_link.pdf", { timeout: 30_000 });

	return page.$$eval(
		"a.obj_galley_link.pdf",
		(links, currentIssueUrl) =>
			links.map((link, index) => {
				const article = link.closest(".obj_article_summary, li, article");
				const title =
					article
						?.querySelector('.title, h2, h3, h4, a[id^="article-"]')
						?.textContent?.trim() ||
					link.getAttribute("aria-labelledby") ||
					`article-${index + 1}`;

				return {
					issueUrl: currentIssueUrl,
					title,
					url: link.href,
				};
			}),
		issueUrl,
	);
}

async function downloadPdf(page, pdfLink, usedFilenames) {
	console.log(`Opening: ${pdfLink.title}`);

	await page.goto(pdfLink.url, { waitUntil: "domcontentloaded" });
	await page.waitForSelector("a.download", { timeout: 30_000 });

	const downloadPromise = page.waitForEvent("download");
	await page.click("a.download");

	const download = await downloadPromise;
	const suggestedFilename = download.suggestedFilename();
	const fallbackFilename = `${sanitizeFilename(pdfLink.title) || "article"}.pdf`;
	const filename = uniqueFilename(
		suggestedFilename || fallbackFilename,
		usedFilenames,
	);
	const targetPath = path.join(DOWNLOAD_DIR, filename);

	await download.saveAs(targetPath);
	console.log(`Downloaded: ${targetPath}`);
}

async function main() {
	fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

	const browser = await chromium.launch({ headless: HEADLESS });
	const context = await browser.newContext({ acceptDownloads: true });
	const page = await context.newPage();

	try {
		const usedFilenames = new Set();
		let totalPdfLinks = 0;

		console.log(`Processing ${ISSUE_URLS.length} issue URL(s).`);

		for (const issueUrl of ISSUE_URLS) {
			try {
				console.log(`Collecting PDFs from: ${issueUrl}`);
				const pdfLinks = await collectPdfLinks(page, issueUrl);
				totalPdfLinks += pdfLinks.length;

				if (pdfLinks.length === 0) {
					console.log(`No PDF links found from: ${issueUrl}`);
					continue;
				}

				console.log(`Found ${pdfLinks.length} PDF links from: ${issueUrl}`);

				for (const pdfLink of pdfLinks) {
					try {
						await downloadPdf(page, pdfLink, usedFilenames);
					} catch (error) {
						console.error(
							`Failed to download "${pdfLink.title}" from ${pdfLink.url}`,
						);
						console.error(error);
					}
				}
			} catch (error) {
				console.error(`Failed to process issue URL: ${issueUrl}`);
				console.error(error);
			}
		}

		console.log(`Finished. Found ${totalPdfLinks} PDF link(s) total.`);
	} finally {
		await browser.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
