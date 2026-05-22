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
# open the printed http://localhost:… URL
```

To test on your phone over your LAN, you need **HTTPS** (iOS Safari will
refuse mic access otherwise). Easiest:

- Deploy to GitHub Pages (HTTPS for free — see below), **or**
- Use [`mkcert`](https://github.com/FiloSottile/mkcert) +
  [`http-server`](https://www.npmjs.com/package/http-server):
  ```sh
  mkcert -install
  mkcert localhost 192.168.x.x
  npx http-server -S -C localhost+1.pem -K localhost+1-key.pem
  ```

## Deploy to GitHub Pages

1. `git init && git add . && git commit -m "init"`
2. Create a repo on GitHub and `git push -u origin main`
3. In repo **Settings → Pages**, set Source = `Deploy from a branch`,
   Branch = `main`, Folder = `/ (root)`.
4. Open the resulting `https://<you>.github.io/<repo>/` URL on your phone.

## Install on iPhone

1. Open the deployed URL in **Safari** (must be Safari, not Chrome).
2. Tap the **Share** button → **Add to Home Screen**.
3. Launch from the new home-screen icon — it opens full-screen, no browser
   chrome.

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
- iOS Safari doesn't support `navigator.vibrate`, so haptic feedback is
  Android-only. iOS gets a visual pulse instead.
- BPM is clamped to a sane 60–200 range.

## Files

```
index.html            Markup + meta for PWA / iOS
style.css             Dark full-screen UI, huge BPM number
app.js                Mic capture, beat detection, BPM math, controls
manifest.webmanifest  PWA manifest
service-worker.js     Offline cache for static assets
icons/                Home-screen icons (192, 512)
```
