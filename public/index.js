"use strict";

const form = document.getElementById("sj-form");
const address = document.getElementById("sj-address");
const searchEngine = document.getElementById("sj-search-engine");
const error = document.getElementById("sj-error");
const errorCode = document.getElementById("sj-error-code");
const homeScreen = document.getElementById("home-screen");
const goBtn = document.getElementById("go-btn");
const backBtn = document.getElementById("nav-back");
const homeBtn = document.getElementById("nav-home");
const loadingTitle = document.getElementById("loading-title");
const loadingSub = document.getElementById("loading-sub");

let scramjet = null;
let connection = null;
let browserFrame = null;
let loadingMinTimer = null;
let loadingStatusTimer = null;
let navigationWatchdog = null;
let autoOpenStarted = false;
let bareMuxModulePromise = null;
const loadedScripts = new Map();

function setError(message, code) {
	error.textContent = message || "";
	errorCode.textContent = code || "";
}

function setLoading(isLoading, title, sub) {
	clearTimeout(loadingMinTimer);
	clearTimeout(loadingStatusTimer);
	clearTimeout(navigationWatchdog);
	document.body.classList.toggle("loading", isLoading);
	document.body.classList.toggle("searching", isLoading);
	if (title) loadingTitle.textContent = title;
	if (sub) loadingSub.textContent = sub;
	if (isLoading) {
		loadingStatusTimer = setTimeout(() => {
			loadingTitle.textContent = "Waking proxy";
			loadingSub.textContent =
				"After 15 minutes of inactivity, Render may need about 30 seconds to wake.";
		}, 6500);
		navigationWatchdog = setTimeout(() => {
			loadingTitle.textContent = "Still opening";
			loadingSub.textContent =
				"Some sites block proxies or show captchas. Try a direct URL if this stalls.";
		}, 26000);
	}
}

function finishLoadingSoon() {
	clearTimeout(loadingMinTimer);
	clearTimeout(loadingStatusTimer);
	clearTimeout(navigationWatchdog);
	loadingMinTimer = setTimeout(() => {
		document.body.classList.remove("loading", "searching");
		if (browserFrame?.frame) browserFrame.frame.classList.add("ready");
	}, 420);
}

function loadScriptOnce(src, globalTest) {
	if (globalTest()) return Promise.resolve();
	if (loadedScripts.has(src)) return loadedScripts.get(src);

	const promise = new Promise((resolve, reject) => {
		document.querySelectorAll(`script[src="${src}"]`).forEach(script => script.remove());

		const script = document.createElement("script");
		script.src = src;
		script.async = false;
		script.onload = () => (globalTest() ? resolve() : reject(new Error(`${src} did not initialize`)));
		script.onerror = () => reject(new Error(`Could not load ${src}`));
		document.head.appendChild(script);
	});

	loadedScripts.set(src, promise);
	return promise;
}

function getBareMuxApi() {
	if (globalThis.BareMux?.BareMuxConnection) return globalThis.BareMux;
	if (globalThis.exports?.BareMuxConnection) return globalThis.exports;
	if (globalThis.module?.exports?.BareMuxConnection) return globalThis.module.exports;
	return null;
}

function loadBareMux() {
	const globalApi = getBareMuxApi();
	if (globalApi?.BareMuxConnection) return Promise.resolve(globalApi);
	if (bareMuxModulePromise) return bareMuxModulePromise;

	bareMuxModulePromise = import("/baremux/index.js").then((moduleApi) => {
		if (moduleApi?.BareMuxConnection) return moduleApi;

		const fallbackApi = getBareMuxApi();
		if (fallbackApi?.BareMuxConnection) return fallbackApi;

		throw new Error("BareMux did not expose BareMuxConnection.");
	});

	return bareMuxModulePromise;
}

function withTimeout(task, ms, message) {
	let timer = null;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});

	return Promise.race([task, timeout]).finally(() => clearTimeout(timer));
}

function resolveTargetUrl(input, template) {
	const value = String(input || "").trim();

	try {
		return new URL(value).toString();
	} catch (_err) {}

	try {
		const url = new URL(`https://${value}`);
		if (url.hostname.includes(".")) return url.toString();
	} catch (_err) {}

	return String(template || "https://www.google.com/search?q=%s").replace(
		"%s",
		encodeURIComponent(value),
	);
}

