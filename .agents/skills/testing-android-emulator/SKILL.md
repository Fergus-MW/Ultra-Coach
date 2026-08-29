---
name: testing-android-emulator
description: How to build, install and runtime-test the Ultra Coach Expo SDK 57 / RN 0.86 app on a local Android emulator (dev client, simulated HR/GPS, ElevenLabs voice cache, emulator audio capture and mic injection).
---

# Runtime testing Ultra Coach on an Android emulator

Expo Go cannot load this app (react-native-ble-plx + LiveKit are native). You need a
development build.

## Toolchain
- Node 22 (`nvm use 22`); Node 20.18 in the base image is too old for Expo tooling.
- Android SDK at `~/Android/sdk` (`cmdline-tools;latest`, `platform-tools`,
  `platforms;android-36`, `build-tools;36.0.0`, `emulator`,
  `system-images;android-35;google_apis;x86_64`). Export `ANDROID_HOME`/`ANDROID_SDK_ROOT`.
- AVD: `avdmanager create avd -n uc -k "system-images;android-35;google_apis;x86_64" -d pixel_6`.
- KVM: `sudo gpasswd -a ubuntu kvm && sudo chmod 666 /dev/kvm`, then launch the emulator
  through `sg kvm -c "$ANDROID_HOME/emulator/emulator -avd uc -no-boot-anim -gpu swiftshader_indirect"`
  (group membership is not picked up in the current shell otherwise). Re-apply the chmod
  after any VM reboot.

## Known build blockers and workarounds
- **Maven Central HTTP 429** from this egress IP breaks Gradle plugin/dependency
  resolution (`org.gradle.toolchains.foojay-resolver-convention ... was not found`).
  Workaround that worked: a `~/.gradle/init.gradle` that rewrites Maven Central URLs to
  `https://maven-central.storage-download.googleapis.com/maven2` and adds that mirror to
  settings/project/buildscript repositories. Do NOT add `gradlePluginPortal()` to ordinary
  project repositories — it redirects artifacts back to Maven Central and reintroduces 429s.
- **`error: no member named 'executeSync' in 'worklets::WorkletRuntime'`** during C++
  compilation: the installed `react-native-worklets` exposes `runSync`. Patching
  `node_modules/expo-modules-core/android/src/main/cpp/worklets/WorkletJSCallInvoker.cpp`
  to call `runSync` (returning `jsi::Value::undefined()`) unblocked the build. This is a
  node_modules-local workaround, not an app change — it disappears on reinstall.

## Build / install / run
```
npx expo prebuild --platform android
cd android && ./gradlew app:assembleDebug -x lint -x test -PreactNativeArchitectures=x86_64
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
npx expo start --dev-client --port 8081
adb shell am start -a android.intent.action.VIEW \
  -d "ultracoach://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
```
The APK is a dev client, so after JS-only changes you only restart Metro — no rebuild.
If the app shows a white screen after a cold launch, force-stop and re-open with the deep
link above.

## Driving the UI
- Resize the emulator window with `wmctrl -i -r <win> -e 0,300,0,340,750` (the window keeps
  the phone aspect ratio; asking for a wide geometry shrinks it).
- Text entry into RN `TextInput` is unreliable via synthetic keystrokes (a floating keyboard
  toolbar covers the field). Tap the field, then use adb:
  `adb shell input keyevent KEYCODE_MOVE_END; repeat keyevent 67; adb shell input text "2027-03-10"; adb shell input keyevent 111`.
- Scrolling is jumpy; take a zoom screenshot after each scroll rather than assuming position.

## Testing the coaching loop without hardware
- Today tab → READINESS → "Simulated sensors" toggle drives both HR and GPS.
- Defaults maxHr 190 / restingHr 50 → Zone 2 = 134–147 bpm; simulator idles ~141 bpm.
  "Push harder"/"Ease off" shift the bias by ±8 **bpm**; two pushes (+16) reliably holds
  Zone 3 and fires `zone_high` after ~20 s sustained (`minGapMs` is 15 s).
  `zone_low` needs 90 s sustained *and* gradient < 8 %, so it is slow to demonstrate.
