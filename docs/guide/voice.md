# Talk to the agent: dictate, converse and listen

English | [简体中文](voice.zh-CN.md)

[Documentation](../README.md) · [Generic credentials](credentials.md) · [Use TypeSafe Jev for side model calls](typesafe-jev.md) · [Network deployment](deployment.md) · [API and schemas](../reference/api.md)

The Web conversation can take what you say and read what the agent answers. It has three functions, all built in and used through one **voice account**:

- **Dictate.** The microphone button turns a spoken message into text in the message box.
- **Voice conversation.** The wave button runs a hands-free loop: you speak, the message is sent, the reply is read to you, and it listens again.
- **Read aloud.** A button under each final reply reads it, and an optional setting reads every reply by itself.

A voice account is an entry under Side models that uses the **Voice** adapter. It sends recordings to a speech-to-text model and reply text to a text-to-speech model at the provider you choose. Nothing is installed, and the conversation model is never involved.

## Add a voice account

In Settings → Models & accounts, expand **Advanced: side models and task models**, choose **Add side model**, and set the adapter to **Voice**. Pick a service; it fills in the endpoint and both models, so the form asks only for a credential:

| Service | Endpoint | Transcription model | Speech model | Default voice |
| --- | --- | --- | --- | --- |
| SiliconFlow (default) | `https://api.siliconflow.cn/v1` | `FunAudioLLM/SenseVoiceSmall` | `FunAudioLLM/CosyVoice2-0.5B` | `anna` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini-transcribe` | `gpt-4o-mini-tts` | `alloy` |
| StepFun | `https://api.stepfun.com/v1` | `stepaudio-3-asr-max` | `stepaudio-3-tts` | `cixingnansheng` |

