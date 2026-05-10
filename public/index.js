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

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
	files: {
		wasm: "/scram/scramjet.wasm.wasm",
		all: "/scram/scramjet.all.js",
		sync: "/scram/scramjet.sync.js",
	},
});

scramjet.init();

const connection = new BareMux.BareMuxConnection("/baremux/worker.js");
let browserFrame = null;
let loadingMinTimer = null;
let loadingStatusTimer = null;
let navigationWatchdog = null;

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

async function prepareProxy() {
	try {
		await registerSW();
	} catch (err) {
		setError("Browser engine failed to start.", err.toString());
		throw err;
	}

	const wispUrl =
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		"/wisp/";

	if ((await connection.getTransport()) !== "/libcurl/index.mjs") {
		await connection.setTransport("/libcurl/index.mjs", [
			{ websocket: wispUrl },
		]);
	}
}

async function openQuery(input) {
	const value = String(input || "").trim();
	if (!value) return;

	const url = search(value, searchEngine.value);
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
