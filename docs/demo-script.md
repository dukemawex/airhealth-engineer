# AirHealth Engineer: 3-minute demo script

**Every feature shown in this demo was built during the hackathon.** The first commit was on 2026-11-03 at 04:12 (+01:00, Africa/Lagos). The commit for each feature is listed under [Built during the hackathon](../README.md#built-during-the-hackathon) in the README.

**Pitch in one line:** an agent that engineers your indoor air, not medical advice. It senses, plans, asks you, then controls a physical system: purifier, windows and HVAC.

**Setup before recording**
- Open https://airhealth-engineer.vercel.app in Chrome in the dark theme, signed in with the access token.
- Click **Judge mode** once to check that the capability badges show live (Muse Spark, SAM 3.1, Muse Voice Transcribe, Muse Image).
- Have a purifier plugged into a smart plug (Shelly or a Home Assistant switch: **Devices → Smart plug**, then **Check connection**), or connected through Home Assistant, the webhook or a BLE bridge. Otherwise leave it in **Sandbox** (the panel shows *No plug connected*) and say so on camera.
- Have WhatsApp installed on the phone you'll share from.
- Keep a phone photo of a hazy window or room ready. Take it live if the air is hazy.
- Start from an empty briefing (**New briefing**). Nothing is seeded.

---

## 0:00–0:20 · The frame

**Show:** the studio home: the "Engineer your indoor air" hero, the fanned model cards and the prompt bar with its model chips.

**Say:** "This is AirHealth Engineer. It isn't a chatbot about air. It's an agent that closes the loop on a physical system: it senses the air, plans device actions, asks me, then drives my purifier, windows and HVAC. It only uses Meta models, and it works anywhere in the world. Everything you'll see was built during this hackathon."

## 0:20–0:45 · Voice → Muse Voice Transcribe

**Do:** tap the **Voice** chip (it shows *Muse*) and say: *"I'm in Ikeja with asthma."*

**Show:** the words appear in the prompt bar, transcribed by **Muse Voice Transcribe**.

**Say:** "Push-to-talk goes to Muse Voice Transcribe. If it's unavailable, the chip falls back to the browser's speech recognition. Asthma becomes my **sensitivity profile**. It only tightens device thresholds. It's not a diagnosis and not medical advice."

## 0:45–1:15 · Snap the haze → SAM 3.1 outlines it

**Do:** tap **Camera**. The live sheet opens on the rear camera (switch camera and torch are there if needed). Frame the hazy window, the vent and the purifier, tap the shutter, then **Use photo**. Backup if the camera is blocked or the venue Wi-Fi is slow: tap **Photo · SAM 3.1** and upload the prepared photo.

**Show:** the scene card. **SAM 3.1** masks outline the haze, the open window and the vent. Muse Spark's structured scene shows the haze level, the openings, whether a purifier is visible and the estimated floor area. The photo also lands in the gallery strip.

**Then:** flip the **Live** toggle and open the window (or move the camera). The event log shows *Scene changed → plan updated*. It only calls the model when the frame actually changes, and stops after 10 reads.

**Then (wow beat):** the **Outlines** switch turns on with Live. SAM 3.1 masks for the window, door, purifier, fan, AC, vent and person appear on the moving picture with a HUD (*SAM 3.1 · seg/s · latency · objects*) and chips like *Smoke/haze: none seen*. Light a match or incense near the window (or swing to the hazy view): *Smoke/haze: detected* turns orange and the log shows *SAM 3.1: smoke/haze appeared → updating the plan*. Say: "SAM doesn't take a live stream, so we send a small keyframe about every second and a half and track the masks on the phone in between. Every outline is a real SAM mask. If SAM is down it says so and shows labelled boxes instead."

**Say:** "That's a live frame from the room, not a stock image. Muse Spark reads it into a strict JSON scene, and SAM 3.1 outlines what matters. This isn't image analysis for its own sake. The scene feeds the device plan: the open window it found and the room size it estimated go straight into the engineering."

## 1:15–1:55 · Muse Spark reasons → plan timeline

**Show:** the reasoning timeline expanding step by step:
- resolve Ikeja and fetch live air from OpenAQ (or CAMS, labelled *Modelled*)
- apply the sensitivity profile
- design the intervention: CADR from room volume and air changes, plus the filter class
- run the **72-hour CAMS forecast plan**, Muse Spark with `json_schema`, with an hour-by-hour device timeline for the worst hours

**Show:** the indoor plan card's **Air twin**: the red dashed *as-is* line against the plan's curve, and the headline *Below 9 µg/m³ by …*. It's labelled *Model, not a measurement*.

**Say:** "Every tool call is visible. In Judge mode you can see which Meta model handled each step and whether anything fell back. The 72-hour plan says: close the window it saw, run the purifier on high through tonight's peak, then switch to ventilation when the forecast clears."

## 1:55–2:25 · Approve → purifier on

**Do:** click **Approve** on the first step, *purifier on, high*. Reject or skip one later step to show that the gates are per step.

**Show:** the approval dialog, then the device state changing to on. With a smart plug, the result reads *Purifier … switched on* from `smartplug:shelly_cloud` (or the plug you use) and the purifier physically powers up. Without one, show the sandbox state and the device log.

**Say:** "Nothing moves without my approval. Each step has its own gate, and approvals expire. The plug only switches power, so fan speed and mode stay with the purifier, and if the plug can't be reached it says so instead of pretending. Now it's on: an agent built on Meta models controlling a real device in my home."

## 2:25–2:50 · Alert card

**Do:** tap **Air card · Muse Image**.

**Show:** the "air today" card for Ikeja with Muse Image background art, the reading and the action taken. It also appears in the gallery. Then show **WhatsApp** (a prefilled message with the card image through the share sheet on phones; a `wa.me` link elsewhere), **Share** and **Download**. You pick the chat; the app never posts anything by itself.

**Say:** "Muse Image makes a card I can send to the family WhatsApp group in one tap. It only goes out through the share sheet or a download. Meanwhile monitoring keeps running, and Muse Spark only interrupts me when a change is worth it."

## 2:50–3:00 · Close

**Show:** Judge mode with its capability rows (live or fallback for each endpoint), then back to the studio.

**Say:** "Muse Spark, SAM 3.1, Muse Voice Transcribe and Muse Image, each with a capability check and an honest fallback, and approval gates on every device action. It engineers your indoor air. It's not medical advice. And everything you just saw was built during this hackathon."

---

**Disclaimers to keep on screen or in the voice-over:** environment and device control only, not medical advice. Seek urgent care for severe symptoms.
