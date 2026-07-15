# Promotional Audio Provenance

The v0.2.1 campaign uses the user-supplied `tools/promo-media/recall_promo_song.mp3` source track. During migration, the generator also accepts the ignored legacy `media/recall_promo_song.mp3` location. The source
is explicitly ignored and is not redistributed through the repository.

`tools/promo-media/scripts/generate-audio.mjs` creates `tools/promo-media/public/audio/promo-song.mp3` by stream-copying the
first 42 seconds of that source. It does not change playback speed, sample rate, volume, dynamics,
or apply fades. The derivative is also ignored.

After Remotion renders the visuals, `tools/promo-media/scripts/mux-compatible-audio.mjs` replaces Remotion's
48 kHz audio with browser-compatible AAC at the source track's original 44.1 kHz sample rate. The
compatibility encode applies no volume, normalization, tempo, fade, or other audio filter. Render
verification records the cropped MP3 packet SHA-256 and requires final integrated loudness to remain
within 0.6 LU of that source to account for the browser-compatible lossy encode.

Source SHA-256: `e031000f5902f502846832742cbf584cda57febef66450a3189eb5d4dc35cc5a`.

The repository does not assert ownership or redistribution rights for the supplied track. Confirm
publication rights before distributing the rendered videos.
