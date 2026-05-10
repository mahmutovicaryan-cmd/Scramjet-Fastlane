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

function setError(message, code) {
	error.textContent = message || "";
	errorCode.textContent = code || "";
}

function setLoading(isLoading, title, sub) {
	clearTimeout(loadingMinTimer);
	document.body.classList.toggle("loading", isLoading);
	if (title) loadingTitle.textContent = title;
	if (sub) loadingSub.textContent = sub;
}

function finishLoadingSoon() {
	clearTimeout(loadingMinTimer);
	loadingMinTimer = setTimeout(() => {
		document.body.classList.remove("loading");
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

	setError("", "");
	setLoading(true, "Opening page", value);
	goBtn.disabled = true;
	goBtn.textContent = "Opening";
	address.value = value;

	try {
		await prepareProxy();
		const url = search(value, searchEngine.value);

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
		document.body.classList.remove("loading");
	} finally {
		goBtn.disabled = false;
		goBtn.textContent = "Go";
	}
}

form.addEventListener("submit", (event) => {
	event.preventDefault();
	openQuery(address.value);
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
	document.body.classList.remove("loading");
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
