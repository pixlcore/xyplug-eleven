#!/usr/bin/env node

// xyOps ElevenLabs audio plugin
// Provides several ElevenLabs REST tools through a single xyOps Marketplace Plugin.
//
// High-level flow:
// 1. Read one xyOps job JSON envelope from STDIN.
// 2. Inspect params.tool to decide which ElevenLabs endpoint to call.
// 3. Send a direct HTTP request with native Node fetch, with no SDK dependency.
// 4. Save generated audio into the job temp directory, or return transcript data.
// 5. Emit one final XYWP response on STDOUT.

import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const API_BASE = "https://api.elevenlabs.io";

const DEFAULT_TTS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const DEFAULT_TIMEOUT_MS = 240000;

// We only get one final response in XYWP.  This flag protects us from emitting
// two terminal messages if an async helper throws after fail() has already run.
let didExit = false;

// Emit one XYWP-compatible JSON line, optionally as the final response.
function writeJson(payload, exit = false) {
	if (didExit) return;
	const line = `${JSON.stringify(payload)}\n`;
	if (exit) {
		didExit = true;
		process.stdout.write(line, () => process.exit(0));
	}
	else process.stdout.write(line);
}

// Send a terminal xyOps error response, then throw to stop the current flow.
function fail(code, description) {
	writeJson({ xy: 1, code, description }, true);
	const err = new Error(description || String(code));
	err.xyExit = true;
	throw err;
}

// Read the single xyOps job payload from STDIN and parse it as JSON.
async function readJob() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const raw = chunks.join("").trim();
	if (!raw) fail("input", "No JSON input received on STDIN.");

	try {
		return JSON.parse(raw);
	}
	catch (err) {
		fail("input", `Failed to parse JSON input: ${err.message}`);
	}
}

// Convert a possibly blank parameter into a number, preserving a fallback.
function parseNumber(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	const num = Number(value);
	return Number.isFinite(num) ? num : fallback;
}

// Parse optional numeric controls where the xyOps default value 0 means "unset".
function parseOptionalNumber(value) {
	const num = parseNumber(value, undefined);
	return Number.isFinite(num) && num !== 0 ? num : undefined;
}

// Convert a possibly blank parameter into a rounded integer.
function parseInteger(value, fallback) {
	const num = parseNumber(value, fallback);
	return Number.isFinite(num) ? Math.round(num) : fallback;
}

// Parse optional integer controls where the xyOps default value 0 means "unset".
function parseOptionalInteger(value) {
	const num = parseOptionalNumber(value);
	return Number.isFinite(num) ? Math.round(num) : undefined;
}

// Convert xyOps checkbox-ish values into booleans.
function parseBoolean(value, fallback = false) {
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return Boolean(value);
	const text = String(value).trim().toLowerCase();
	if ([ "1", "true", "yes", "y", "on" ].includes(text)) return true;
	if ([ "0", "false", "no", "n", "off" ].includes(text)) return false;
	return fallback;
}

// Parse comma-separated, newline-separated, or array params into a string list.
function parseList(value) {
	if (!value) return [];
	if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
	return String(value)
		.split(/\r?\n|,/)
		.map((item) => item.trim())
		.filter(Boolean);
}

// Clone a JSON object parameter, accepting either parsed JSON or a JSON string.
function cloneJsonObject(value, label = "Custom JSON") {
	if (!value) return {};
	if (typeof value === "string") {
		const raw = value.trim();
		if (!raw) return {};
		try {
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
		}
		catch (err) {
			fail("params", `Failed to parse ${label}: ${err.message}`);
		}
	}
	if (typeof value !== "object" || Array.isArray(value)) return {};
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value));
}

// Normalize file paths so matching works the same on Windows-style and Unix paths.
function normalizePath(value) {
	return String(value || "")
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "");
}

