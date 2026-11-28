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

## Baseline evidence reviewed (run 46064183349)

The initial TalkBack traversal reached both boundaries with 41 utterances. The language and week-start choices lacked spoken selection state. Native tree inspection flagged the WebView container as unlabeled; this is distinct from real TalkBack focus evidence, which exposed the WebView's children. Browser reports found viewport zoom restrictions and contrast violations in all 11 states, plus landmark findings in several. APK and audit provenance both name the PR merge commit, not the source branch head; retain the APK identity alongside reports.

First corrections: native checkbox semantics and focus indicators, pressed choices, localized date and increment/decrement names, calendar month/year and picker state, notes label, viewport zoom and onboarding contrast. Browser assertions check these changes. Extended Android journeys use a debug-only local CDP connection to prepare screens via existing UI; only Aloud captures and explicit native interaction commands count as TalkBack evidence. Every attempted screen has separate raw evidence; incomplete captures fail, and no screen is silently substituted. The first native interaction exercises changing the week start and checks actual UI state plus native state/speech evidence. Screen preparation itself is not a screen-reader test. Coverage remains incomplete: medication entry, symptom logging, data mutation, Lab, privacy mode, reminders and report export need separate end-to-end native interactions and Spanish and physical-device retests. No personal data is used.

Run 46066385398 confirmed the real weekday activation: TalkBack reported "Off, Sunday, toggle button", then "On" following activation; the native state and DOM agreed. Three later traversals returned step-timeout despite recorded focus and speech, so they remain incomplete. The next audit additionally uses Aloud's independent logging TTS engine for the extended traversals to account for speech dispatch and completion without variable audible synthesis duration (the engine emits synthetic silence, not speech audio). The original system-engine capture and weekday interaction remain as before. The preparation selector ignores decorative aria-hidden text, and APK SHA-256/commit are verified before installation. These adjustments require a new CI run; no claim that timeouts are resolved yet.


## Native functional regression extension

The default-motion and reduced-motion screen captures remain separate. Native tests now attempt opening the period editor, choosing today's date, saving, selecting a symptom, entering a synthetic note, and reopening the same date to verify the retained values. CDP reads the public UI and can recover the period fixture only after a failed native action is recorded; such recovery is not a pass. Note text is injected as synthetic hardware-keyboard input after a TalkBack activation and DOM focus verification; the soft keyboard and real device are not covered. Medication entry, on-device persistence after restart, full Spanish coverage, and human validation remain pending.
