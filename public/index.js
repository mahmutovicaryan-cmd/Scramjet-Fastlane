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
const debugToggle = document.getElementById("debug-toggle");
const debugPanel = document.getElementById("debug-panel");
const debugLogEl = document.getElementById("debug-log");
const debugCopy = document.getElementById("debug-copy");
const debugReset = document.getElementById("debug-reset");
const debugClose = document.getElementById("debug-close");

let scramjet = null;
let connection = null;
let browserFrame = null;
let loadingMinTimer = null;
let loadingStatusTimer = null;
let navigationWatchdog = null;
let autoOpenStarted = false;
const loadedScripts = new Map();
const debugLines = [];

function diag(message, data) {
	const line = `[${new Date().toLocaleTimeString()}] ${message}` +
		(data === undefined ? "" : ` ${safeJson(data)}`);
	debugLines.push(line);
	if (debugLines.length > 260) debugLines.shift();
	if (debugLogEl) {
		debugLogEl.textContent = debugLines.join("\n");
		debugLogEl.scrollTop = debugLogEl.scrollHeight;
	}
}

function safeJson(value) {
	try {
		return JSON.stringify(value);
	} catch (_err) {
		return String(value);
	}
}

function globalSnapshot() {
	return {
		hasBareMux: !!globalThis.BareMux,
		bareMuxKeys: globalThis.BareMux ? Object.keys(globalThis.BareMux).slice(0, 12) : [],
		hasExports: !!globalThis.exports,
		exportsKeys: globalThis.exports ? Object.keys(globalThis.exports).slice(0, 12) : [],
		hasModuleExports: !!globalThis.module?.exports,
		moduleKeys: globalThis.module?.exports ? Object.keys(globalThis.module.exports).slice(0, 12) : [],
		hasController: typeof globalThis.$scramjetLoadController === "function",
		hasSharedWorker: typeof globalThis.SharedWorker === "function",
		hasServiceWorker: !!navigator.serviceWorker,
	};
}

diag("boot", {
	href: location.href,
	userAgent: navigator.userAgent,
	online: navigator.onLine,
	crossOriginIsolated: window.crossOriginIsolated,
});

window.addEventListener("error", (event) => {
	diag("window error", {
		message: event.message,
		source: event.filename,
		line: event.lineno,
		column: event.colno,
	});
});

window.addEventListener("unhandledrejection", (event) => {
	diag("unhandled rejection", {
		reason: event.reason?.stack || event.reason?.message || String(event.reason),
	});
});

function setError(message, code) {
	error.textContent = message || "";
	errorCode.textContent = code || "";
	if (message || code) diag("visible error", { message, code });
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

async function inspectScript(src) {
	try {
		const res = await fetch(src, { cache: "no-store" });
		const text = await res.clone().text();
		diag("script fetch", {
			src,
			status: res.status,
			ok: res.ok,
			type: res.headers.get("content-type"),
			bytes: text.length,
			first: text.slice(0, 90),
		});
		return { ok: res.ok, text };
	} catch (err) {
		diag("script fetch failed", { src, error: err.message || String(err) });
		return { ok: false, text: "" };
	}
}

function loadScriptOnce(src, globalTest) {
	if (globalTest()) {
		diag("script already initialized", { src, globals: globalSnapshot() });
		return Promise.resolve();
	}
	if (loadedScripts.has(src)) return loadedScripts.get(src);

	const promise = inspectScript(src).then(() => new Promise((resolve, reject) => {
		document.querySelectorAll(`script[src="${src}"]`).forEach(script => script.remove());

		const script = document.createElement("script");
		script.src = src;
		script.async = false;
		script.onload = () => {
			const initialized = globalTest();
			diag("script onload", { src, initialized, globals: globalSnapshot() });
			initialized ? resolve() : reject(new Error(`${src} did not initialize`));
		};
		script.onerror = () => {
			diag("script onerror", { src, globals: globalSnapshot() });
			reject(new Error(`Could not load ${src}`));
		};
		document.head.appendChild(script);
	})).catch((err) => {
		loadedScripts.delete(src);
		diag("script failed", { src, error: err.message || String(err), globals: globalSnapshot() });
		throw err;
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

	return loadScriptOnce("/baremux/index.js?v=2.1.9", () => !!getBareMuxApi()?.BareMuxConnection)
		.then(() => {
			const fallbackApi = getBareMuxApi();
			if (fallbackApi?.BareMuxConnection) return fallbackApi;

			throw new Error("BareMux did not expose BareMuxConnection.");
		})
		.catch(async (err) => {
			diag("baremux normal loader failed; trying eval fallback", { error: err.message || String(err) });
			const inspected = await inspectScript("/baremux/index.js?v=2.1.9&fallback=1");
			if (!inspected.ok || !inspected.text) throw err;
			try {
				Function(inspected.text)();
			} catch (evalErr) {
				diag("baremux eval fallback failed", { error: evalErr.message || String(evalErr) });
				throw err;
			}
			const api = getBareMuxApi();
			diag("baremux eval fallback result", { ok: !!api?.BareMuxConnection, globals: globalSnapshot() });
			if (api?.BareMuxConnection) return api;
			throw err;
		});
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
		diag("prepareProxy start", globalSnapshot());
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
		diag("proxy objects ready", globalSnapshot());
	}

	try {
		await withTimeout(registerSW(), 12000, "Browser service worker timed out. Refresh and try again.");
		diag("service worker registered", {
			controller: !!navigator.serviceWorker?.controller,
			ready: !!navigator.serviceWorker?.ready,
		});
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
		diag("setting transport", { wispUrl });
		await withTimeout(
			connection.setTransport("/libcurl/index.mjs", [
				{ websocket: wispUrl },
			]),
			15000,
			"BareMux transport setup timed out.",
		);
	}
	diag("prepareProxy complete", { transport: await connection.getTransport() });
}

async function openQuery(input) {
	const value = String(input || "").trim();
	if (!value) return;

	const url = resolveTargetUrl(value, searchEngine.value);
	diag("open query", { input: value, url });
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
		diag("open query failed", { error: err.stack || err.message || String(err), globals: globalSnapshot() });
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

async function repairBrowserEngine() {
	diag("repair requested");
	setLoading(true, "Repairing browser", "Clearing service worker and proxy startup state.");
	try {
		loadedScripts.clear();
		scramjet = null;
		connection = null;
		if (browserFrame?.frame) browserFrame.frame.remove();
		browserFrame = null;
		delete globalThis.BareMux;
		delete globalThis.exports;
		delete globalThis.module;
		if (navigator.serviceWorker?.getRegistrations) {
			const registrations = await navigator.serviceWorker.getRegistrations();
			diag("service worker registrations", { count: registrations.length });
			await Promise.all(registrations.map(reg => reg.unregister()));
		}
		try {
			localStorage.removeItem("bare-mux-path");
		} catch (_err) {}
		diag("repair complete; reloading");
		location.reload();
	} catch (err) {
		diag("repair failed", { error: err.stack || err.message || String(err) });
		setError("Repair failed.", err.toString());
		document.body.classList.remove("loading", "searching");
	}
}

debugToggle?.addEventListener("click", () => debugPanel.classList.toggle("show"));
debugClose?.addEventListener("click", () => debugPanel.classList.remove("show"));
debugCopy?.addEventListener("click", async () => {
	const text = debugLines.join("\n");
	try {
		await navigator.clipboard.writeText(text);
		diag("diagnostics copied");
	} catch (_err) {
		prompt("Copy diagnostics", text);
	}
});
debugReset?.addEventListener("click", repairBrowserEngine);

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
