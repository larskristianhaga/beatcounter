# Beat Counter

A tiny **mobile web app / PWA** that shows BPM for whatever you're hearing —
designed for use while standing in a DJ crowd. Open the URL on your phone,
tap anywhere to start, and watch the number.

- 🎤 **Mic mode** — listens to the kick drum and estimates BPM with an
  adaptive-threshold onset detector + PLL tempo tracker.
- 👆 **Tap mode** — tap anywhere on the screen to the beat. Reliable
  fallback for loud, bass-heavy environments where mic detection struggles.
- 🤝 **Both mode** (default) — mic runs continuously, taps anchor the
  tracker whenever you want to nudge it back on beat.
- 🔒 **Lock indicator** — a `LOCK` badge appears once the tracker has
  several consecutive tight hits and stable phase, so you can tell at a
  glance whether the number is trustworthy.
- 💡 **Beat-synced flash** — full-screen overlay pulses on each predicted
  beat (toggle in settings).
- ⚙️ **Settings drawer** — mic sensitivity, BPM range, PLL aggressiveness,
  flash on/off, tracker reset. Persisted in `localStorage`.
- 📱 **Installable PWA** — "Add to Home Screen" on iPhone / Android for a
  full-screen launcher icon. Works offline via a service worker.
- 🔆 **Screen wake lock** — keeps the display on while running and
  auto-resumes after the app returns to the foreground (handles iOS audio
  interruptions / route changes).
- 💸 **Free** — no Apple Developer account, no signing, no 7-day expiry.

## Run locally

Mic access requires either `localhost` or HTTPS, so a static file server
on `localhost` is enough for desktop testing. Any static server works:

```sh
cd beatcounter
npx serve .            # or: npx http-server .
```

Then open the printed URL. On a phone, deploy the folder to any HTTPS
static host (GitHub Pages, Netlify, Cloudflare Pages, …) and load it
there.

## How it works

### Mic onset detection

1. `getUserMedia` captures the mic with echo cancellation, noise
   suppression, and AGC all disabled.
2. A `BiquadFilter` low-pass at ~150 Hz isolates kick-drum energy from
   the rest of the mix.
3. Each animation frame computes the RMS of the filtered signal and
   appends it to a ~1.3 s rolling history.
4. An **adaptive threshold** is computed from `median + k · MAD` of that
   history (mic sensitivity scales `k`). MAD makes it robust against
   spiky noise. A 180 ms refractory period prevents double-triggers.

### PLL tempo tracker

Each candidate beat (mic or tap) is fed into a shared event bus:

1. The first two events seed an initial period.
2. For every subsequent event, the predicted nearest beat slot is
   computed and the signed timing error `e` is used to update both the
   period (`α · e`) and the phase (`β · e`). Gains scale with event
   confidence (taps = 1.0) and the user's "PLL aggressiveness" setting.
3. **Outliers** more than ~45% of a beat off are rejected (unless the
   event is a high-confidence tap).
4. **Octave correction** snaps the period to half/double when the
   current BPM falls outside the configured musical range *and* the
   majority of recent inter-event intervals agree with the alternative.
5. A **stability EMA** tracks agreement between events and prediction.
6. **Lock**: after enough consecutive tight hits with high stability,
   the display switches to a locked state and shows a `LOCK` badge.
7. The displayed BPM is `60000 / median(recent periods)`, lightly
   smoothed for a calm readout.
8. A **staleness watchdog** decays stability after ~1.5 s of silence
   and fully resets the tracker after 3 s.

### Caveats

- Phone mics clip on club sub-bass. If the number looks wrong, switch
  to **Tap mode** or use **Both** and tap a few times to anchor.
- BPM is clamped to the range configured in settings (defaults 70–180,
  internal envelope 40–240).

## Project layout

```
index.html              UI shell (HUD, BPM, settings drawer)
app.js                  Mic detector, PLL, tap input, settings, wake lock
style.css               Styling
manifest.webmanifest    PWA manifest
service-worker.js       Offline cache (network-first HTML, cache-first assets)
icons/                  192/512 PWA icons
```
