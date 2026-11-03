# AirHealth Engineer: 3-minute demo script

**Every feature shown in this demo was built during the hackathon.** The first commit was on 2026-11-03 at 04:12 (+01:00, Africa/Lagos). The commit for each feature is listed under [Built during the hackathon](../README.md#built-during-the-hackathon) in the README.

**Pitch in one line:** an agent that engineers the air in your bedroom, built on Meta's models (Muse Spark 1.3, SAM 3.1, Muse Voice Transcribe, Muse Image). It senses, plans, asks you, then controls the devices. It is not medical advice.

This script matches the recorded demo (about 2:58). On-screen wording uses a **respiratory sensitivity profile**; the demo does not name a condition.

**Setup before recording**
- Open https://airhealth-engineer.vercel.app in Chrome in the dark theme, signed in with the access token.
- Click **Judge mode** once to check that the capability badges show live (Muse Spark, SAM 3.1, Muse Voice Transcribe, Muse Image).
- Device actions run in **Sandbox** unless a smart plug is connected (**Devices → Smart plug**, then **Check connection**). If it's the sandbox, say so on camera.
- Keep a hazy window or room in view, or use a prepared photo. If you use a generated test scene or a simulated camera or mic, caption it on screen.
- Start from an empty briefing (**New briefing**). Nothing is seeded.
- Time-lapse any wait and label it (*Sped up 8x*). Never cut away from a result to fake speed.

---

## 0:00–0:12 · Hook

**Show:** title card: AirHealth Engineer, an agent that engineers the air in your bedroom.

**Say:** "In Lagos, smoky nights and generator fumes push fine particles far above healthy levels, and the bedroom is where we spend the most hours. AirHealth Engineer is an agent that engineers the air in that room, built on Meta's models."

## 0:12–0:31 · Voice → Muse Voice Transcribe

**Do:** tap the **Voice** chip (it shows *Muse*) and say: *"I live in Ikeja, in Lagos. I'm sensitive to smoke and dust."* Then type: *"Use a respiratory sensitivity profile. Plan my 12 m² bedroom for tonight."* and send.

**Show:** the words appear in the prompt bar, transcribed by **Muse Voice Transcribe**.

**Say:** "I just speak. Muse Voice Transcribe turns my words into text. I add the room, and Muse Spark 1.3 takes over."

## 0:31–1:05 · Location card, sensitivity profile, 72-hour plan and air twin

**Show:** the agent run (time-lapsed and labelled), then the tabs in turn:
- **Location card:** the nearest OpenAQ station for Ikeja (labelled *Measured*, or *Modelled* when it falls back to CAMS)
- **Sensitivity profile:** the respiratory sensitivity profile, which only tightens device targets
- **72-h plan:** Muse Spark with `json_schema` sets the exposure steps and finds the **best window** (for example *tomorrow 14:00–15:00*)
- **Air twin:** the red dashed *as-is* line against the plan's curve, labelled *Model, not a measurement*

**Say:**
- "Muse Spark pulls the nearest OpenAQ station for Ikeja: moderate right now, with a smoky peak forecast tonight."
- "It builds a respiratory sensitivity profile, which only tightens device targets. It's not medical advice."
- "A seventy-two hour forecast plan sets exposure steps, and finds the best window: tomorrow afternoon."
- "Then the intervention plan sizes a HEPA purifier for my twelve square metre bedroom, and the air twin simulates when the room drops below target."

## 1:05–1:20 · Approval gate → sandbox action

**Do:** open the first device step and click **Approve**.

**Show:** the approval card, then the result. In the sandbox it reads as a sandbox action, and no real device changes.

**Say:** "Nothing touches a device without my approval. I review the action and approve it. Here it runs in sandbox mode, so no real device changes."

## 1:20–1:49 · Camera photo → Muse Spark scene + SAM 3.1 outlines, then a rejected step

**Do:** tap **Camera**, frame the window, tap the shutter, then **Use photo**. When the plan tightens, open the next device step, click **Reject** and add a reason.

**Show:** the scene card: **SAM 3.1** outlines the window with smoke outside, and Muse Spark's structured scene shows the haze level. Then the reject dialog with the note.

**Say:** "Now I snap the room. Muse Spark reads the scene, and SAM 3.1 outlines the window with smoke outside. The plan tightens, and I can still reject a step, with a reason the agent respects."

## 1:49–2:33 · Live SAM outlines, HUD and scene change (wow beat)

**Do:** in the camera sheet, turn on **Outlines**, then **Live**. Move the mouse away so no tooltip covers the picture. Wait for the baseline (time-lapse it), then open the window or let smoke drift into view.

**Show:** SAM 3.1 masks for the window, door, purifier, fan, AC, vent and person on the moving picture, with the HUD (*SAM 3.1 · seg/s · latency · objects*, keyframes and running cost). *Smoke/haze: detected* turns orange, and the log shows *SAM 3.1: smoke/haze appeared → updating the plan*, then *Scene changed → plan updated*.

**Say:**
- "With Live on, SAM 3.1 outlines the room in real time. The HUD shows segmentation speed, what's in view, and the running cost."
- "When the window opens and smoke drifts in, SAM sees the change, and the plan updates by itself. The new device actions still wait for my approval."

SAM doesn't take a live stream: the app sends a small keyframe about every second and a half and tracks the masks in between. It only calls the model when the frame changes, and stops after 10 reads.

## 2:33–2:43 · Muse Image air card → WhatsApp

**Do:** tap **Air card · Muse Image** (time-lapse the wait), then hover or tap **WhatsApp**.

**Show:** the "air today" card for Ikeja with Muse Image background art and the live reading. WhatsApp opens a prefilled share (the share sheet on phones, a `wa.me` link elsewhere). Nothing is sent until you pick a chat.

**Say:** "Muse Image paints a shareable air card from my live reading. I can send it on WhatsApp, but nothing goes until I pick a chat."

## 2:43–2:49 · Judge mode

**Show:** Judge mode with its capability rows (live or fallback for each endpoint) and the timeline.

**Say:** "And Judge mode shows it's all live: which Meta models and endpoints are running."

## 2:49–2:58 · Close

**Show:** closing slide: the four Meta models, the repo, and *Device actions always wait for approval · sandbox shown in this demo · Not medical advice*.

**Say:** "AirHealth Engineer. Muse Spark, SAM 3.1, Muse Voice Transcribe, and Muse Image, working together for cleaner indoor air."

---

**Disclaimers to keep on screen or in the voice-over:** environment and device control only, not medical advice. Device actions always wait for approval.
