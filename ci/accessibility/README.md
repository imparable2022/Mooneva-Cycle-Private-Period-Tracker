# Accessibility baseline

This first change deliberately leaves the application UI and behavior untouched. It builds the original source and collects evidence rather than claiming conformance.

- Android: API 34, pinned Google TalkBack source with Aloud's emulator companion; first screen traversal and raw speech-request evidence. Not an audio recording, stock vendor build, or a human test.
- Web: Chromium, Playwright, axe-core, ARIA snapshots, synthetic fresh profile. The walkthrough uses the actual interface; it does not claim to be a TalkBack or NVDA test. Axe findings are advisory in this baseline; a navigation failure fails the job.
- APK: original debug build with the project's existing .debug application ID suffix. The job records its commit and SHA-256. No release signing and no personal data.

Run the workflow in a draft PR against this fork's main, or manually when available. Keep artifacts from the baseline before modifying the UI. An incomplete TalkBack traversal (including WebView limitations) is a failure to obtain evidence, not a pass.

Follow-up: extend real TalkBack interactions to the complete onboarding, calendar, period editing, daily log, pill, trends, settings, reminders, Lab and data management. Check announcements, activation, selection state, focus restoration and saved results; compare English and Spanish. Add regression assertions only after reviewing baseline evidence. Verify the final APK on physical Android and browser with NVDA before submitting upstream.

References:
- https://github.com/IRS-Public/aloud/tree/eec28b88a7e59a0c2a3f4060e261945465f1ca88
- https://github.com/KarpelesLab/stipple/blob/master/.github/a11y/android/test-talkback.sh
