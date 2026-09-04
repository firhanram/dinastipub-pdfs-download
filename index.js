const path = require("node:path");
const { chromium } = require("playwright");

const ISSUE_URL =
	process.env.ISSUE_URL || "https://dinastipub.org/DIJEMSS/issue/view/138";
const DOWNLOAD_DIR =
	process.env.DOWNLOAD_DIR || path.join(__dirname, "downloads");
const HEADLESS = process.env.HEADLESS !== "false";

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

async function collectPdfLinks(page) {
	await page.goto(ISSUE_URL, { waitUntil: "domcontentloaded" });
	await page.waitForSelector("a.obj_galley_link.pdf", { timeout: 30_000 });

	return page.$$eval("a.obj_galley_link.pdf", (links) =>
		links.map((link, index) => {
			const article = link.closest(".obj_article_summary, li, article");
			const title =
				article
					?.querySelector('.title, h2, h3, h4, a[id^="article-"]')
					?.textContent?.trim() ||
				link.getAttribute("aria-labelledby") ||
				`article-${index + 1}`;

			return {
				title,
				url: link.href,
			};
		}),
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
	const browser = await chromium.launch({ headless: HEADLESS });
	const context = await browser.newContext({ acceptDownloads: true });
	const page = await context.newPage();

	try {
		const pdfLinks = await collectPdfLinks(page);

		if (pdfLinks.length === 0) {
			console.log("No PDF links found.");
			return;
		}

		console.log(`Found ${pdfLinks.length} PDF links.`);

		const usedFilenames = new Set();

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
	} finally {
		await browser.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
