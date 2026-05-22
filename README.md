# Beat Counter

A tiny **mobile web app / PWA** that shows BPM for whatever you're hearing —
designed for use while standing in a DJ crowd. Open the URL on your phone,
hit **Start**, and watch the number.

- 🎤 **Mic mode** — listens to the kick drum and estimates BPM automatically.
- 👆 **Tap mode** — tap to the beat as a reliable fallback (mic detection is
  hit-or-miss in a real, loud crowd).
- 📱 **Installable** — "Add to Home Screen" on iPhone / Android for a
  full-screen, app-like launcher icon. Works offline once installed.
- 💸 **Free** — no Apple Developer account, no signing, no 7-day expiry.

## Run locally

Mic access requires either `localhost` or HTTPS, so a static file server
on `localhost` is enough for desktop testing. Any static server works —
this one uses Node:

```sh
cd beatcounter
npx serve .            # or: npx http-server .
```

## How mic detection works

1. `getUserMedia` captures the mic into a `BiquadFilter` set to low-pass
   at ~150 Hz, isolating kick-drum energy from the rest of the mix.
2. A fast RMS loop compares instantaneous energy to a 1-second moving
   baseline. When energy exceeds `baseline × 1.4` and at least 250 ms have
   passed since the last beat, it counts as a beat.
3. BPM = `60000 / median(last 8 inter-beat intervals)`. The median rejects
   outliers from missed/spurious beats. Final value is lightly smoothed.

### Caveats

- Phone mics clip on club sub-bass. If the number looks wrong, switch to
  **Tap mode** — it's the reliable fallback.
- BPM is clamped to a 60–200 range.