// Convert a simple glob pattern using * and ? into a regular expression.
function globToRegExp(pattern) {
	const normalized = normalizePath(pattern);
	const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const regex = escaped
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${regex}$`, "i");
}

// Check whether an xyOps input filename matches the user's optional pattern.
function matchesFilePattern(filename, pattern) {
	const normalized = normalizePath(filename);
	const raw = normalizePath(pattern || "");
	if (!raw || raw === "*") return true;
	if (normalized === raw || basename(normalized) === raw) return true;
	const regex = globToRegExp(raw);
	return regex.test(normalized) || regex.test(basename(normalized));
}

// Pull the attached input files out of the xyOps job envelope.
function getJobInputFiles(job) {
	const files = Array.isArray(job.input?.files) ? job.input.files : [];
	return files
		.filter((file) => file && file.filename)
		.map((file) => ({
			filename: String(file.filename),
			normalized: normalizePath(file.filename)
		}));
}

// Resolve one input audio file for tools that operate on uploaded job files.
function resolveInputFile(job, params, fieldId = "input_file") {
	const inputFiles = getJobInputFiles(job);
	const pattern = String(params[fieldId] || "").trim();

	if (!inputFiles.length) {
		fail("input", "This tool requires an input audio file, but no job input files were provided.");
	}

	const matches = pattern
		? inputFiles.filter((file) => matchesFilePattern(file.filename, pattern))
		: [ inputFiles[0] ];

	if (!matches.length) {
		fail("input", `No input file matched '${pattern}'.`);
	}

	return matches[0].filename;
}

// Find the ElevenLabs API key from params or assigned xyOps Secret Vault env vars.
function resolveApiKey(params) {
	return String(params.api_key || process.env.ELEVENLABS_API_KEY || "").trim();
}

// Infer a multipart upload content type from a local filename.
function contentTypeFromFilename(filename) {
	const ext = extname(String(filename)).toLowerCase();
	switch (ext) {
		case ".mp3":
			return "audio/mpeg";
		case ".wav":
			return "audio/wav";
		case ".m4a":
			return "audio/mp4";
		case ".aac":
			return "audio/aac";
		case ".flac":
			return "audio/flac";
		case ".ogg":
			return "audio/ogg";
		case ".webm":
			return "audio/webm";
		case ".mp4":
			return "video/mp4";
		case ".mov":
			return "video/quicktime";
		default:
			return "application/octet-stream";
	}
}

// Convert an HTTP response content type into a likely file extension.
function extensionFromContentType(contentType) {
	const type = String(contentType || "").toLowerCase().split(";")[0].trim();
	const map = {
		"audio/mpeg": "mp3",
		"audio/mp3": "mp3",
		"audio/wav": "wav",
		"audio/x-wav": "wav",
		"audio/wave": "wav",
		"audio/flac": "flac",
		"audio/ogg": "ogg",
		"audio/webm": "webm",
		"audio/aac": "aac",
		"audio/mp4": "m4a",
		"audio/pcm": "pcm",
		"application/zip": "zip"
	};
	return map[type] || "";
}

// Convert an ElevenLabs output_format value into a file extension fallback.
function extensionFromOutputFormat(outputFormat) {
	const codec = String(outputFormat || "").toLowerCase().split("_")[0];
	const map = {
		mp3: "mp3",
		wav: "wav",
		pcm: "pcm",
		opus: "opus",
		ulaw: "ulaw",
		alaw: "alaw"
	};
	return map[codec] || "";
}

// Add defined query parameters onto a URL object.
function addQuery(url, query) {
	for (const [key, value] of Object.entries(query || {})) {
		if (value !== undefined && value !== null && value !== "") {
			url.searchParams.set(key, String(value));
		}
	}
	return url;
}

// Append a scalar or JSON object value to a FormData payload.
function appendFormValue(form, key, value) {
	if (value === undefined || value === null || value === "") return;
	if (typeof value === "object") form.append(key, JSON.stringify(value));
	else form.append(key, String(value));
}

// Read a local job input file and append it to a multipart FormData payload.
async function appendFormFile(form, fieldName, filename) {
	let buffer;
	try {
		buffer = await readFile(filename);
	}
	catch (err) {
		fail("input", `Failed to read input file '${filename}': ${err.message}`);
	}

	form.append(
		fieldName,
		new Blob([ buffer ], { type: contentTypeFromFilename(filename) }),
		basename(filename)
	);
}

// Build a readable error message from an unsuccessful ElevenLabs HTTP response.
async function responseToError(response, bodyBuffer, serviceName = "ElevenLabs") {
	const text = Buffer.from(bodyBuffer || []).toString("utf8").trim();
	if (!text) return `${serviceName} API error (${response.status}).`;

	try {
		const payload = JSON.parse(text);
		const detail = payload.detail || payload.message || payload.error || payload.status || text;
		if (typeof detail === "object") return `${serviceName} API error (${response.status}): ${JSON.stringify(detail)}`;
		return `${serviceName} API error (${response.status}): ${detail}`;
	}
	catch {
		return `${serviceName} API error (${response.status}): ${text.slice(0, 500)}`;
	}
}

// Run fetch with a hard timeout and convert network failures into XYWP errors.
async function runFetch(url, options, timeoutMs) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

	try {
		return await fetch(url, {
			...options,
			signal: controller.signal
		});
	}
	catch (err) {
		if (err?.name === "AbortError") fail("timeout", `ElevenLabs request timed out after ${Math.round(timeoutMs / 1000)}s.`);
		fail("network", `Failed to reach ElevenLabs API: ${err.message}`);
	}
	finally {
		clearTimeout(timeout);
	}
}

// Send an ElevenLabs request that is expected to return binary data.
async function requestBinary(path, options) {
	const apiKey = options.apiKey;
	const url = addQuery(new URL(path, API_BASE), options.query);
	const headers = { "xi-api-key": apiKey };
	let body;

	if (options.json) {
		headers["Content-Type"] = "application/json";
		body = JSON.stringify(options.json);
	}
	else if (options.form) {
		// Native fetch adds the multipart boundary for us.  Do not set Content-Type.
		body = options.form;
	}

	const response = await runFetch(url, {
		method: options.method || "POST",
		headers,
		body
	}, options.timeoutMs || DEFAULT_TIMEOUT_MS);

	const bodyBuffer = Buffer.from(await response.arrayBuffer());
	if (!response.ok) {
		fail("elevenlabs", await responseToError(response, bodyBuffer));
	}

	return {
		buffer: bodyBuffer,
		headers: response.headers,
		contentType: response.headers.get("content-type") || ""
	};
}

// Send an ElevenLabs request that is expected to return JSON data.
async function requestJson(path, options) {
	const result = await requestBinary(path, options);
	const text = result.buffer.toString("utf8").trim();
	if (!text) return {};

	try {
		return JSON.parse(text);
	}
	catch (err) {
		fail("elevenlabs", `ElevenLabs returned invalid JSON: ${err.message}`);
	}
}

// Extract useful ElevenLabs response headers for downstream job data.
function responseMetadata(result) {
	return {
		request_id: result.headers.get("request-id") || result.headers.get("x-request-id") || "",
		character_cost: result.headers.get("character-cost") || result.headers.get("x-character-count") || "",
		content_type: result.contentType
	};
}

// Pick a short filename token from the request ID, falling back to timestamp base36.
function filenameTokenFromResponse(result) {
	const requestId = String(result.headers.get("request-id") || result.headers.get("x-request-id") || "").trim();

	// Request IDs are handy in filenames, but only if they are short and boring.
	// Long UUID-like values make ugly filenames, so use a compact timestamp instead.
	if (requestId && requestId.length <= 24 && /^[A-Za-z0-9_-]+$/.test(requestId)) {
		return requestId;
	}

	return Date.now().toString(36);
}

// Write an audio response buffer into the job temp directory and return its filename.
async function writeAudioFile(result, prefix, outputFormat, index = 0) {
	const ext = extensionFromContentType(result.contentType) || extensionFromOutputFormat(outputFormat) || "mp3";
	const token = filenameTokenFromResponse(result);
	const suffix = index > 0 ? `-${index + 1}` : "";
	const filename = `${prefix}-${token}${suffix}.${ext}`;
	await writeFile(filename, result.buffer);
	return filename;
}

// Assemble ElevenLabs voice_settings from individual params plus optional JSON.
function buildVoiceSettings(params) {
	const settings = cloneJsonObject(params.voice_settings, "Voice Settings");

	const stability = parseOptionalNumber(params.stability);
	if (Number.isFinite(stability)) settings.stability = stability;

	const similarityBoost = parseOptionalNumber(params.similarity_boost);
	if (Number.isFinite(similarityBoost)) settings.similarity_boost = similarityBoost;

	const style = parseOptionalNumber(params.style);
	if (Number.isFinite(style)) settings.style = style;

	const speed = parseOptionalNumber(params.speed);
	if (Number.isFinite(speed)) settings.speed = speed;

	if (params.use_speaker_boost !== undefined && params.use_speaker_boost !== "") {
		settings.use_speaker_boost = parseBoolean(params.use_speaker_boost, true);
	}

	return Object.keys(settings).length ? settings : undefined;
}

// Merge the flexible Custom JSON field under the specific tool request body.
function buildCommonJsonBody(params, body) {
	const args = cloneJsonObject(params.args);
	return { ...args, ...body };
}

// Generate speech from text and attach the returned audio file to the job.
async function toolTextToSpeech(job, params, apiKey) {
	const text = String(params.text || params.prompt || "").trim();
	if (!text) fail("params", "Required parameter 'text' was not provided.");

	const voiceId = String(params.voice_id || DEFAULT_TTS_VOICE_ID).trim();
	if (!voiceId) fail("params", "Required parameter 'voice_id' was not provided.");

	const outputFormat = String(params.output_format || DEFAULT_OUTPUT_FORMAT).trim();
	const timeoutMs = parseInteger(params.timeout_ms, DEFAULT_TIMEOUT_MS);
	const seed = parseOptionalInteger(params.seed);
	const voiceSettings = buildVoiceSettings(params);

	const body = buildCommonJsonBody(params, {
		text,
		model_id: String(params.model_id || "eleven_multilingual_v2").trim(),
		language_code: String(params.language_code || "").trim() || undefined,
		voice_settings: voiceSettings,
		seed: Number.isFinite(seed) ? seed : undefined,
		previous_text: String(params.previous_text || "").trim() || undefined,
		next_text: String(params.next_text || "").trim() || undefined,
		apply_text_normalization: String(params.apply_text_normalization || "").trim() || undefined
	});

	writeJson({ xy: 1, progress: 0.1, status: "Generating speech..." });

	const result = await requestBinary(`/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
		apiKey,
		query: { output_format: outputFormat },
		json: body,
		timeoutMs
	});

	const filename = await writeAudioFile(result, "eleven-tts", outputFormat);
	return {
		files: [ filename ],
		data: {
			tool: "text_to_speech",
			voice_id: voiceId,
			model_id: body.model_id,
			output_format: outputFormat,
			...responseMetadata(result)
		}
	};
}