- The endpoint is editable, and so are both model IDs. Any endpoint that speaks the OpenAI audio API works. The endpoint rules are those of the other side models: an absolute HTTPS URL, with plain `http` only on loopback addresses, and no credentials, templates, query or fragment.
- To use the StepFun international site, change the endpoint to `https://api.stepfun.ai/v1`. StepFun transcribes through its own request format rather than the OpenAI one; the adapter switches by model name, so there is nothing to configure.
- Leave one model field empty to turn that function off. The account needs at least one, and the two must differ.
- Pick a [generic credential](credentials.md), or create one in place. The entry stores a reference to it. The key stays in the credential store, is used only by the local backend, and is never sent to the browser.
- **Test connection** sends one `GET <endpoint>/models`. It confirms that the endpoint answers and that the key is accepted, without running a model or costing anything. A success or a rate limit counts as reachable, and a rejected key is called out. Testing is optional.
- The optional input price is in USD per 1M units, where a unit is a text byte for speech and an audio second for transcription. See [Cost and limits](#cost-and-limits).

An account added while a conversation is open is picked up by that conversation; there is no need to reload.

### Several voice accounts

With exactly one enabled voice account, it is used automatically. With more than one, open Settings → Voice and choose one under **Voice account**. The list shows the names of the voice accounts in the side models page. Until you choose, the buttons stay greyed out with the reason "There are several voice accounts; choose one in settings". A disabled account does not count.

## Settings

Settings → Voice (in the General group) holds these settings. A change saves itself and takes effect immediately, in open conversations too.

| Group | Setting | Default | Notes |
| --- | --- | --- | --- |
| General | Voice account | Automatic (the only voice account) | A dropdown of the voice accounts |
| Voice input | Turn on voice input | On | Off hides the microphone and the wave button |
| | Recognition language | Empty | Empty lets the provider decide; use a code such as `zh`, `en` or `zh-CN` |
| | Send when done speaking | Off | Off puts the recognized text in the message box first, so you can check it before it goes to the agent |
| | Longest recording (seconds) | 120 | A whole number from 5 to 120 |
| Read aloud | Turn on read aloud | On | Off hides the read buttons and the wave button |
| | Voice | Empty | Empty uses the provider's default voice (see the table above) |
| | Speed | 1 | From 0.25 to 4; 1 is normal speed |
| | Read replies aloud automatically | Off | Replies are often long, so reading every one is noisy and costs money |
| Voice conversation | Pause that counts as finished (seconds) | 1.2 | From 0.5 to 5 |

The section also repeats the privacy note and has a **Go to setup** button that opens the side models page. If both voice input and read aloud are off, the conversation shows no voice buttons at all.

On SiliconFlow, a voice is named `<speech model>:<name>`; typing only the name, such as `anna`, is enough. StepFun accepts speeds from 0.5 to 2, and a value outside that range is sent as the nearest limit. A speed of exactly 1 is not sent at all, so the plain request works with every provider.

## Dictate

Two buttons sit beside the send button. They are also on the blank new-chat page: the first recording opens the session for you, as attaching a file does.

1. Click the microphone. The button shows the elapsed seconds and the volume. The browser asks for microphone access the first time.
2. Click it again to stop, or let it stop on its own when the longest recording is reached. Press Esc to cancel; Esc then does not also close the side panel.
3. The button spins while the recording is transcribed. The text is inserted at the cursor in the message box. With **Send when done speaking** on, it is sent instead.

If nothing was recognized, the message "Didn't catch that, please say it again" appears. Starting a recording stops any reading in progress.

## Voice conversation

Click the wave button. The button shows it is active and a status word beside it follows the loop:

1. **Listening.** Recording starts by itself and the wave follows your volume. When you start speaking and then pause for the configured time (1.2 seconds by default), the utterance is finished.
2. **Transcribing.** The text is sent at once, whatever **Send when done speaking** says. If nothing was recognized, it goes back to listening.
3. **Thinking.** It waits for the turn to end. If the agent asks for an approval or asks you a question, answer it on screen as usual; the wait continues afterwards.
4. **Reading.** It reads the turn's final reply, whatever **Read replies aloud automatically** says. It does not record while reading, so it cannot hear itself.
5. It returns to **Listening** for your next sentence.

This is half duplex: it listens or it talks, never both.

- **Interrupt.** While it is reading, click the microphone: the reading stops and it listens at once.
- **Exit.** Click the wave button again, press Esc, switch to another session, or stay silent for 30 seconds while it listens.
- A turn that fails, is cancelled or ends without a final reply shows a short message and returns to listening.
- Only one browser tab can be in a voice conversation. In the others the wave button is greyed out.

## Listen to replies

When the account has a speech model, each turn's **final reply** gets a **Read** button, which becomes **Stop** while it plays. Intermediate messages and a reply that is still being written have no button. Without a speech model the button is not shown at all.

With **Read replies aloud automatically** on, the final reply of the session you are viewing is read when each turn ends. Opening a past session, reconnecting and switching sessions never trigger it. With several tabs open, only one reads. If the browser blocks automatic playback, the button reads "Click to play"; one click starts it.

Code blocks, tables, rules, link addresses and Markdown marks are left out of what is read. The text is cut into segments at sentence ends (and, for a long sentence, at commas), and each segment is synthesized as it is needed.

## Privacy

Recordings and reply text are sent to the provider of the account you chose, through your local backend: the browser never talks to the provider and never holds the key. A reply is sent in segments, a recording in pieces of up to 20 seconds. Recordings are not kept in the local request trace, which replaces the audio of a call with a placeholder. Whatever the provider keeps is governed by your agreement with it, so keep the usual care with personal data and secrets in what you say and in the replies you have read.

## Cost and limits

- **Microphone.** Browsers allow the microphone only on `localhost` or on an https page. The Web service listens only on the local machine, so opening it locally or through an SSH port forward works. If you put your own plain-`http` reverse proxy in front of it on another address, the browser blocks the microphone; reading aloud is not affected.
- **Recordings.** At most 120 seconds by default (adjustable from 5 to 120). The Web page sends them in pieces of at most 20 seconds and joins the texts.
- **Speech segments.** At most 120 characters each, counted in UTF-16 code units, so an emoji counts as 2.
- **Rate.** Per session, one transcription and two speech calls run at a time, and at most 30 calls are admitted per minute. A call over the limit is refused and not queued; the Web page retries briefly when a call was still finishing.
- **Time.** One call has a deadline of 30 seconds.
- **Cost.** Every call that reaches the provider writes one `side-call` cost row to the session ledger, labelled `voice.transcribe` or `voice.speak`. Transcription is counted in audio seconds (rounded up) and speech in UTF-8 bytes of the text. These are the units of the optional input price. The per-request budget applies. If the session has a tree budget and a turn, the call is reserved against that budget; on a new chat with no turn yet it is not part of any tree budget.

## Troubleshooting

A greyed-out button explains itself: hover it or click it for the reason. For the first four reasons the popover also has a **Configure** link to the side models page.

| Reason shown | What it means and what to do |
| --- | --- |
| No voice account yet | Add a voice account as above. |
| The voice account has no key | The credential is missing or was deleted; choose one on the account. |
| There are several voice accounts; choose one in settings | Choose one in Settings → Voice → Voice account. |
| The voice account has no recognition (reading) model | The account has no model for this button. The microphone needs a transcription model, reading needs a speech model, and the wave button needs both. Fill in the empty field. |
| The microphone works only on localhost or https pages | See the limits above. |
| Another tab is in a voice conversation | Leave the conversation there first. |
| Voice is unavailable right now; check the connection | The status check could not reach the backend. Check the connection, and reload the page if it persists. |

Other cases:

- **No voice buttons.** Voice input or read aloud is off in Settings → Voice, or the backend is older than the voice feature. The wave button needs both functions on; the microphone needs voice input; the read buttons need read aloud.
- **"Microphone access was denied".** Allow the microphone for this page in the browser's site settings.
- **A reply is not read aloud automatically.** Automatic reading needs the setting on, a working speech model, and a turn that finishes while you are looking at that session. It does not read while a voice conversation runs in another tab or while you are recording.
- **"Click to play".** The browser blocked playback that did not start from a click. Click the button.
- **"Voice failed, please try again".** The provider refused or failed the call. Test the connection on the account, check the key and the model IDs, and try again.