- Fuel/drink reminders are 30/20 min — not reachable in a short test run.
- With simulators OFF the dev build has the BLE native module, so the run screen shows
  "No heart rate device found." (not "Bluetooth needs a development build") plus an
  `hr_lost` cue; Android also prompts for location and nearby-devices permissions.
- With no ElevenLabs key, cues fall back to expo-speech; confirm via
  `adb logcat | grep TextToSpeech` ("Connected to TTS engine").

## Proving *which* voice engine actually played (emulator audio capture)
The emulator can be pointed at a user PulseAudio daemon so guest playback can be recorded and
guest microphone input injected. This is the only objective way to distinguish cached
ElevenLabs MP3 playback from device TTS.

```
sudo apt-get install -y pulseaudio pulseaudio-utils alsa-utils ffmpeg
sudo mkdir -p /run/user/1000 && sudo chown ubuntu:ubuntu /run/user/1000 && sudo chmod 700 /run/user/1000
export XDG_RUNTIME_DIR=/run/user/1000
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=emuout
pactl load-module module-pipe-source source_name=micin file=/tmp/micpipe format=s16le rate=16000 channels=1
pactl set-default-sink emuout; pactl set-default-source micin
# emulator MUST inherit the same XDG_RUNTIME_DIR, otherwise it logs
# "pa_context_connect() failed / Connection refused" and silently runs with no audio:
setsid sg kvm -c "XDG_RUNTIME_DIR=/run/user/1000 $ANDROID_HOME/emulator/emulator -avd uc -audio pa -gpu swiftshader_indirect -no-boot-anim" &
```
Record guest playback with `setsid parec -d emuout.monitor --file-format=wav /tmp/cap.wav &`
(`setsid`/`disown` matter — plain background jobs die when the tool call returns) and measure
with `ffmpeg -i cap.wav -af volumedetect -f null /dev/null` (silence reads -91 dB).

To prove a *specific cached cue* played: pull the cache
(`adb shell run-as com.fergusmw.ultracoach ls cache/cues`, then `run-as ... cat` each file),
resample both capture and MP3 to 8 kHz mono, build 10 ms amplitude envelopes and take the
sliding Pearson correlation. A real cached playback scores ~0.93-0.95 against the matching MP3
and ~0.3-0.6 against a device-TTS baseline recording of the same run. Always capture a no-key
TTS baseline first as the control, and cross-check `adb logcat | grep "Synthesis request"`
(GoogleTTS) — zero hits during the cue window means ElevenLabs audio, not TTS.

Map a cache filename back to its phrase with the djb2 hash from `src/voice/elevenlabs.ts`
(`cue-<djb2(voiceId|modelId|text) base36>.mp3`) — reimplementing it in Python is quicker than
getting `npx tsx` to run the TS (esbuild in this image fails).

## Push-to-talk (ElevenLabs agent)
Working as of `95f227e` (WebRTC config + the `@livekit/react-native` config plugin).
- An `app.json` plugin change needs a full `npx expo prebuild --platform android` and a Gradle
  rebuild. A Metro reload will not pick it up, and the old APK still crashes.
- Verify the native LiveKit wiring in the built tree, not in `MainApplication.kt`: prebuild
  registers `io.livekit.reactnative.expo.LiveKitExpoPackage` in
  `android/app/build/generated/.../ExpoModulesPackageList.kt`, and the APK ships
  `libjingle_peerconnection_so.so`. Launch logcat then prints
  `WebRTCModule: Using video encoder factory`.
- `GET https://api.elevenlabs.io/v1/convai/conversations/{id}` is the only objective proof that
  `run_context` and the periodic `contextual_update` payloads actually arrived — the UI cannot
  show it.
- Host->guest mic injection via the PulseAudio pipe source can silently deliver **silence**:
  check the outbound WebRTC stats for `audioLevel: 0` before trusting any conversation test.
  A live outbound track (`bytesSent` rising) does not mean the guest heard anything.
- The idle timer resets only on `source === 'user'` messages, with a 5-minute hard cap; a silent
  session should close on its own in ~30 s even though the agent keeps asking "are you still
  there?".