async function prepareProxy() {
	if (!scramjet) {
		await loadScriptOnce("/scram/scramjet.all.js", () => typeof globalThis.$scramjetLoadController === "function");
		const bareMux = await withTimeout(loadBareMux(), 10000, "BareMux startup timed out.");

		if (typeof globalThis.$scramjetLoadController !== "function") {
			throw new Error("Scramjet failed to load. Refresh the browser app and try again.");
		}
		if (!bareMux?.BareMuxConnection) {
			throw new Error("BareMux failed to load. Refresh the browser app and try again.");
		}
		const { ScramjetController } = globalThis.$scramjetLoadController();
		scramjet = new ScramjetController({
			files: {
				wasm: "/scram/scramjet.wasm.wasm",
				all: "/scram/scramjet.all.js",
				sync: "/scram/scramjet.sync.js",
			},
		});
		await withTimeout(scramjet.init(), 12000, "Scramjet startup timed out. Refresh and try again.");
		connection = new bareMux.BareMuxConnection("/baremux/worker.js");
	}

	try {
		await withTimeout(registerSW(), 12000, "Browser service worker timed out. Refresh and try again.");
	} catch (err) {
		setError("Browser engine failed to start.", err.toString());
		throw err;
	}

	const wispUrl =
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		"/wisp/";

	if ((await withTimeout(connection.getTransport(), 10000, "BareMux transport check timed out.")) !== "/libcurl/index.mjs") {
		await withTimeout(
			connection.setTransport("/libcurl/index.mjs", [
				{ websocket: wispUrl },
			]),
			15000,
			"BareMux transport setup timed out.",
		);
	}
}

async function openQuery(input) {
	const value = String(input || "").trim();
	if (!value) return;

	const url = resolveTargetUrl(value, searchEngine.value);
	setError("", "");
	setLoading(true, "Opening page", url);
	goBtn.disabled = true;
	goBtn.textContent = "Opening";
	address.value = value;

	try {
		await prepareProxy();

		if (!browserFrame) {
			browserFrame = scramjet.createFrame();
			browserFrame.frame.id = "sj-frame";
			browserFrame.frame.addEventListener("load", finishLoadingSoon);
			document.body.appendChild(browserFrame.frame);
		}

		browserFrame.frame.classList.remove("ready");
		homeScreen.classList.add("hidden");
		browserFrame.go(url);
	} catch (err) {
		setError("Could not open that page.", err.toString());
		document.body.classList.remove("loading", "searching");
		clearTimeout(loadingStatusTimer);
		clearTimeout(navigationWatchdog);
	} finally {
		goBtn.disabled = false;
		goBtn.textContent = "Go";
	}
}

function submitSearch(event) {
	if (event) event.preventDefault();
	autoOpenStarted = true;
	openQuery(address.value);
}

form.addEventListener("submit", submitSearch);
goBtn.addEventListener("click", submitSearch);
address.addEventListener("keydown", (event) => {
	if (event.key !== "Enter") return;
	event.preventDefault();
	submitSearch(event);
});

document.querySelectorAll("[data-query]").forEach((button) => {
	button.addEventListener("click", () => openQuery(button.dataset.query));
});

backBtn.addEventListener("click", () => {
	try {
		if (browserFrame?.frame?.contentWindow) browserFrame.frame.contentWindow.history.back();
	} catch (_err) {}
});

homeBtn.addEventListener("click", () => {
	if (browserFrame?.frame) browserFrame.frame.remove();
	browserFrame = null;
	address.value = "";
	setError("", "");
	clearTimeout(loadingMinTimer);
	clearTimeout(loadingStatusTimer);
	clearTimeout(navigationWatchdog);
	document.body.classList.remove("loading", "searching");
	homeScreen.classList.remove("hidden");
});

document.querySelectorAll("img").forEach((img) => {
	img.addEventListener("error", () => img.classList.add("broken"));
});

window.addEventListener("message", (event) => {
	const data = event.data || {};
	if (data.type === "flos-browser-search") openQuery(data.query);
	if (data.type === "flos-browser-back") {
		try {
			if (browserFrame?.frame?.contentWindow) browserFrame.frame.contentWindow.history.back();
		} catch (_err) {}
	}
});

window.addEventListener("load", () => {
	if (autoOpenStarted) return;
	autoOpenStarted = true;
	address.value = "google.com";
	setTimeout(() => openQuery("google.com"), 350);
});