// Generate one or more sound effect files from a prompt.
async function toolSoundEffects(job, params, apiKey) {
	const text = String(params.text || params.prompt || "").trim();
	if (!text) fail("params", "Required parameter 'prompt' was not provided.");

	const outputFormat = String(params.output_format || DEFAULT_OUTPUT_FORMAT).trim();
	const timeoutMs = parseInteger(params.timeout_ms, DEFAULT_TIMEOUT_MS);
	const count = Math.max(1, Math.min(10, parseInteger(params.count, 1)));
	const files = [];
	const results = [];

	for (let idx = 0; idx < count; idx++) {
		writeJson({
			xy: 1,
			progress: Math.min(0.9, 0.05 + (idx / count) * 0.85),
			status: count > 1 ? `Generating sound effect ${idx + 1} of ${count}...` : "Generating sound effect..."
		});

		const body = buildCommonJsonBody(params, {
			text,
			model_id: String(params.model_id || "eleven_text_to_sound_v2").trim(),
			duration_seconds: parseOptionalNumber(params.duration_seconds),
			prompt_influence: parseOptionalNumber(params.prompt_influence),
			loop: parseBoolean(params.loop, false)
		});

		const result = await requestBinary("/v1/sound-generation", {
			apiKey,
			query: { output_format: outputFormat },
			json: body,
			timeoutMs
		});

		files.push(await writeAudioFile(result, "eleven-sfx", outputFormat, idx));
		results.push(responseMetadata(result));
	}

	return {
		files,
		data: {
			tool: "sound_effects",
			model_id: String(params.model_id || "eleven_text_to_sound_v2").trim(),
			count,
			output_format: outputFormat,
			results
		}
	};
}