## ElevenLabs settings flow
- Settings → Voice card: tap the API key field, then `adb shell input text '<key>'` (the field is
  `secure`, so the key renders as dots and is safe to screenshot), `Save key`, `Test key` →
  alert "Key works. N voices available."
- `Pre-cache cues` renders 23 static phrases (~20 s) into `cache/cues`; `Clear cache` deletes the
  directory. The Today readiness counter refreshes on tab focus (`23/23` -> `0/23` -> `23/23`);
  cross-check on disk with `run-as` if it ever looks stale.

## Reusing a dev-client APK across checkouts / branches
The dev client is a *shell*: as long as `app.json`'s `plugins` list and native deps are
unchanged, the same APK runs JS from any checkout. For a JS-only branch (even in a different
repo clone, e.g. `running-hack` vs `ultra-coach`), skip prebuild entirely:
`adb install -r <old>/android/app/build/outputs/apk/debug/app-debug.apk`, kill any stale Metro
holding 8081 (`ss -ltnp | grep 8081`), start Metro from the new checkout, `adb reverse`, then
open the `ultracoach://expo-development-client/?url=...` deep link. `expo.extra.*` (e.g.
`apiBase`) is delivered through the Metro manifest, so it picks up the new value automatically.

## Testing the proactive coach (backend-driven incoming calls)
- Revoke the mic *before* the test so the answer-time prompt is genuinely exercised:
  `adb shell pm revoke com.fergusmw.ultracoach android.permission.RECORD_AUDIO`.
  It is reset by `pm clear` too.
- Coach tab status strings: green `Coach can reach you`, amber `Reconnecting`,
  `No coaching backend in this build` (missing `extra.apiBase`).
- Offline/registration-retry test: `adb shell pm clear <pkg>` then
  `adb shell cmd connectivity airplane-mode enable` (also `settings put global airplane_mode_on 1`).
  Metro over `adb reverse` still works in airplane mode, so the JS bundle loads while the
  remote API is unreachable — a clean way to exercise startup-registration failure. Re-enable
  with `cmd connectivity airplane-mode disable` + `svc wifi enable`.
- Proof a call really happened: `GET https://api.elevenlabs.io/v1/convai/conversations?agent_id=…`
  and `/{id}`. Check `conversation_initiation_client_data.dynamic_variables` for a non-empty
  `runner_sig`, and `metadata.termination_reason` (`Client disconnected: 1000` = clean hang up).
  **Beware:** the same agent id is shared with the deployed PWA, so conversations from other
  testers appear in the list — always match on `runner_id` before attributing one to your device.
- Emulator playback of the ElevenLabs WebRTC call may capture as silence (-91 dB on
  `emuout.monitor`) even when inbound RTP is healthy. Distinguish "no audio route" from "app
  broken" by capturing a *run cue* on the same rig in the same session (those read ~-32 dB):
  if cues are loud and the call is silent, the WebRTC audio never reaches the PulseAudio sink,
  so report agent→runner speech as unproven rather than failed, and back it with inbound
  WebRTC stats (`bytesReceived`, `audioLevel` > 0).
- A transient toast `error reading from signal stream {room: ...}` can appear right after
  hang up; it is LiveKit signal-socket teardown noise, but confirm the UI still returns to
  standby and the ElevenLabs conversation reaches `status: done`.
- Product push (`Show kit on screen`) auto-navigates to the Healf tab; because the tab gains
  focus immediately and `useFocusEffect` clears `unseen`, the numeric tab badge is in practice
  never visible — do not claim it passed.
- Wearable features need `WEARABLES_URL`/`WEARABLES_API_KEY` on the Render API service. Without
  them `/api/wearable` reports `available: false`, the "Connect my watch" card is hidden and
  "Read my watch back to me" stays disabled — anything wearable-related is untestable.

## Devin Secrets Needed
- None for simulator-mode testing. `ELEVENLABS_API_KEY` (plus an agent id) is required to
  exercise pre-rendered cue audio and the push-to-talk agent.
