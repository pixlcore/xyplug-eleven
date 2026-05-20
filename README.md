<p align="center"><img src="https://raw.githubusercontent.com/pixlcore/xyplug-eleven/refs/heads/main/logo.png" height="160" alt="ElevenLabs"/></p>
<h1 align="center">ElevenLabs Audio</h1>

A [xyOps](https://xyops.io) Marketplace Event Plugin for the [ElevenLabs](https://elevenlabs.io) API. It can generate speech, sound effects, and music, clean noisy voice recordings, convert one voice into another, and transcribe speech into structured job data.

This Plugin talks directly to the ElevenLabs HTTP API using native Node.js `fetch`. There is no ElevenLabs SDK dependency and no runtime NPM dependencies.

## Requirements

- **Node.js v18 or newer**
	- Required for native `fetch`, `FormData`, and `Blob`.
- **npx**
	- Required to run the Plugin with the default marketplace command.

## Environment Variables

Create a [Secret Vault](https://xyops.io/docs/secrets) in xyOps and assign this Plugin to it. Add the following variable:

- `ELEVENLABS_API_KEY`

## Tools

The Plugin uses a **Tool Select** menu. Each tool exposes its own parameters in xyOps.

### Text to Speech

Generates spoken audio from text and attaches the output audio file to the job.

Common parameters:

- **Text**: Text to synthesize.
- **Voice ID**: ElevenLabs voice ID.
- **Model ID**: Default `eleven_multilingual_v2`.
- **Output Format**: Default `mp3_44100_128`.
- **Stability / Similarity Boost / Style / Speed**: Optional voice tuning controls.
- **Custom JSON**: Optional extra ElevenLabs request body fields.

### Sound Effects

Generates one or more sound effects from a prompt and attaches each result as an audio file.

Common parameters:

- **Prompt**: Description of the desired sound effect.
- **Model ID**: Default `eleven_text_to_sound_v2`.
- **Duration Seconds**: Optional output duration.
- **Prompt Influence**: Optional value from 0 to 1.
- **Loop**: Requests loopable audio when supported.
- **Count**: Number of separate sound effect requests to make.

### Voice Isolator

Accepts an input audio file from the xyOps job, removes background noise, and attaches the cleaned output.

Common parameters:

- **Input File**: Optional glob or filename. Leave blank to use the first job input file.
- **File Format**: Optional input format hint.

### Voice Changer

Accepts an input speech file and converts it into a selected ElevenLabs voice.

Common parameters:

- **Input File**: Optional glob or filename. Leave blank to use the first job input file.
- **Voice ID**: Target ElevenLabs voice ID.
- **Model ID**: Default `eleven_multilingual_sts_v2`.
- **Remove Noise**: Optionally remove background noise before conversion.
- **Voice Settings**: Optional JSON object for ElevenLabs voice tuning.

### Music

Generates music from a text prompt and attaches the output audio file to the job.

Common parameters:

- **Prompt**: Description of the music to generate.
- **Model ID**: Default `music_v1`.
- **Length (ms)**: Optional song length in milliseconds.
- **Instrumental**: Forces an instrumental output when supported.
- **Custom JSON**: Optional extra ElevenLabs request body fields.

### Speech to Text

Accepts an input audio file and returns transcript data in the xyOps job output `data` object.

Common parameters:

- **Input File**: Optional glob or filename. Leave blank to use the first job input file.
- **Model ID**: Default `scribe_v2`.
- **Language Code**: Optional ISO language code.
- **Audio Events**: Tag non-speech audio events.
- **Timestamps**: `none`, `word`, or `character`.
- **Diarize**: Attempt to identify different speakers.
- **Key Terms**: Optional terms to help recognition.

#### Speech to Text Output

Speech to Text returns the transcript in the xyOps job output `data` object, along with the selected tool name and input filename. When word timestamps are enabled, ElevenLabs includes a `words` array with timing and confidence details for each token. For the full upstream response shape, see the [ElevenLabs Speech to Text API Reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert).

Example output:

```json
{
	"xy": 1,
	"code": 0,
	"progress": 1,
	"perf": {
		"total": 0.66,
		"elevenlabs": 0.66
	},
	"data": {
		"tool": "speech_to_text",
		"input_file": "sample.mp3",
		"language_code": "eng",
		"language_probability": 0.9177960753440857,
		"text": "Hello from XY Ops",
		"words": [
			{
				"text": "Hello",
				"start": 0.099,
				"end": 0.319,
				"type": "word",
				"logprob": -0.000006556489552167477
			},
			{
				"text": " ",
				"start": 0.319,
				"end": 0.399,
				"type": "spacing",
				"logprob": -0.000004768360213347478
			},
			{
				"text": "from",
				"start": 0.399,
				"end": 0.56,
				"type": "word",
				"logprob": -0.000004768360213347478
			},
			{
				"text": " ",
				"start": 0.56,
				"end": 0.699,
				"type": "spacing",
				"logprob": -0.006209485698491335
			},
			{
				"text": "XY",
				"start": 0.699,
				"end": 1,
				"type": "word",
				"logprob": -0.006209485698491335
			},
			{
				"text": " ",
				"start": 1,
				"end": 1.039,
				"type": "spacing",
				"logprob": -0.06102418899536133
			},
			{
				"text": "Ops",
				"start": 1.039,
				"end": 1.34,
				"type": "word",
				"logprob": -0.06102418899536133
			}
		],
		"transcription_id": "cfvAOnLtDGj66SyERrIw",
		"audio_duration_secs": 1.6254375
	},
	"files": []
}
```

## Input Files

For tools that require input audio, xyOps automatically downloads job input files into the Plugin working directory before launch. The Plugin uses `job.input.files` to find the files.

If **Input File** is blank, the first job input file is used. If it contains a value, it is matched against the filename and basename. Simple `*` and `?` wildcards are supported.

Examples:

```text
*.mp3
voiceover.wav
recordings/*.m4a
```

## Output

Generated audio files are written to the current job working directory and returned to xyOps through the `files` array. These files are attached to the completed job and can be passed into downstream workflow steps.

Speech to Text returns the ElevenLabs transcript response in the job `data` object. Generated audio tools also return useful metadata such as the selected tool, model ID, voice ID, output format, content type, and request ID when available.

## Local Testing

When invoked by xyOps, the Plugin expects a single JSON payload on STDIN. You can simulate this locally.

Text to Speech example:

```sh
export ELEVENLABS_API_KEY="your-token-here"
echo '{ "params": { "tool": "text_to_speech", "text": "Hello from xyOps.", "voice_id": "JBFqnCBsd6RMkjVDRZzb" } }' | node index.js
```

Speech to Text example:

```sh
export ELEVENLABS_API_KEY="your-token-here"
echo '{ "params": { "tool": "speech_to_text", "input_file": "sample.mp3" }, "input": { "files": [ { "filename": "sample.mp3" } ] } }' | node index.js
```

## Data Collection

This Plugin does not collect, store, or transmit data anywhere except to the configured ElevenLabs API endpoint. ElevenLabs may process prompts, input audio, generated audio, transcripts, request metadata, and usage metrics according to its own terms and privacy policy.

## License

MIT