// Remove background noise from an input audio file and return cleaned audio.
async function toolVoiceIsolator(job, params, apiKey) {
	const inputFile = resolveInputFile(job, params);
	const timeoutMs = parseInteger(params.timeout_ms, DEFAULT_TIMEOUT_MS);
	const form = new FormData();
	await appendFormFile(form, "audio", inputFile);
	appendFormValue(form, "file_format", params.file_format || "other");

	writeJson({ xy: 1, progress: 0.1, status: "Isolating voice..." });

	const result = await requestBinary("/v1/audio-isolation", {
		apiKey,
		form,
		timeoutMs
	});

	const filename = await writeAudioFile(result, "eleven-isolated", "");
	return {
		files: [ filename ],
		data: {
			tool: "voice_isolator",
			input_file: inputFile,
			...responseMetadata(result)
		}
	};
}

// Convert an input speech file into a selected ElevenLabs target voice.
async function toolVoiceChanger(job, params, apiKey) {
	const inputFile = resolveInputFile(job, params);
	const voiceId = String(params.voice_id || DEFAULT_TTS_VOICE_ID).trim();
	if (!voiceId) fail("params", "Required parameter 'voice_id' was not provided.");

	const outputFormat = String(params.output_format || DEFAULT_OUTPUT_FORMAT).trim();
	const timeoutMs = parseInteger(params.timeout_ms, DEFAULT_TIMEOUT_MS);
	const seed = parseOptionalInteger(params.seed);
	const form = new FormData();
	await appendFormFile(form, "audio", inputFile);
	appendFormValue(form, "model_id", params.model_id || "eleven_multilingual_sts_v2");
	appendFormValue(form, "file_format", params.file_format || "other");
	appendFormValue(form, "remove_background_noise", parseBoolean(params.remove_background_noise, false));
	if (Number.isFinite(seed)) appendFormValue(form, "seed", seed);

	const voiceSettings = buildVoiceSettings(params);
	if (voiceSettings) appendFormValue(form, "voice_settings", voiceSettings);

	writeJson({ xy: 1, progress: 0.1, status: "Changing voice..." });

	const result = await requestBinary(`/v1/speech-to-speech/${encodeURIComponent(voiceId)}`, {
		apiKey,
		query: { output_format: outputFormat },
		form,
		timeoutMs
	});

	const filename = await writeAudioFile(result, "eleven-voice-changed", outputFormat);
	return {
		files: [ filename ],
		data: {
			tool: "voice_changer",
			input_file: inputFile,
			voice_id: voiceId,
			model_id: String(params.model_id || "eleven_multilingual_sts_v2").trim(),
			output_format: outputFormat,
			...responseMetadata(result)
		}
	};
}

// Generate music from a prompt or composition plan and attach the audio.
async function toolMusic(job, params, apiKey) {
	const prompt = String(params.prompt || "").trim();
	const compositionPlan = cloneJsonObject(params.composition_plan, "Composition Plan");
	if (!prompt && !Object.keys(compositionPlan).length) {
		fail("params", "Required parameter 'prompt' or 'composition_plan' was not provided.");
	}

	const outputFormat = String(params.output_format || DEFAULT_OUTPUT_FORMAT).trim();
	const timeoutMs = parseInteger(params.timeout_ms, 600000);
	const seed = parseOptionalInteger(params.seed);
	const body = buildCommonJsonBody(params, {
		prompt: prompt || undefined,
		composition_plan: Object.keys(compositionPlan).length ? compositionPlan : undefined,
		music_length_ms: parseInteger(params.music_length_ms, undefined),
		model_id: String(params.model_id || "music_v1").trim(),
		force_instrumental: parseBoolean(params.force_instrumental, false),
		seed: Number.isFinite(seed) ? seed : undefined
	});

	writeJson({ xy: 1, progress: 0.1, status: "Composing music..." });

	const result = await requestBinary("/v1/music", {
		apiKey,
		query: { output_format: outputFormat },
		json: body,
		timeoutMs
	});

	const filename = await writeAudioFile(result, "eleven-music", outputFormat);
	return {
		files: [ filename ],
		data: {
			tool: "music",
			model_id: body.model_id,
			output_format: outputFormat,
			...responseMetadata(result)
		}
	};
}

// Transcribe an input audio file and return the transcript JSON as job data.
async function toolSpeechToText(job, params, apiKey) {
	const inputFile = resolveInputFile(job, params);
	const timeoutMs = parseInteger(params.timeout_ms, DEFAULT_TIMEOUT_MS);
	const seed = parseOptionalInteger(params.seed);
	const numSpeakers = parseOptionalInteger(params.num_speakers);
	const keyterms = parseList(params.keyterms);
	const form = new FormData();

	await appendFormFile(form, "file", inputFile);
	appendFormValue(form, "model_id", params.model_id || "scribe_v2");
	appendFormValue(form, "language_code", params.language_code);
	appendFormValue(form, "tag_audio_events", parseBoolean(params.tag_audio_events, true));
	appendFormValue(form, "timestamps_granularity", params.timestamps_granularity || "word");
	appendFormValue(form, "diarize", parseBoolean(params.diarize, false));
	appendFormValue(form, "file_format", params.file_format || "other");
	appendFormValue(form, "temperature", parseNumber(params.temperature, undefined));
	appendFormValue(form, "use_multi_channel", parseBoolean(params.use_multi_channel, false));
	appendFormValue(form, "no_verbatim", parseBoolean(params.no_verbatim, false));
	if (Number.isFinite(seed)) appendFormValue(form, "seed", seed);
	if (Number.isFinite(numSpeakers)) appendFormValue(form, "num_speakers", numSpeakers);
	for (const term of keyterms) form.append("keyterms", term);

	const args = cloneJsonObject(params.args);
	for (const [key, value] of Object.entries(args)) {
		if (Array.isArray(value)) for (const item of value) appendFormValue(form, key, item);
		else appendFormValue(form, key, value);
	}

	writeJson({ xy: 1, progress: 0.1, status: "Transcribing speech..." });

	const data = await requestJson("/v1/speech-to-text", {
		apiKey,
		form,
		query: {
			enable_logging: params.enable_logging === undefined ? undefined : parseBoolean(params.enable_logging, true)
		},
		timeoutMs
	});

	return {
		files: [],
		data: {
			tool: "speech_to_text",
			input_file: inputFile,
			...data
		}
	};
}

// Main plugin dispatcher: read the job, route to the selected tool, and finish XYWP.
async function main() {
	const job = await readJob();
	const params = job.params || {};
	const tool = String(params.tool || "text_to_speech").trim();
	const apiKey = resolveApiKey(params);

	if (!apiKey) {
		fail("env", "Missing ElevenLabs API key. Set ELEVENLABS_API_KEY in a Secret Vault assigned to this Plugin.");
	}

	console.log(`Starting xyplug-eleven tool: ${tool}`);

	const handlers = {
		text_to_speech: toolTextToSpeech,
		sound_effects: toolSoundEffects,
		voice_isolator: toolVoiceIsolator,
		voice_changer: toolVoiceChanger,
		music: toolMusic,
		speech_to_text: toolSpeechToText
	};

	const handler = handlers[tool];
	if (!handler) {
		const supported = Object.keys(handlers).join(", ");
		fail("params", `Unsupported tool '${tool}'. Supported tools: ${supported}.`);
	}

	const started = Date.now();
	const result = await handler(job, params, apiKey);
	const elapsed = (Date.now() - started) / 1000;

	console.log("Complete.");
	writeJson({
		xy: 1,
		code: 0,
		progress: 1,
		perf: { total: elapsed, elevenlabs: elapsed },
		data: result.data || {},
		files: result.files || []
	}, true);
}

main().catch((err) => {
	if (didExit || err?.xyExit) return;
	writeJson({ xy: 1, code: "exception", description: err?.message || String(err) }, true);
});
